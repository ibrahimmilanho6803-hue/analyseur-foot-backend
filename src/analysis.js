"use strict";

const { clamp, round } = require("./util");
const { SwrCache } = require("./cache");
const { findTeam } = require("./teams");
const { expectedGoals, scoreMatrix, dataQuality } = require("./model");
const { MARKETS, resolveMarket, evaluate, evaluateAll } = require("./markets");
const { matchStats } = require("./stats");
const { thinLegs, selectCoupon, bestForFixture } = require("./picks");

const LEVELS = ["faible", "moyen", "eleve"];
const WARNING_ODDS = "Cotes estimées (1 ÷ probabilité), sans marge de bookmaker : les cotes réelles proposées par un opérateur seront plus basses.";
const dec = (x) => String(round(x, 1)).replace(".", ",");
const pct1 = (p) => round(p * 100, 1);

// Assemble les données, le modèle statistique et l'IA pour répondre aux routes.
function createAnalysis({ config, data, ai, now = Date.now, log = console }) {
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
    const probs = evaluateAll(matrix);
    const get = (label) => (probs.find((x) => x.label === label) || { p: 0 }).p;
    const outcomes = {
      home: get("Victoire domicile"),
      draw: get("Match nul"),
      away: get("Victoire extérieur"),
      over25: get("Plus de 2.5 buts"),
      btts: get("Les deux équipes marquent"),
    };
    const exact = evaluate(matrix, resolveMarket("Score exact"));
    return { lh, la, matrix, quality, probs, outcomes, likelyScore: exact.detail, likelyScoreP: exact.p };
  }

  const dataLabel = (q) => (q.level >= 2 ? "bonne" : q.level === 1 ? "moyenne" : "faible");

  function confidence(quality, p, aiConf) {
    let idx = quality.level === 0 ? 0 : quality.level === 1 ? 1 : p >= 0.66 ? 2 : 1;
    if (aiConf) idx = Math.min(idx, LEVELS.indexOf(aiConf)); // l'IA peut seulement rendre le verdict plus prudent
    return LEVELS[idx];
  }

  function modelJustification({ home, away, bet, core, stats }) {
    const parts = [`Le modèle attend ${dec(core.lh)} but pour ${home} et ${dec(core.la)} pour ${away} : « ${bet.label} » est estimé à ${Math.round(bet.p * 100)} %.`];
    const f1 = stats.statsEquipe1 && stats.statsEquipe1.forme;
    const f2 = stats.statsEquipe2 && stats.statsEquipe2.forme;
    if (f1 && f2) parts.push(`Forme récente (du plus récent au plus ancien) : ${home} ${f1}, ${away} ${f2}.`);
    if (core.quality.level === 0) parts.push("Attention : peu de matchs récents pour au moins une des deux équipes, l'estimation est moins fiable.");
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
  function finalProbability(pModel, review, exact) {
    if (!review || exact) return { p: pModel, adjustment: 0 };
    const cap = Math.min(config.anthropic.maxAdjustPoints, 0.2 * pModel * 100);
    const adjustment = clamp(review.adjustment, -cap, cap);
    return { p: clamp(pModel + adjustment / 100, 0.01, 0.99), adjustment: round(adjustment, 1) };
  }

  // ---------- Reconnaissance des équipes ----------
  async function loadAll(budgetMs = 10000) {
    return data.ensureAll({ budgetMs });
  }

  function resolveTeams(q1, q2) {
    const teams = data.allTeams();
    // Aucune équipe connue : soit le chargement n'est pas fini (il suffit d'attendre), soit toutes les sources ont échoué
    // (attendre ne servirait à rien : mieux vaut le dire que promettre « réessayez dans une minute »).
    if (!teams.length) return { state: data.allFailed() ? "donnees_indisponibles" : "chargement" };
    let a = findTeam(q1, teams);
    let b = findTeam(q2, teams);
    if (a.team && !b.team) b = findTeam(q2, teams, { leagueKey: a.team.leagueKey });
    if (b.team && !a.team) a = findTeam(q1, teams, { leagueKey: b.team.leagueKey });
    const found1 = Boolean(a.team);
    const found2 = Boolean(b.team);
    if (!found1 || !found2) {
      const suggestions = {};
      if (!found1) suggestions.equipe1 = a.alternatives || [];
      if (!found2) suggestions.equipe2 = b.alternatives || [];
      const ambiguous = (!found1 && a.ambiguous) || (!found2 && b.ambiguous);
      return { state: ambiguous ? "ambigu" : "equipe_inconnue", found1, found2, suggestions };
    }
    if (a.team.id === b.team.id) return { state: "meme_equipe", found1, found2 };
    if (a.team.leagueKey !== b.team.leagueKey) return { state: "ligues_differentes", found1, found2, home: a.team, away: b.team };
    return { state: "ok", found1, found2, home: a.team, away: b.team, leagueKey: a.team.leagueKey };
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

  // ---------- Analyse d'une sélection (équipe 1 à domicile contre équipe 2) ----------
  async function analyzeLeg({ equipe1, equipe2, typePari }, { withAi = true, aiTimeoutMs = 25000, shift = 0 } = {}) {
    const market = resolveMarket(typePari);
    const r = resolveTeams(equipe1, equipe2);
    if (r.state !== "ok") {
      return unresolved(r.state, {
        equipesTrouvees1: Boolean(r.found1),
        equipesTrouvees2: Boolean(r.found2),
        suggestions: r.suggestions,
        ...(r.state === "ligues_differentes" ? { equipe1: r.home.name, equipe2: r.away.name } : {}),
      });
    }
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

    const leagueData = await data.getLeagueData(r.leagueKey);
    const core = computeCore(leagueData, r.home.id, r.away.id);
    const stats = matchStats(leagueData.finished, r.home.id, r.away.id);
    const fixture = leagueData.fixtures.find((f) => f.home.id === r.home.id && f.away.id === r.away.id) || null;
    const ev = evaluate(core.matrix, market);
    const pModel = ev.p;
    const exact = Boolean(market.exact);
    const pCal = exact ? pModel : clamp(pModel + shift, 0.01, 0.99);
    const bet = { label: market.label, p: pCal };

    let ia = { statut: "desactivee" };
    let review = null;
    if (withAi && !exact) {
      const ctx = {
        home: r.home.name,
        away: r.away.name,
        competition: leagueData.league.name,
        kickoff: fixture ? fixture.kickoff : null,
        bet,
        lh: core.lh,
        la: core.la,
        outcomes: core.outcomes,
        quality: core.quality,
        stats,
      };
      const key = `leg:${r.home.id}:${r.away.id}:${market.label}:${Math.round(pCal * 100)}:${fixture ? fixture.id : "-"}`;
      const res = await reviewWithAi(ctx, { key, timeoutMs: aiTimeoutMs });
      ia = aiPublic(res);
      review = res.review || null;
    } else if (exact) {
      ia = { statut: "non_applicable" };
    }

    const fin = finalProbability(pCal, review, exact);
    const justification = exact
      ? `Score le plus probable selon le modèle : ${ev.detail} (${Math.round(pModel * 100)} %). Un score exact reste un pari très risqué.`
      : review
        ? review.justification
        : modelJustification({ home: r.home.name, away: r.away.name, bet, core, stats });

    return {
      etat: "ok",
      equipe1: r.home.name,
      equipe2: r.away.name,
      competition: leagueData.league.name,
      date: fixture ? new Date(fixture.kickoff).toISOString() : null,
      typePari: market.label,
      probabilite: pct1(fin.p),
      probabiliteModele: pct1(pModel),
      ...(shift ? { ajustementCalibrage: round(shift * 100, 1) } : {}),
      ajustementIA: fin.adjustment,
      coteEstimee: round(1 / fin.p, 2),
      niveauConfiance: confidence(core.quality, fin.p, review && review.confiance),
      justification,
      vigilance: review ? review.vigilance : "",
      butsAttendus: { equipe1: round(core.lh, 2), equipe2: round(core.la, 2) },
      scoreProbable: core.likelyScore,
      fiabiliteDonnees: { niveau: dataLabel(core.quality), matchsEquipe1: core.quality.nHome, matchsEquipe2: core.quality.nAway },
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

  return { analyzeLeg, analyzeLegs, loadAll, computeCore, resolveTeams, reviewWithAi, aiPublic, finalProbability, confidence, modelJustification, calibration, setPickShift, helpers: { pct1, dec, unresolved } };
}

module.exports = { createAnalysis, WARNING_ODDS };
