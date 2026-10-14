"use strict";

const { round } = require("./util");
const { bestForFixture, selectTop } = require("./picks");
const { matchStats } = require("./stats");
const { WARNING_ODDS } = require("./analysis");
const { isCup } = require("./leagues");

const TOP_TTL_MS = 15 * 60000;
const PARTIAL_TTL_MS = 60000;

// Probabilités des paris d'un match abaissées du décalage mesuré sur les matchs récents (voir tuning.js).
const calibrate = (probs, shift) => probs.map((x) => ({ ...x, p: Math.max(0.01, x.p + shift) }));

// `europe` (facultatif) : matchs de coupes d'Europe et comparaison entre championnats (europe.js). « Top Matchs » ne retient des matchs
// de coupe que si TOP_CUPS n'est pas coupé ; le mode Auto peut analyser n'importe quel match qu'on lui donne.
function createCoupons({ config, data, analysis, europe = null, now = Date.now, log = console }) {
  const top = config.top;
  const cupsInTop = Boolean(europe && europe.enabled && config.europe && config.europe.topCups);
  const { computeCore, reviewWithAi, aiPublic, finalProbability, confidence, modelJustification } = analysis;
  const { pct1, unresolved, unresolvedFrom, crossPublic } = analysis.helpers;

  // Matchs à venir de tous les championnats prêts (et des coupes d'Europe), avec leurs paris candidats.
  function gather(ready, nowMs, hours, minLevel, shift) {
    const until = nowMs + hours * 3600000;
    const out = [];
    for (const ld of ready) {
      for (const f of ld.fixtures) {
        if (f.kickoff <= nowMs || f.kickoff > until) continue;
        const core = computeCore(ld, f.home.id, f.away.id);
        if (core.quality.level < minLevel) continue;
        const pick = bestForFixture(calibrate(core.probs, shift));
        if (!pick) continue;
        out.push({ id: f.id, leagueKey: ld.league.key, kickoff: f.kickoff, quality: core.quality.level, pick, fixture: f, leagueData: ld, core });
      }
    }
    // Matchs de coupes d'Europe : les deux clubs viennent de championnats différents, l'estimation est donc moins précise. Pour ne
    // pas laisser le « meilleur des meilleurs » choisir justement les écarts de niveau mal mesurés, on exige des données au moins
    // « moyennes » (les deux championnats mesurés par des matchs de coupe, chaque club bien connu), quel que soit minLevel.
    if (cupsInTop) {
      for (const f of europe.upcomingCupFixtures(nowMs, until)) {
        const home = europe.teamRecord(f.home.id);
        const away = europe.teamRecord(f.away.id);
        if (!home || !away) continue;
        // Deux clubs du même championnat (une confrontation entre clubs anglais, par exemple) : modèle du championnat, comme pour un match
        // saisi à la main. Seuls des clubs de championnats différents passent par la comparaison entre championnats.
        const shared = home.rated && away.rated && home.leagueKey === away.leagueKey ? ready.find((d) => d.league.key === home.leagueKey) : null;
        const core = shared ? computeCore(shared, home.id, away.id) : europe.core(home, away);
        if (!core || core.quality.level < Math.max(1, minLevel)) continue;
        const pick = bestForFixture(calibrate(core.probs, shift));
        if (!pick) continue;
        out.push({
          id: f.id,
          leagueKey: f.cup.key,
          kickoff: f.kickoff,
          quality: core.quality.level,
          pick,
          fixture: f,
          leagueData: { league: f.cup, finished: europe.relevantFinished(home, away), fixtures: [] },
          core,
        });
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
      ...(c.core.cross ? { comparaisonEntreChampionnats: crossPublic(c.core.cross) } : {}),
    };
  }

  async function computeTop() {
    // Championnats principaux et coupes d'Europe : les championnats complémentaires ne servent pas à choisir le « Top Matchs ».
    const loaded = await data.ensureAll({ budgetMs: top.budgetMs, scope: "essential" });
    const { pending, failed } = loaded;
    const ready = loaded.ready.filter((d) => !isCup(d.league));
    const cupsReady = loaded.ready.filter((d) => isCup(d.league));
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
      avertissement: WARNING_ODDS,
      complet: pending.length === 0,
      donnees: {
        championnatsPrets: ready.map((d) => d.league.key),
        coupesPretes: cupsInTop ? cupsReady.map((d) => d.league.key) : [],
        enAttente: pending,
        enEchec: failed,
        sources: [...new Set(ready.map((d) => d.provider))],
      },
    };
    if (!cands.length) {
      return { ...base, topMatches: [], coteTotale: "0.00", probabiliteCombinee: 0, ia: { statut: "non_applicable" }, message: `Aucun match à venir trouvé dans les ${windowHours} prochaines heures.` };
    }

    // Les trois matchs dont le pari le plus fiable est le plus probable, quelle que soit la cote.
    const sel = selectTop(cands, { count: top.count });
    const picks = await Promise.all(
      sel.map(async (c) => {
        const f = c.fixture;
        const bet = { label: c.pick.label, p: c.pick.p };
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
          ...(c.core.cross ? { cross: c.core.cross } : {}),
        };
        const res = await reviewWithAi(ctx, { key: `top:${f.id}:${bet.label}:${Math.round(bet.p * 100)}`, timeoutMs: 20000 });
        const review = res.review || null;
        return { f, c, stats, bet, res, review, fin: finalProbability(bet.p, review, false), shift };
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
      ia: { statut: iaStatut, modele: config.anthropic.model },
      ...(picks.length < top.count ? { message: `Seulement ${picks.length} match(s) exploitable(s) trouvé(s) dans les ${windowHours} prochaines heures.` } : {}),
      ...(sel.some((c) => c.quality === 0) ? { avertissementDonnees: "Certaines équipes ont peu de matchs récents : estimation moins fiable." } : {}),
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

  // Coupon automatique : pour chaque match saisi, le pari le plus fiable (le plus probable), quelle que soit sa cote.
  async function autoCoupon(matches) {
    await analysis.loadAll();
    const results = await Promise.all(
      matches.map(async (m, index) => {
        try {
          const r = analysis.resolveTeams(m.equipe1, m.equipe2);
          if (r.state !== "ok") return { index, ...unresolvedFrom(r) };
          const { core } = await analysis.prepare(r);
          const shift = analysis.calibration.pickShift;
          const pick = bestForFixture(calibrate(core.probs, shift));
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
