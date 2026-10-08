"use strict";

const { SwrCache } = require("./cache");
const { LEAGUES, byKey, seasonStartYear } = require("./leagues");
const { fitLeague } = require("./model");
const { createFootballData } = require("./providers/footballdata");
const { createTheSportsDb } = require("./providers/thesportsdb");
const { withTimeout } = require("./util");

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
  const leagues = LEAGUES.filter((l) => list.some((p) => p.supports(l)));
  const modelParams = { halfLifeDays: config.model.halfLifeDays, priorMatches: config.model.priorMatches };
  const seasonCached = (p, league, year, ttlMs) =>
    cache.get(`season:${p.name}:${league.key}:${year}`, {
      ttlMs,
      staleMs: config.cache.staleMs,
      loader: () => p.fetchSeason(league, year),
    });

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
    const fit = fitLeague(finished, { now: nowMs, halfLifeDays: modelParams.halfLifeDays, priorMatches: modelParams.priorMatches, priorFor });
    const teams = new Map();
    for (const m of all) {
      for (const t of [m.home, m.away]) if (!teams.has(t.id)) teams.set(t.id, { id: t.id, name: t.name, shortName: t.shortName, leagueKey: league.key });
    }
    return { league, provider: provider.name, finished, fixtures, teams, fit, errors, loadedAt: nowMs, seasonYear: year, hasPrevious: hasPrev };
  }

  const getLeagueData = (key) => {
    const league = byKey.get(key);
    if (!league || !leagues.includes(league)) return Promise.reject(Object.assign(new Error("championnat non couvert"), { code: "UNSUPPORTED" }));
    return cache.get(`league:${key}`, { ttlMs: 120000, staleMs: config.cache.staleMs, loader: () => build(league) });
  };

  // Charge tous les championnats en parallèle ; ceux qui ne sont pas prêts à temps continuent à charger en arrière-plan.
  async function ensureAll({ budgetMs = 25000, keys } = {}) {
    const targets = keys ? leagues.filter((l) => keys.includes(l.key)) : leagues;
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
    const failed = settled.filter((s) => s.error && s.error.code !== "TIMEOUT").map((s) => ({ key: s.l.key, message: s.error.message }));
    return { ready, pending, failed };
  }

  function allTeams() {
    const out = [];
    for (const l of leagues) {
      const hit = cache.peek(`league:${l.key}`);
      if (hit) out.push(...hit.value.teams.values());
    }
    return out;
  }

  // Charge tous les championnats au démarrage puis les rafraîchit régulièrement.
  function warmUp() {
    const ready = ensureAll({ budgetMs: 15 * 60000 }).then((r) => {
      log.log(`[données] ${r.ready.length} championnat(s) prêts, ${r.failed.length} en échec`);
      for (const f of r.failed) log.warn(`[données] ${f.key} : ${f.message}`);
      return r;
    });
    ready.catch(() => {});
    const timer = setInterval(() => ensureAll({ budgetMs: 60000 }).catch(() => {}), config.cache.refreshEveryMs);
    timer.unref();
    return { ready, timer };
  }

  function status() {
    return {
      sources: list.map((p) => p.label),
      championnats: LEAGUES.map((l) => {
        const supported = leagues.includes(l);
        const hit = supported ? cache.peek(`league:${l.key}`) : null;
        return {
          key: l.key,
          nom: l.name,
          pays: l.country,
          couvert: supported,
          charge: Boolean(hit),
          matchsJoues: hit ? hit.value.finished.length : 0,
          matchsAVenir: hit ? hit.value.fixtures.length : 0,
          source: hit ? hit.value.provider : null,
          ageMinutes: hit ? Math.round(hit.ageMs / 60000) : null,
          alertes: hit ? hit.value.errors : [],
          derniereErreur: hit && hit.lastError ? hit.lastError.message : null,
        };
      }),
    };
  }

  // Change les réglages du modèle (ex. après un réglage automatique) et force le recalcul des forces d'équipes.
  function setModelParams(next) {
    modelParams.halfLifeDays = next.halfLifeDays;
    modelParams.priorMatches = next.priorMatches;
    cache.invalidate("league:");
  }

  const getModelParams = () => ({ ...modelParams });

  return { leagues, getLeagueData, ensureAll, allTeams, warmUp, status, providers: list, setModelParams, getModelParams };
}

module.exports = { createDataService, explain };
