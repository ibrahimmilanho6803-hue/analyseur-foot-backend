"use strict";

const { round } = require("./util");
const { thinLegs, selectCoupon, bestForFixture } = require("./picks");
const { matchStats } = require("./stats");
const { WARNING_ODDS } = require("./analysis");

const TOP_TTL_MS = 15 * 60000;
const PARTIAL_TTL_MS = 60000;
const SAFETY = 1.02; // marge sur l'objectif de cote, pour absorber la petite correction de l'IA

function createCoupons({ config, data, analysis, now = Date.now, log = console }) {
  const top = config.top;
  const { computeCore, reviewWithAi, aiPublic, finalProbability, confidence, modelJustification } = analysis;
  const { pct1, unresolved } = analysis.helpers;

  // Matchs à venir de tous les championnats prêts, avec leurs paris candidats.
  function gather(ready, nowMs, hours, minLevel, shift) {
    const until = nowMs + hours * 3600000;
    const out = [];
    for (const ld of ready) {
      for (const f of ld.fixtures) {
        if (f.kickoff <= nowMs || f.kickoff > until) continue;
        const core = computeCore(ld, f.home.id, f.away.id);
        if (core.quality.level < minLevel) continue;
        const calibrated = core.probs.map((x) => ({ label: x.label, p: Math.max(0.01, x.p + shift) }));
        const legs = thinLegs(calibrated, { minP: top.minLegP, maxP: top.maxLegP });
        if (!legs.length) continue;
        out.push({ id: f.id, leagueKey: ld.league.key, kickoff: f.kickoff, quality: core.quality.level, legs, fixture: f, leagueData: ld, core });
      }
    }
    return out;
  }

  function entryFor({ f, c, stats, bet, res, review, fin, shift }) {
    return {
      id: f.id,
      homeTeam: f.home.name,
      awayTeam: f.away.name,
      competition: c.leagueData.league.name,
      date: new Date(f.kickoff).toISOString(),
      meilleurPari: bet.label,
      probabilite: pct1(fin.p),
      probabiliteModele: pct1(bet.p - shift),
      ...(shift ? { ajustementCalibrage: round(shift * 100, 1) } : {}),
      ajustementIA: fin.adjustment,
      coteEstimee: round(1 / fin.p, 2),
      niveauConfiance: confidence(c.core.quality, fin.p, review && review.confiance),
      justification: review ? review.justification : modelJustification({ home: f.home.name, away: f.away.name, bet, core: c.core, stats }),
      vigilance: review ? review.vigilance : "",
      butsAttendus: { equipe1: round(c.core.lh, 2), equipe2: round(c.core.la, 2) },
      scoreProbable: c.core.likelyScore,
      fiabiliteDonnees: { niveau: c.core.quality.level >= 2 ? "bonne" : c.core.quality.level === 1 ? "moyenne" : "faible", matchsEquipe1: c.core.quality.nHome, matchsEquipe2: c.core.quality.nAway },
      statsHome: stats.statsEquipe1,
      statsAway: stats.statsEquipe2,
      homeAway1: stats.homeAway1,
      homeAway2: stats.homeAway2,
      h2h: stats.h2h,
      ia: aiPublic(res),
    };
  }

  async function computeTop() {
    const { ready, pending, failed } = await data.ensureAll({ budgetMs: top.budgetMs });
    if (!ready.length) {
      const err = new Error("Aucune source de données n'est disponible pour le moment.");
      err.code = "NO_DATA";
      err.details = failed;
      throw err;
    }
    const nowMs = now();
    const shift = analysis.calibration.pickShift;
    let windowHours = top.windowHours;
    let cands = gather(ready, nowMs, windowHours, 1, shift);
    if (cands.length < top.count) {
      windowHours = top.maxWindowHours;
      cands = gather(ready, nowMs, windowHours, 1, shift);
    }
    if (cands.length < top.count) cands = gather(ready, nowMs, windowHours, 0, shift);

    const base = {
      genereLe: new Date(nowMs).toISOString(),
      fenetreHeures: windowHours,
      objectifCote: top.targetOdds,
      avertissement: WARNING_ODDS,
      complet: pending.length === 0,
      donnees: {
        championnatsPrets: ready.map((d) => d.league.key),
        enAttente: pending,
        enEchec: failed,
        sources: [...new Set(ready.map((d) => d.provider))],
      },
    };
    if (!cands.length) {
      return { ...base, topMatches: [], coteTotale: "0.00", probabiliteCombinee: 0, objectifCoteAtteint: false, ia: { statut: "non_applicable" }, message: `Aucun match à venir trouvé dans les ${windowHours} prochaines heures.` };
    }

    const sel = selectCoupon(cands, { count: top.count, targetOdds: top.targetOdds * SAFETY });
    const picks = await Promise.all(
      sel.legs.map(async (leg) => {
        const c = leg.fixture;
        const f = c.fixture;
        const bet = { label: leg.label, p: leg.p };
        const stats = matchStats(c.leagueData.finished, f.home.id, f.away.id);
        const ctx = {
          home: f.home.name,
          away: f.away.name,
          competition: c.leagueData.league.name,
          kickoff: f.kickoff,
          bet,
          lh: c.core.lh,
          la: c.core.la,
          outcomes: c.core.outcomes,
          quality: c.core.quality,
          stats,
        };
        const res = await reviewWithAi(ctx, { key: `top:${f.id}:${leg.label}:${Math.round(leg.p * 100)}`, timeoutMs: 20000 });
        const review = res.review || null;
        return { f, c, stats, bet, res, review, fin: finalProbability(leg.p, review, false), shift };
      })
    );
    picks.sort((x, y) => y.fin.p - x.fin.p);

    const joint = picks.reduce((acc, x) => acc * x.fin.p, 1);
    const odds = picks.reduce((acc, x) => acc / x.fin.p, 1);
    const okCount = picks.filter((x) => x.res.statut === "ok").length;
    const statuts = picks.map((x) => x.res.statut);
    const iaStatut = okCount === picks.length ? "ok" : okCount > 0 ? "partielle" : statuts.every((s) => s === "desactivee") ? "desactivee" : "indisponible";
    return {
      ...base,
      topMatches: picks.map(entryFor),
      coteTotale: odds.toFixed(2),
      probabiliteCombinee: pct1(joint),
      objectifCoteAtteint: Number(odds.toFixed(2)) >= top.targetOdds, // comparé à la cote affichée (2 décimales), sinon « 2.50 » pourrait être déclaré inférieur à 2.5
      ia: { statut: iaStatut, modele: config.anthropic.model },
      ...(picks.length < top.count ? { message: `Seulement ${picks.length} match(s) exploitable(s) trouvé(s) dans les ${windowHours} prochaines heures.` } : {}),
      ...(cands.some((c) => c.quality === 0) ? { avertissementDonnees: "Certaines équipes ont peu de matchs récents : estimation moins fiable." } : {}),
    };
  }

  // Résultat gardé en mémoire (15 min si complet, 1 min sinon) ; un seul calcul à la fois.
  let state = { value: null, at: 0, ttl: 0 };
  let inflight = null;

  const stillValid = () =>
    state.value && now() - state.at < state.ttl && state.value.topMatches.every((m) => Date.parse(m.date) > now());

  async function topMatches() {
    if (stillValid()) return state.value;
    if (!inflight) {
      inflight = computeTop()
        .then((value) => {
          state = { value, at: now(), ttl: value.complet ? TOP_TTL_MS : PARTIAL_TTL_MS };
          return value;
        })
        .finally(() => {
          inflight = null;
        });
    }
    try {
      return await inflight;
    } catch (e) {
      const old = state.value;
      if (old && now() - state.at < 6 * 3600000 && old.topMatches.every((m) => Date.parse(m.date) > now())) {
        log.warn(`[top] recalcul impossible (${e.message}), dernière sélection conservée`);
        return { ...old, perime: true };
      }
      throw e;
    }
  }

  // Coupon automatique : pour chaque match saisi, le pari le plus probable dans la plage voulue.
  async function autoCoupon(matches) {
    await analysis.loadAll();
    const results = await Promise.all(
      matches.map(async (m, index) => {
        try {
          const r = analysis.resolveTeams(m.equipe1, m.equipe2);
          if (r.state !== "ok") {
            return { index, ...unresolved(r.state, { equipesTrouvees1: Boolean(r.found1), equipesTrouvees2: Boolean(r.found2), suggestions: r.suggestions }) };
          }
          const ld = await data.getLeagueData(r.leagueKey);
          const core = computeCore(ld, r.home.id, r.away.id);
          const shift = analysis.calibration.pickShift;
          const pick = bestForFixture(core.probs.map((x) => ({ label: x.label, p: Math.max(0.01, x.p + shift) })), { minP: top.minLegP, maxP: top.maxLegP });
          if (!pick) return { index, ...unresolved("marche_inconnu", { message: "Aucun pari exploitable pour ce match." }) };
          const leg = await analysis.analyzeLeg({ equipe1: r.home.name, equipe2: r.away.name, typePari: pick.label }, { shift: analysis.calibration.pickShift });
          return { index, ...leg };
        } catch (e) {
          log.error(`[auto] ${e.message}`);
          return { index, ...unresolved("erreur", { message: "Analyse impossible pour ce match." }) };
        }
      })
    );
    const ok = results.filter((x) => x.etat === "ok");
    const joint = ok.reduce((acc, x) => acc * (x.probabilite / 100), 1);
    const odds = ok.reduce((acc, x) => acc * x.coteEstimee, 1);
    return {
      resultats: results,
      analyses: ok.length,
      probabiliteCombinee: ok.length ? pct1(joint) : null,
      coteTotale: ok.length ? odds.toFixed(2) : null,
      avertissement: WARNING_ODDS,
    };
  }

  return { topMatches, autoCoupon, computeTop };
}

module.exports = { createCoupons };
