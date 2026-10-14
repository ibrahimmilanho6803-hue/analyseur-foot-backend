"use strict";

const { SwrCache } = require("./cache");
const { LEAGUES, byKey, isCup, seasonStartYear, OTHER_KEY } = require("./leagues");
const { fitLeague } = require("./model");
const { createFootballData } = require("./providers/footballdata");
const { createTheSportsDb } = require("./providers/thesportsdb");
const { coreOf, indexTeams } = require("./teams");
const { redact, withTimeout } = require("./util");

function explain(e) {
  if (!e) return "erreur inconnue";
  if (e.status === 401 || e.status === 403) return "accès refusé (clé invalide, ou championnat hors de l'offre)";
  if (e.status === 429) return "limite de requêtes atteinte";
  if (e.code === "TIMEOUT") return "délai dépassé";
  return e.message || "erreur";
}

// Service de données : va chercher les matchs, les garde en mémoire, ajuste le modèle
// de chaque championnat et sait basculer d'une source à l'autre.
function createDataService({ config, http, cache = new SwrCache(), now = Date.now, log = console, providers }) {
  const list =
    providers ||
    config.providers.order
      .map((name) => {
        if (name === "footballdata") return createFootballData({ http, key: config.providers.footballDataKey, gapMs: config.providers.footballDataGapMs });
        if (name === "thesportsdb") return createTheSportsDb({ http, key: config.providers.sportsDbKey, now, gapMs: config.providers.sportsDbGapMs });
        return null;
      })
      .filter(Boolean);
  // Championnats suivis : ceux qu'une source couvre et que les interrupteurs n'ont pas coupés (coupes d'Europe : EUROPE_ENABLED ;
  // championnats complémentaires : EXTRA_LEAGUES_ENABLED).
  const europe = config.europe || { enabled: true, extraLeagues: true };
  const allowed = (l) => (isCup(l) ? europe.enabled : l.tier === "extra" ? europe.extraLeagues : true);
  const leagues = LEAGUES.filter((l) => allowed(l) && list.some((p) => p.supports(l)));
  // Championnats présentés par /api/leagues et /api/status : ceux que les interrupteurs n'ont pas coupés (même si aucune source ne les couvre :
  // ils sont alors « non couverts »). Interrupteurs coupés : la liste d'avant les coupes d'Europe et les championnats complémentaires.
  const listed = LEAGUES.filter(allowed);
  // Lots de championnats : « core » = les 10 championnats principaux (par défaut) ; « cups » = coupes d'Europe ; « extras » =
  // championnats complémentaires ; « essential » = principaux + coupes (ce dont « Top Matchs » et les comparaisons ont besoin) ; « all ».
  const inScope = (l, scope) => {
    if (scope === "all") return true;
    if (scope === "cups") return isCup(l);
    if (scope === "extras") return l.tier === "extra";
    if (scope === "essential") return l.tier === "core";
    return l.tier === "core" && !isCup(l);
  };
  // Réglages du modèle. `rhythmExponent` et `levelFactor` corrigent les totaux de buts (voir model.js et tuning.js) ;
  // l'interrupteur MODEL_CALIBRATION=off les laisse à 1 (modèle d'avant la correction).
  const calibrated = config.model.calibration !== false;
  const modelParams = {
    halfLifeDays: config.model.halfLifeDays,
    priorMatches: config.model.priorMatches,
    rhythmExponent: calibrated ? config.model.rhythmExponent || 1 : 1,
    levelFactor: 1,
  };
  const seasonCached = (p, league, year, ttlMs) =>
    cache.get(`season:${p.name}:${league.key}:${year}`, {
      ttlMs,
      staleMs: config.cache.staleMs,
      loader: () => p.fetchSeason(league, year),
    });

  // Noms alternatifs des clubs quand la source en fournit (un appel par championnat, gardé 24 h). Cette étape ne doit
  // jamais empêcher le chargement des matchs : en cas d'erreur ou de réponse vide, on continue sans.
  // Une réponse vide est traitée comme une erreur pour ne pas être gardée 24 h ; elle est redemandée au bout d'une heure.
  async function teamAliases(p, league) {
    // Une coupe réunit des clubs de pays différents : la liste de ses clubs n'a pas de sens (et leurs noms alternatifs viennent
    // de leur championnat).
    if (isCup(league) || typeof p.fetchTeams !== "function") return new Map();
    try {
      const rows = await cache.get(`names:${p.name}:${league.key}`, {
        ttlMs: config.cache.namesTtlMs,
        staleMs: config.cache.staleMs,
        errorTtlMs: 60 * 60000,
        loader: async () => {
          const list = await p.fetchTeams(league);
          if (!Array.isArray(list) || !list.length) throw new Error("aucun nom d'équipe reçu");
          return list;
        },
      });
      return new Map(rows.filter((r) => r && r.id).map((r) => [r.id, Array.isArray(r.aliases) ? r.aliases : []]));
    } catch (e) {
      return new Map();
    }
  }

  async function loadSeasons(league) {
    const year = seasonStartYear(league, now());
    const errors = [];
    for (const p of list) {
      if (!p.supports(league)) continue;
      try {
        const cur = await seasonCached(p, league, year, config.cache.seasonTtlMs);
        if (cur.limited) {
          errors.push(`${p.label} : données incomplètes (${cur.rawCount} matchs reçus : clé gratuite ?)`);
          continue;
        }
        let prev = { matches: [] };
        try {
          prev = await seasonCached(p, league, year - 1, config.cache.previousSeasonTtlMs);
          if (prev.limited) prev = { matches: [] };
        } catch (e) {
          errors.push(`${p.label} (saison précédente) : ${explain(e)}`);
        }
        if (cur.matches.length || prev.matches.length) return { provider: p, cur, prev, errors, year };
        errors.push(`${p.label} : aucun match trouvé`);
      } catch (e) {
        errors.push(`${p.label} : ${explain(e)}`);
      }
    }
    const err = new Error(errors.join(" | ") || "aucune source de données configurée");
    err.code = "NO_DATA";
    err.details = errors;
    throw err;
  }

  async function build(league) {
    const { provider, cur, prev, errors, year } = await loadSeasons(league);
    const nowMs = now();
    const byId = new Map();
    for (const m of [...prev.matches, ...cur.matches]) byId.set(m.id, m);
    const all = [...byId.values()];
    const finished = all.filter((m) => m.status === "finished" && m.kickoff <= nowMs).sort((a, b) => a.kickoff - b.kickoff);
    const fixtures = all.filter((m) => m.status === "scheduled" && m.kickoff > nowMs - 3600000).sort((a, b) => a.kickoff - b.kickoff);
    const prevTeams = new Set();
    for (const m of prev.matches) {
      prevTeams.add(m.home.id);
      prevTeams.add(m.away.id);
    }
    const hasPrev = prev.matches.length > 0;
    // Un club absent de la saison précédente est probablement promu : a priori un peu plus faible.
    const priorFor = (id) => (hasPrev && !prevTeams.has(id) ? { a0: 0.88, d0: 1.12 } : { a0: 1, d0: 1 });
    // Une coupe n'a pas de force d'équipe « de championnat » : ses matchs servent à comparer les championnats (cross.js).
    const cup = isCup(league);
    const fit = cup
      ? null
      : fitLeague(finished, {
          now: nowMs,
          halfLifeDays: modelParams.halfLifeDays,
          priorMatches: modelParams.priorMatches,
          rhythmExponent: modelParams.rhythmExponent,
          levelFactor: modelParams.levelFactor,
          priorFor,
        });
    // lastSeen : date du dernier match (joué ou programmé) du club dans ce championnat. Un club promu ou relégué figure dans deux
    // championnats (saison précédente et saison en cours) : le plus récent est son championnat actuel.
    const teams = new Map();
    for (const m of all) {
      for (const t of [m.home, m.away]) {
        let rec = teams.get(t.id);
        if (!rec) {
          rec = { id: t.id, name: t.name, shortName: t.shortName, aliases: [], leagueKey: league.key, rated: !cup, lastSeen: 0 };
          teams.set(t.id, rec);
        }
        if (m.kickoff > rec.lastSeen) rec.lastSeen = m.kickoff;
      }
    }
    // Les noms alternatifs s'ajoutent aux équipes dès qu'ils sont reçus. On les attend très peu de temps (immédiat quand ils sont
    // déjà en mémoire) : au premier démarrage la file d'attente de la source peut les retarder, et les matchs n'ont pas à patienter.
    const addAliases = teamAliases(provider, league).then((aliases) => {
      for (const t of teams.values()) {
        const names = aliases.get(t.id);
        if (names && names.length) t.aliases = names;
      }
    });
    await withTimeout(addAliases, config.cache.namesWaitMs, "noms d'équipes en cours").catch(() => {});
    return { league, provider: provider.name, finished, fixtures, teams, fit, errors, loadedAt: nowMs, seasonYear: year, hasPrevious: hasPrev };
  }

  const getLeagueData = (key) => {
    const league = byKey.get(key);
    if (!league || !leagues.includes(league)) return Promise.reject(Object.assign(new Error("championnat non couvert"), { code: "UNSUPPORTED" }));
    return cache.get(`league:${key}`, { ttlMs: 120000, staleMs: config.cache.staleMs, loader: () => build(league) });
  };

  // Charge les championnats d'un lot (voir inScope) en parallèle ; ceux qui ne sont pas prêts à temps continuent à charger en arrière-plan.
  // Sans précision, le lot est celui des 10 championnats principaux. `keys` choisit des championnats précis, quel que soit leur lot.
  async function ensureAll({ budgetMs = 25000, keys, scope = "core" } = {}) {
    const targets = keys ? leagues.filter((l) => keys.includes(l.key)) : leagues.filter((l) => inScope(l, scope));
    const settled = await Promise.all(
      targets.map((l) =>
        withTimeout(getLeagueData(l.key), budgetMs, "chargement en cours").then(
          (data) => ({ l, data }),
          (error) => ({ l, error })
        )
      )
    );
    const ready = settled.filter((s) => s.data).map((s) => s.data);
    const pending = settled.filter((s) => s.error && s.error.code === "TIMEOUT").map((s) => s.l.key);
    const failed = settled.filter((s) => s.error && s.error.code !== "TIMEOUT").map((s) => ({ key: s.l.key, message: redact(s.error.message) }));
    return { ready, pending, failed };
  }

  // Données déjà en mémoire d'un championnat (null si pas encore chargé) : ne déclenche aucun chargement.
  function peekLeague(key) {
    const hit = cache.peek(`league:${key}`);
    return hit ? hit.value : null;
  }

  // Vrai quand aucun championnat essentiel n'est chargé et que tous ont déjà échoué (source en panne, clé refusée, données partielles…).
  // Tant qu'un seul est encore en cours de chargement ou jamais essayé, le service est simplement « en chargement ».
  // Les championnats complémentaires ne comptent pas : ils se chargent après les autres et peuvent manquer sans gravité.
  function allFailed() {
    const essential = leagues.filter((l) => l.tier === "core");
    const pool = essential.length ? essential : leagues;
    return pool.length > 0 && pool.every((l) => !cache.peek(`league:${l.key}`) && Boolean(cache.peekError(`league:${l.key}`)));
  }

  // Championnats couverts dont les données ne sont pas en mémoire : « chargement » (pas encore terminé) ou « echec » (dernier essai raté).
  function unloadedLeagues() {
    return leagues
      .filter((l) => !cache.peek(`league:${l.key}`))
      .map((l) => ({ key: l.key, nom: l.name, lot: l.tier, etat: cache.peekError(`league:${l.key}`) ? "echec" : "chargement" }));
  }

  // ---------- Annuaire des clubs ----------
  // Un club est connu par le championnat où il joue (son « championnat d'origine ») ou, à défaut, par une coupe d'Europe seulement.
  //  - Un club promu ou relégué figure dans deux championnats (saison précédente et en cours) : on retient celui de son dernier match.
  //  - Un club d'une coupe qui n'est dans aucun championnat suivi reçoit la clé « EUR » (clubs européens sans championnat suivi).
  //  - Si la coupe désigne un club connu sous un autre identifiant (même nom à quelques mots sans importance près), on le rattache au
  //    club du championnat : sinon le même club apparaîtrait deux fois et son nom deviendrait « ambigu ».
  //  - Un même club vu par deux sources de données (la Bundesliga 2 chez l'une, la Bundesliga chez l'autre) porte deux identifiants :
  //    on garde celui de son dernier match et l'autre lui est rattaché. Deux clubs de même nom chez la MÊME source restent deux clubs
  //    (une source donne le même identifiant au même club).
  //  - Un club connu de deux coupes sous deux identifiants (deux sources) n'est compté qu'une fois.
  // Le résultat est gardé en mémoire tant que les données des championnats ne changent pas.
  function computeDirectory(entries) {
    const domestic = entries.filter((e) => !isCup(e.league));
    const chosen = new Map(); // identifiant → { team, order, provider }
    domestic.forEach((e, order) => {
      for (const t of e.value.teams.values()) {
        const prev = chosen.get(t.id);
        if (!prev || t.lastSeen > prev.team.lastSeen) chosen.set(t.id, { team: t, order, provider: e.value.provider });
      }
    });
    let teams = [];
    for (const e of domestic) {
      for (const t of e.value.teams.values()) if (chosen.get(t.id).team === t) teams.push(t);
    }
    const alias = new Map(); // identifiant d'un autre numéro → identifiant du club retenu
    const byName = new Map();
    for (const t of teams) {
      const key = coreOf(t.name);
      if (key) byName.set(key, [...(byName.get(key) || []), t]);
    }
    const dropped = new Set();
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      const kept = [];
      for (const t of [...group].sort((a, b) => b.lastSeen - a.lastSeen || chosen.get(a.id).order - chosen.get(b.id).order)) {
        const twin = kept.find((k) => chosen.get(k.id).provider !== chosen.get(t.id).provider);
        if (twin) {
          alias.set(t.id, twin.id);
          dropped.add(t);
        } else {
          kept.push(t);
        }
      }
    }
    if (dropped.size) teams = teams.filter((t) => !dropped.has(t));
    const cupOnly = new Map();
    const cupNames = new Map(); // nom comparable → identifiant du club (de coupe seulement) déjà retenu
    const cups = entries.filter((e) => isCup(e.league));
    if (cups.length) {
      const index = indexTeams(teams);
      for (const e of cups) {
        for (const t of e.value.teams.values()) {
          if (chosen.has(t.id) || cupOnly.has(t.id) || alias.has(t.id)) continue;
          const same = index.lookup(t.name);
          if (same.length === 1) {
            alias.set(t.id, same[0].id);
            continue;
          }
          const key = coreOf(t.name);
          const twin = key ? cupNames.get(key) : undefined;
          if (twin) {
            alias.set(t.id, twin);
            continue;
          }
          if (key) cupNames.set(key, t.id);
          cupOnly.set(t.id, { id: t.id, name: t.name, shortName: t.shortName || "", aliases: [], leagueKey: OTHER_KEY, rated: false, lastSeen: t.lastSeen });
        }
      }
    }
    return { teams: [...teams, ...cupOnly.values()], alias, domestic: teams.length, cupOnly: cupOnly.size };
  }

  let directoryMemo = null;
  function directory() {
    const entries = [];
    for (const l of leagues) {
      const hit = cache.peek(`league:${l.key}`);
      if (hit) entries.push({ league: l, value: hit.value });
    }
    const sig = entries.map((e) => e.value);
    if (directoryMemo && directoryMemo.sig.length === sig.length && directoryMemo.sig.every((v, i) => v === sig[i])) return directoryMemo;
    directoryMemo = { sig, ...computeDirectory(entries) };
    return directoryMemo;
  }

  // Tous les clubs connus : championnats chargés (sans doublon) puis clubs vus seulement en coupe d'Europe.
  const allTeams = () => directory().teams;
  // Identifiants des coupes qui désignent un club d'un championnat sous un autre numéro : { identifiant en coupe → identifiant de référence }.
  const teamAliasMap = () => directory().alias;

  // Charge les championnats puis les rafraîchit régulièrement. Par étapes, pour que l'essentiel soit prêt au plus vite :
  //  1. les championnats principaux et les coupes d'Europe (« ready » se résout ici) ;
  //  2. les championnats complémentaires, en arrière-plan (« extras »).
  function warmUp() {
    const ready = ensureAll({ budgetMs: 15 * 60000, scope: "essential" }).then((r) => {
      log.log(`[données] ${r.ready.length} championnat(s) et coupe(s) prêts, ${r.failed.length} en échec`);
      for (const f of r.failed) log.warn(`[données] ${f.key} : ${f.message}`);
      return r;
    });
    ready.catch(() => {});
    const extras = ready
      .catch(() => null)
      .then(() => (leagues.some((l) => l.tier === "extra") ? ensureAll({ budgetMs: 30 * 60000, scope: "extras" }) : null))
      .then((r) => {
        if (r) {
          log.log(`[données] championnats complémentaires : ${r.ready.length} prêts, ${r.failed.length} en échec`);
          for (const f of r.failed) log.warn(`[données] ${f.key} : ${f.message}`);
        }
        return r;
      });
    extras.catch(() => {});
    const timer = setInterval(() => ensureAll({ budgetMs: 60000, scope: "all" }).catch(() => {}), config.cache.refreshEveryMs);
    timer.unref();
    return { ready, extras, timer };
  }

  function status() {
    return {
      sources: list.map((p) => p.label),
      championnats: listed.map((l) => {
        const supported = leagues.includes(l);
        const hit = supported ? cache.peek(`league:${l.key}`) : null;
        // Un championnat jamais chargé garde la raison de son dernier échec : sans elle, « pas chargé » ne dit pas pourquoi.
        const failure = supported && !hit ? cache.peekError(`league:${l.key}`) : null;
        return {
          key: l.key,
          nom: l.name,
          pays: l.country,
          type: isCup(l) ? "coupe" : "championnat",
          niveau: l.tier === "core" ? "principal" : "complementaire",
          couvert: supported,
          etat: !supported ? "non_couvert" : hit ? "pret" : failure ? "echec" : "chargement",
          charge: Boolean(hit),
          equipes: hit ? hit.value.teams.size : 0,
          equipesAvecNomsAlternatifs: hit ? [...hit.value.teams.values()].filter((t) => t.aliases && t.aliases.length).length : 0,
          matchsJoues: hit ? hit.value.finished.length : 0,
          matchsAVenir: hit ? hit.value.fixtures.length : 0,
          source: hit ? hit.value.provider : null,
          ageMinutes: hit ? Math.round(hit.ageMs / 60000) : null,
          alertes: hit ? hit.value.errors : [],
          derniereErreur: hit && hit.lastError ? redact(hit.lastError.message) : failure ? redact(failure.message) : null,
        };
      }),
    };
  }

  // Change les réglages du modèle (ex. après un réglage automatique) et force le recalcul des forces d'équipes.
  // Seuls les réglages fournis (et valides) changent ; sans changement réel, rien n'est recalculé. Renvoie vrai s'il y a eu un changement.
  function setModelParams(next) {
    let changed = false;
    for (const name of Object.keys(modelParams)) {
      const value = next[name];
      if (typeof value !== "number" || !Number.isFinite(value) || value === modelParams[name]) continue;
      modelParams[name] = value;
      changed = true;
    }
    if (changed) cache.invalidate("league:");
    return changed;
  }

  const getModelParams = () => ({ ...modelParams });

  return { leagues, listed, getLeagueData, peekLeague, ensureAll, allTeams, teamAliasMap, allFailed, unloadedLeagues, warmUp, status, providers: list, setModelParams, getModelParams };
}

module.exports = { createDataService, explain };
