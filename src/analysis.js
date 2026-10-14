"use strict";

const { clamp, round } = require("./util");
const { SwrCache } = require("./cache");
const { findTeam } = require("./teams");
const { expectedGoals, scoreMatrix, dataQuality } = require("./model");
const { MARKETS, resolveMarket, evaluate, describeMatrix, refundRule } = require("./markets");
const { OTHER_KEY } = require("./leagues");
const { matchStats } = require("./stats");

const LEVELS = ["faible", "moyen", "eleve"];
const WARNING_ODDS = "Cotes estimées (1 ÷ probabilité), sans marge de bookmaker : les cotes réelles proposées par un opérateur seront plus basses.";
const dec = (x) => String(round(x, 1)).replace(".", ",");
const pct1 = (p) => round(p * 100, 1);

// Assemble les données, le modèle statistique et l'IA pour répondre aux routes.
// `europe` (facultatif) : comparaison entre clubs de championnats différents et coupes d'Europe (europe.js). Sans lui, ou coupé par
// EUROPE_ENABLED=off, seuls des clubs d'un même championnat se comparent (les autres reçoivent l'état « ligues_differentes »).
function createAnalysis({ config, data, ai, europe = null, now = Date.now, log = console }) {
  const crossOn = Boolean(europe && europe.enabled);
  const aiCache = new SwrCache({ max: 600, now });
  // Correction mesurée sur les matchs récents : si les paris choisis automatiquement se réalisent moins souvent
  // que prévu, leurs probabilités sont abaissées d'autant (jamais relevées). Voir tuning.js.
  const calibration = { pickShift: 0, info: null };
  const setPickShift = (shift, info) => {
    calibration.pickShift = Math.min(0, Number.isFinite(shift) ? shift : 0);
    calibration.info = info || null;
  };

  // ---------- Calcul du modèle pour un match ----------
  function computeCore(leagueData, homeId, awayId) {
    const { lh, la } = expectedGoals(leagueData.fit, homeId, awayId);
    const matrix = scoreMatrix(lh, la, { rho: config.model.rho, maxGoals: config.model.maxGoals });
    const quality = dataQuality(leagueData.fit, homeId, awayId);
    return { lh, la, matrix, quality, ...describeMatrix(matrix) };
  }

  const dataLabel = (q) => (q.level >= 2 ? "bonne" : q.level === 1 ? "moyenne" : "faible");

  function confidence(quality, p, aiConf) {
    let idx = quality.level === 0 ? 0 : quality.level === 1 ? 1 : p >= 0.66 ? 2 : 1;
    if (aiConf) idx = Math.min(idx, LEVELS.indexOf(aiConf)); // l'IA peut seulement rendre le verdict plus prudent
    return LEVELS[idx];
  }

  // `rule` : règle de remboursement d'un pari à ligne entière (voir markets.js), avec bet.push = probabilité de remboursement.
  function modelJustification({ home, away, bet, core, stats, rule = null }) {
    const parts = [`Le modèle attend ${dec(core.lh)} but pour ${home} et ${dec(core.la)} pour ${away} : « ${bet.label} » est estimé à ${Math.round(bet.p * 100)} %${bet.push ? " de chances d'être gagné" : ""}.`];
    if (bet.push && rule) parts.push(`${rule} Ce cas arrive dans ${Math.round(bet.push * 100)} % des scénarios.`);
    const f1 = stats.statsEquipe1 && stats.statsEquipe1.forme;
    const f2 = stats.statsEquipe2 && stats.statsEquipe2.forme;
    if (f1 && f2) parts.push(`Forme récente (du plus récent au plus ancien) : ${home} ${f1}, ${away} ${f2}.`);
    if (core.quality.level === 0) parts.push("Attention : peu de matchs récents pour au moins une des deux équipes, l'estimation est moins fiable.");
    if (core.cross) {
      const alone = [core.cross.sansChampionnat1 && home, core.cross.sansChampionnat2 && away].filter(Boolean);
      parts.push(
        alone.length === 0
          ? `${home} et ${away} ne jouent pas dans le même championnat : le niveau des deux championnats est comparé grâce aux coupes d'Europe, ce qui rend l'estimation moins précise.`
          : alone.length === 1
            ? `${alone[0]} ne joue dans aucun championnat suivi : son niveau est déduit de ses seuls matchs de coupes d'Europe, l'estimation est peu précise.`
            : `${home} et ${away} ne jouent dans aucun championnat suivi : leur niveau est déduit de leurs seuls matchs de coupes d'Europe, l'estimation est peu précise.`
      );
    }
    return parts.join(" ");
  }

  // ---------- Relecture par l'IA (avec mémoire pour ne pas payer deux fois la même analyse) ----------
  async function reviewWithAi(ctx, { key, timeoutMs }) {
    if (!ai.enabled) return { statut: "desactivee" };
    try {
      const r = await aiCache.get(key, {
        ttlMs: 6 * 3600000,
        errorTtlMs: 120000,
        loader: async () => {
          const out = await ai.review(ctx, { timeoutMs });
          if (!out.ok) throw Object.assign(new Error(out.message), { aiCode: out.code });
          return out;
        },
      });
      return { statut: "ok", modele: config.anthropic.model, review: r };
    } catch (e) {
      return { statut: "indisponible", code: e.aiCode || "ERROR", message: e.message };
    }
  }

  const aiPublic = (r) => {
    if (r.statut === "ok") return { statut: "ok", modele: r.modele };
    if (r.statut === "desactivee") return { statut: "desactivee" };
    return { statut: "indisponible", code: r.code, message: r.message };
  };

  // Probabilité finale = modèle + petite correction de l'IA (bornée, nulle pour les scores exacts).
  // `push` : probabilité de remboursement d'un pari à ligne entière. Gagner et être remboursé ne dépassent jamais 100 % à eux deux.
  function finalProbability(pModel, review, exact, push = 0) {
    if (!review || exact) return { p: pModel, adjustment: 0 };
    const cap = Math.min(config.anthropic.maxAdjustPoints, 0.2 * pModel * 100);
    let adjustment = clamp(review.adjustment, -cap, cap);
    let p = clamp(pModel + adjustment / 100, 0.01, 0.99);
    const ceiling = 1 - push - 0.005;
    if (push > 0 && p > ceiling) {
      p = Math.max(pModel, ceiling);
      adjustment = (p - pModel) * 100;
    }
    return { p, adjustment: round(adjustment, 1) };
  }

  // ---------- Reconnaissance des équipes ----------
  // On attend les championnats principaux et les coupes d'Europe (pas les championnats complémentaires, qui se chargent ensuite
  // en arrière-plan : une demande ne doit jamais patienter pour eux).
  async function loadAll(budgetMs = 10000) {
    return data.ensureAll({ budgetMs, scope: "essential" });
  }

  // Championnats en panne cités dans le message : les 6 premiers, puis le nombre des autres.
  const MAX_NAMED = 6;

  function resolveTeams(q1, q2) {
    const teams = data.allTeams();
    // Aucune équipe connue : soit le chargement n'est pas fini (il suffit d'attendre), soit toutes les sources ont échoué
    // (attendre ne servirait à rien : mieux vaut le dire que promettre « réessayez dans une minute »).
    if (!teams.length) return { state: data.allFailed() ? "donnees_indisponibles" : "chargement" };
    let a = findTeam(q1, teams);
    let b = findTeam(q2, teams);
    // Un club trouvé aide à départager l'autre dans son propre championnat (deux clubs du même championnat : le cas le plus courant).
    // Sans comparaison entre championnats, la recherche reste limitée à ce championnat ; avec elle, on garde le résultat sur
    // l'ensemble des clubs quand le championnat du premier n'a rien donné.
    if (a.team && !b.team) {
      const retry = findTeam(q2, teams, { leagueKey: a.team.leagueKey });
      if (!crossOn || retry.team) b = retry;
    }
    if (b.team && !a.team) {
      const retry = findTeam(q1, teams, { leagueKey: b.team.leagueKey });
      if (!crossOn || retry.team) a = retry;
    }
    const found1 = Boolean(a.team);
    const found2 = Boolean(b.team);
    if (!found1 || !found2) {
      // Un club est introuvable alors que des championnats ne sont pas encore chargés (démarrage du serveur) : il est peut-être dans
      // l'un d'eux. Dire « équipe introuvable » serait faux ; il suffit de réessayer dans un instant.
      // Sans comparaison entre championnats, un club trouvé limite la recherche du second à son championnat, déjà chargé : la réponse
      // est alors définitive. Avec elle, le second peut jouer n'importe où.
      const unloaded = crossOn || (!found1 && !found2) ? data.unloadedLeagues() : [];
      if (unloaded.some((l) => l.etat === "chargement")) return { state: "chargement", found1, found2 };
      const suggestions = {};
      if (!found1) suggestions.equipe1 = a.alternatives || [];
      if (!found2) suggestions.equipe2 = b.alternatives || [];
      const ambiguous = (!found1 && a.ambiguous) || (!found2 && b.ambiguous);
      // Des championnats en panne : on le dit, car le club cherché est peut-être dans l'un d'eux.
      return {
        state: ambiguous ? "ambigu" : "equipe_inconnue",
        found1,
        found2,
        suggestions,
        indisponibles: unloaded.slice(0, MAX_NAMED).map((l) => l.nom),
        indisponiblesAutres: Math.max(0, unloaded.length - MAX_NAMED),
      };
    }
    if (a.team.id === b.team.id) return { state: "meme_equipe", found1, found2 };
    // Deux clubs du même championnat : modèle du championnat, comme avant. Les clubs « sans championnat suivi » (connus par les coupes
    // d'Europe seulement) ne forment pas un championnat.
    if (a.team.leagueKey === b.team.leagueKey && a.team.leagueKey !== OTHER_KEY) {
      return { state: "ok", found1, found2, home: a.team, away: b.team, leagueKey: a.team.leagueKey, cross: false };
    }
    if (!crossOn) return { state: "ligues_differentes", found1, found2, home: a.team, away: b.team };
    return { state: "ok", found1, found2, home: a.team, away: b.team, leagueKey: null, cross: true };
  }

  const MESSAGES = {
    chargement: "Les données des championnats sont en cours de chargement, réessayez dans une minute.",
    donnees_indisponibles: "Les données de matchs sont momentanément indisponibles (la source de données ne répond pas ou refuse l'accès). Réessayez plus tard.",
    equipe_inconnue: "Équipe introuvable : vérifiez l'orthographe ou utilisez le nom complet du club.",
    ambigu: "Nom d'équipe ambigu : précisez le nom complet du club.",
    meme_equipe: "Les deux équipes sont identiques.",
    ligues_differentes: "Les deux équipes ne jouent pas dans le même championnat : sans données comparables, aucune probabilité fiable n'est calculée.",
    marche_inconnu: "Type de pari non reconnu : choisissez un type de la liste pour obtenir une probabilité.",
  };

  const unresolved = (state, extra = {}) => ({
    etat: state,
    probabilite: null,
    donneesInsuffisantes: true,
    equipesTrouvees1: false,
    equipesTrouvees2: false,
    message: MESSAGES[state] || "Analyse impossible.",
    ...extra,
  });

  // Réponse « analyse impossible » pour un résultat de resolveTeams qui n'est pas « ok ».
  const unresolvedFrom = (r) =>
    unresolved(r.state, {
      equipesTrouvees1: Boolean(r.found1),
      equipesTrouvees2: Boolean(r.found2),
      suggestions: r.suggestions,
      ...(r.state === "ligues_differentes" ? { equipe1: r.home.name, equipe2: r.away.name } : {}),
      ...(r.indisponibles && r.indisponibles.length
        ? { message: `${MESSAGES[r.state]} Données momentanément indisponibles pour : ${r.indisponibles.join(", ")}${r.indisponiblesAutres ? ` et ${r.indisponiblesAutres} autre(s)` : ""}.` }
        : {}),
    });

  // Ce qu'il faut savoir sur la comparaison entre deux championnats, pour l'écran (et pour l'IA, voir ai.js).
  const crossPublic = (cross) => {
    const alone = [cross.sansChampionnat1, cross.sansChampionnat2].filter(Boolean).length;
    return {
      championnat1: cross.championnat1,
      championnat2: cross.championnat2,
      niveauDesChampionnatsMesure: cross.etalonne,
      message:
        alone === 2
          ? "Aucun de ces clubs ne joue dans un championnat suivi par l'application : leur niveau n'est estimé que d'après leurs matchs de coupes d'Europe. Estimation peu précise."
          : alone === 1
            ? "L'un de ces clubs ne joue dans aucun championnat suivi par l'application : son niveau n'est estimé que d'après ses matchs de coupes d'Europe. Estimation peu précise."
            : cross.etalonne
              ? "Ces deux clubs ne jouent pas dans le même championnat : leur niveau relatif est estimé grâce aux matchs de coupes d'Europe. Estimation moins précise qu'entre deux clubs d'un même championnat."
              : "Ces deux clubs ne jouent pas dans le même championnat, et le niveau relatif de leurs championnats ne repose que sur une estimation générale (peu de matchs de coupes d'Europe) : estimation peu précise.",
    };
  };

  // Tout ce qui sert à analyser un match une fois les deux clubs reconnus : calcul du modèle, matchs pour les statistiques, match à venir
  // éventuel et nom de la compétition. Deux cas : deux clubs du même championnat (modèle du championnat) ou de championnats différents.
  async function prepare(r) {
    if (!r.cross) {
      const leagueData = await data.getLeagueData(r.leagueKey);
      return {
        core: computeCore(leagueData, r.home.id, r.away.id),
        finished: leagueData.finished,
        fixture: leagueData.fixtures.find((f) => f.home.id === r.home.id && f.away.id === r.away.id) || null,
        competition: leagueData.league.name,
      };
    }
    // Les championnats des deux clubs sont déjà en mémoire (les clubs viennent de là) : on s'assure juste de leur fraîcheur.
    await Promise.all([r.home.leagueKey, r.away.leagueKey].filter((k, i, all) => k !== OTHER_KEY && all.indexOf(k) === i).map((k) => data.getLeagueData(k)));
    const core = europe.core(r.home, r.away);
    const fixture = europe.findFixture(r.home.id, r.away.id);
    return {
      core,
      finished: europe.relevantFinished(r.home, r.away),
      fixture,
      competition: fixture ? fixture.cup.name : r.home.leagueKey === OTHER_KEY && r.away.leagueKey === OTHER_KEY ? "Match entre clubs européens" : "Match entre clubs de championnats différents",
    };
  }

  // ---------- Analyse d'une sélection (équipe 1 à domicile contre équipe 2) ----------
  async function analyzeLeg({ equipe1, equipe2, typePari }, { withAi = true, aiTimeoutMs = 25000, shift = 0 } = {}) {
    const market = resolveMarket(typePari);
    const r = resolveTeams(equipe1, equipe2);
    if (r.state !== "ok") return unresolvedFrom(r);
    if (!market) {
      return unresolved("marche_inconnu", {
        equipesTrouvees1: true,
        equipesTrouvees2: true,
        equipe1: r.home.name,
        equipe2: r.away.name,
        typePari: typeof typePari === "string" ? typePari.slice(0, 80) : null,
        marchesDisponibles: [...MARKETS.map((m) => m.label), "Score exact"],
      });
    }

    const prep = await prepare(r);
    const { core, fixture } = prep;
    const stats = matchStats(prep.finished, r.home.id, r.away.id);
    const ev = evaluate(core.matrix, market);
    const pModel = ev.p;
    const exact = Boolean(market.exact);
    // Pari à ligne entière (« plus de 2 buts ») : `push` = probabilité d'être remboursé, `pModel` = celle de gagner.
    const push = ev.push || 0;
    const rule = refundRule(market, r.home.name, r.away.name);
    // La correction des paris automatiques ne doit pas faire dépasser 100 % à « gagner + remboursé ».
    const pCal = exact ? pModel : clamp(pModel + shift, 0.01, push > 0 ? Math.min(0.99, Math.max(0.01, 1 - push - 0.005)) : 0.99);
    const bet = { label: market.label, p: pCal, ...(rule ? { push } : {}) };

    let ia = { statut: !withAi && ai.enabled ? "non_demandee" : "desactivee" };
    let review = null;
    if (withAi && !exact) {
      const ctx = {
        home: r.home.name,
        away: r.away.name,
        competition: prep.competition,
        kickoff: fixture ? fixture.kickoff : null,
        bet,
        lh: core.lh,
        la: core.la,
        outcomes: core.outcomes,
        quality: core.quality,
        stats,
        ...(core.cross ? { cross: core.cross } : {}),
      };
      const key = `leg:${r.home.id}:${r.away.id}:${market.label}:${Math.round(pCal * 100)}:${fixture ? fixture.id : "-"}`;
      const res = await reviewWithAi(ctx, { key, timeoutMs: aiTimeoutMs });
      ia = aiPublic(res);
      review = res.review || null;
    } else if (exact) {
      ia = { statut: "non_applicable" };
    }

    const fin = finalProbability(pCal, review, exact, push);
    const justification = exact
      ? `Score le plus probable selon le modèle : ${ev.detail} (${Math.round(pModel * 100)} %). Un score exact reste un pari très risqué.`
      : review
        ? review.justification
        : modelJustification({ home: r.home.name, away: r.away.name, bet, core, stats, rule });

    return {
      etat: "ok",
      equipe1: r.home.name,
      equipe2: r.away.name,
      competition: prep.competition,
      date: fixture ? new Date(fixture.kickoff).toISOString() : null,
      typePari: market.label,
      probabilite: pct1(fin.p),
      probabiliteModele: pct1(pModel),
      ...(shift ? { ajustementCalibrage: round(shift * 100, 1) } : {}),
      ajustementIA: fin.adjustment,
      // Cote équitable : avec un remboursement possible, (1 − P(remboursé)) ÷ P(gagné) ; sinon 1 ÷ probabilité.
      coteEstimee: round((1 - push) / fin.p, 2),
      // Pari à ligne entière : `probabilite` est celle de GAGNER ; la mise est rendue dans `probabiliteRemboursement` des cas.
      ...(rule ? { probabiliteRemboursement: pct1(push), regleRemboursement: rule } : {}),
      niveauConfiance: confidence(core.quality, fin.p, review && review.confiance),
      justification,
      vigilance: review ? review.vigilance : "",
      butsAttendus: { equipe1: round(core.lh, 2), equipe2: round(core.la, 2) },
      scoreProbable: core.likelyScore,
      fiabiliteDonnees: { niveau: dataLabel(core.quality), matchsEquipe1: core.quality.nHome, matchsEquipe2: core.quality.nAway },
      ...(core.cross ? { comparaisonEntreChampionnats: crossPublic(core.cross) } : {}),
      donneesInsuffisantes: false,
      equipesTrouvees1: true,
      equipesTrouvees2: true,
      ia,
      ...stats,
    };
  }

  async function analyzeLegs(legs, opts) {
    await loadAll();
    return Promise.all(
      legs.map((leg) =>
        analyzeLeg(leg, opts).catch((e) => {
          log.error(`[analyse] ${e.message}`);
          return unresolved("erreur", { message: "Analyse impossible pour cette sélection." });
        })
      )
    );
  }

  return { analyzeLeg, analyzeLegs, loadAll, computeCore, prepare, resolveTeams, reviewWithAi, aiPublic, finalProbability, confidence, modelJustification, calibration, setPickShift, helpers: { pct1, dec, unresolved, unresolvedFrom, crossPublic } };
}

module.exports = { createAnalysis, WARNING_ODDS };
