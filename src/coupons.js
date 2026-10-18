"use strict";

const { round } = require("./util");
const { selectCoupon, selectAll } = require("./picks");
const { resolveMarket, refundInfo } = require("./markets");
const { matchStats } = require("./stats");
const { WARNING_ODDS, MAX_SHOWN } = require("./analysis");
const { isCup } = require("./leagues");

const TOP_TTL_MS = 15 * 60000;
const PARTIAL_TTL_MS = 60000;
// Marge sur l'objectif de cote : la relecture de l'IA peut corriger chaque probabilité de quelques points, donc la cote totale finale
// s'écarte un peu de celle du modèle. Si malgré cette marge la cote finale reste sous l'objectif, on recommence le choix avec une marge
// plus grande (MAX_PASSES essais au plus ; les paris déjà relus ne sont pas relus : l'IA garde ses réponses en mémoire).
const SAFETY = 1.04;
const MAX_PASSES = 3;

// `europe` (facultatif) : matchs de coupes d'Europe et comparaison entre championnats (europe.js). « Top Matchs » ne retient des matchs
// de coupe que si TOP_CUPS n'est pas coupé ; le mode Auto peut analyser n'importe quel match qu'on lui donne.
function createCoupons({ config, data, analysis, europe = null, now = Date.now, log = console }) {
  const top = config.top;
  const cupsInTop = Boolean(europe && europe.enabled && config.europe && config.europe.topCups);
  const { computeCore, reviewWithAi, aiPublic, finalProbability, confidence, modelJustification } = analysis;
  const { pct1, unresolved, unresolvedFrom, crossPublic } = analysis.helpers;

  // Probabilités de tous les paris d'un match, abaissées de la correction mesurée sur les paris automatiques (jamais relevées).
  const calibrated = (core, shift) => core.probs.map((x) => ({ ...x, p: Math.max(0.01, x.p + shift) }));

  // Le pari tel que l'IA et l'écran le reçoivent : un pari remboursable (ligne entière) porte la probabilité et le cas du remboursement.
  const betOf = (best) => {
    const market = best.push > 0 ? resolveMarket(best.label) : null;
    return { label: best.label, p: best.p, ...(market ? { push: best.push, refund: { p: best.push, when: market.refundWhen } } : {}) };
  };

  // Matchs à venir de tous les championnats prêts (et des coupes d'Europe), avec les probabilités de tous leurs paris.
  function gather(ready, nowMs, hours, minLevel, shift) {
    const until = nowMs + hours * 3600000;
    const out = [];
    for (const ld of ready) {
      for (const f of ld.fixtures) {
        if (f.kickoff <= nowMs || f.kickoff > until) continue;
        const core = computeCore(ld, f.home.id, f.away.id);
        if (core.quality.level < minLevel) continue;
        out.push({ id: f.id, leagueKey: ld.league.key, kickoff: f.kickoff, quality: core.quality.level, probs: calibrated(core, shift), fixture: f, leagueData: ld, core });
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
        out.push({
          id: f.id,
          leagueKey: f.cup.key,
          kickoff: f.kickoff,
          quality: core.quality.level,
          probs: calibrated(core, shift),
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
      probabiliteModele: pct1(Math.min(bet.p - shift, MAX_SHOWN)),
      ...(shift ? { ajustementCalibrage: round(shift * 100, 1) } : {}),
      ajustementIA: fin.adjustment,
      coteEstimee: round(1 / fin.p, 2),
      ...(bet.refund ? { remboursement: refundInfo(resolveMarket(bet.label), bet.push) } : {}),
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

  // Choix avec la marge demandée sur l'objectif de cote. Si cet objectif relevé est hors d'atteinte avec ces matchs, on essaie avec la moitié
  // de la marge, puis sans marge : mieux vaut un objectif atteint de justesse (la relecture de l'IA peut le faire manquer) qu'un coupon
  // qui le manque d'avance.
  const chooseWithMargin = (select, margin) => {
    let sel = null;
    for (const m of [margin, 1 + (margin - 1) / 2, 1]) {
      sel = select(top.targetOdds * m);
      if (sel.targetReached) break;
    }
    return sel;
  };

  // Un pari retenu, relu par l'IA : sa probabilité finale est celle du modèle plus la petite correction de l'IA (voir finalProbability).
  async function reviewPick(leg, shift) {
    const c = leg.fixture; // le match candidat, avec son modèle
    const f = c.fixture;
    const bet = betOf(leg);
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
  }

  // Choisit les matchs et leurs paris pour que la cote totale atteigne l'objectif, les fait relire par l'IA, puis vérifie la cote FINALE
  // (après la correction de l'IA). Trop basse : nouveau choix avec une marge plus grande. On garde le meilleur essai.
  async function chooseTop(cands, shift) {
    let margin = SAFETY;
    let best = null;
    let previous = "";
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      const sel = chooseWithMargin((target) => selectCoupon(cands, { count: top.count, targetOdds: target, minP: top.minLegP, maxP: top.maxLegP }), margin);
      const signature = sel.legs.map((l) => `${l.fixture.id}:${l.label}`).join("|");
      if (!sel.legs.length || signature === previous) break; // même choix qu'à l'essai précédent : le refaire ne changerait rien
      previous = signature;
      const picks = await Promise.all(sel.legs.map((leg) => reviewPick(leg, shift)));
      const odds = picks.reduce((acc, x) => acc / x.fin.p, 1);
      const reached = Number(odds.toFixed(2)) >= top.targetOdds; // comparé à la cote affichée (2 décimales)
      if (!best || reached || odds > best.odds) best = { picks, odds, reached };
      if (reached || !sel.targetReached) break; // atteint, ou hors d'atteinte avec ces matchs : un nouvel essai ne changerait rien
      margin = Math.min((1 / sel.joint / odds) * 1.01, 1.5); // l'IA a retiré (cote du modèle ÷ cote finale) à la cote : le prochain choix vise d'autant plus haut, plus 1 %
    }
    return best;
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
      objectifCote: top.targetOdds,
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
      return { ...base, topMatches: [], coteTotale: "0.00", probabiliteCombinee: 0, objectifCoteAtteint: false, ia: { statut: "non_applicable" }, message: `Aucun match à venir trouvé dans les ${windowHours} prochaines heures.` };
    }

    const chosen = await chooseTop(cands, shift);
    if (!chosen) {
      return { ...base, topMatches: [], coteTotale: "0.00", probabiliteCombinee: 0, objectifCoteAtteint: false, ia: { statut: "non_applicable" }, message: `Aucun pari exploitable trouvé dans les ${windowHours} prochaines heures.` };
    }
    const { picks, reached } = chosen;
    picks.sort((x, y) => y.fin.p - x.fin.p);

    const joint = picks.reduce((acc, x) => acc * x.fin.p, 1);
    const odds = picks.reduce((acc, x) => acc / x.fin.p, 1);
    const okCount = picks.filter((x) => x.res.statut === "ok").length;
    const statuts = picks.map((x) => x.res.statut);
    const iaStatut = okCount === picks.length ? "ok" : okCount > 0 ? "partielle" : statuts.every((s) => s === "desactivee") ? "desactivee" : "indisponible";
    const notes = [];
    if (picks.length < top.count) notes.push(`Seulement ${picks.length} match(s) exploitable(s) trouvé(s) dans les ${windowHours} prochaines heures.`);
    if (!reached) notes.push(`La cote visée (${top.targetOdds}) n'est pas atteinte avec les matchs disponibles (cote totale : ${odds.toFixed(2)}).`);
    return {
      ...base,
      topMatches: picks.map(entryFor),
      coteTotale: odds.toFixed(2),
      probabiliteCombinee: pct1(joint),
      objectifCoteAtteint: reached,
      ia: { statut: iaStatut, modele: config.anthropic.model },
      ...(notes.length ? { message: notes.join(" ") } : {}),
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

  // Coupon automatique : un pari pour chaque match saisi, choisi pour que la cote totale atteigne l'objectif avec des paris aussi fiables
  // que possible (voir picks.js). Avec trop peu de matchs (moins de 3), un objectif de 5 n'est pas atteignable avec des paris fiables :
  // le coupon est alors le plus proche possible de l'objectif, et le message le dit. `withAi: false` : modèle statistique seul.
  async function autoCoupon(matches, { withAi = true } = {}) {
    await analysis.loadAll();
    const shift = analysis.calibration.pickShift;
    const prepared = await Promise.all(
      matches.map(async (m, index) => {
        try {
          const r = analysis.resolveTeams(m.equipe1, m.equipe2);
          if (r.state !== "ok") return { index, failure: unresolvedFrom(r) };
          const { core } = await analysis.prepare(r);
          return { index, r, probs: calibrated(core, shift) };
        } catch (e) {
          log.error(`[auto] ${e.message}`);
          return { index, failure: unresolved("erreur", { message: "Analyse impossible pour ce match." }) };
        }
      })
    );
    const results = new Array(matches.length);
    const usable = [];
    for (const x of prepared) {
      if (x.failure) results[x.index] = { index: x.index, ...x.failure };
      else usable.push(x);
    }

    const analyzeAs = async (u, label) => {
      try {
        const leg = await analysis.analyzeLeg({ equipe1: u.r.home.name, equipe2: u.r.away.name, typePari: label }, { shift, withAi });
        return { index: u.index, ...leg };
      } catch (e) {
        log.error(`[auto] ${e.message}`);
        return { index: u.index, ...unresolved("erreur", { message: "Analyse impossible pour ce match." }) };
      }
    };
    let margin = SAFETY;
    let best = null;
    let previous = "";
    for (let pass = 1; usable.length && pass <= MAX_PASSES; pass++) {
      const sel = chooseWithMargin((target) => selectAll(usable.map((u) => ({ probs: u.probs })), { targetOdds: target, minP: top.minLegP, maxP: top.maxLegP }), margin);
      const signature = sel.legs.map((l) => l.label).join("|");
      if (signature === previous) break; // même choix qu'à l'essai précédent : le refaire ne changerait rien
      previous = signature;
      const legs = await Promise.all(usable.map((u, i) => analyzeAs(u, sel.legs[i].label)));
      const done = legs.filter((x) => x.etat === "ok");
      const odds = done.reduce((acc, x) => acc * x.coteEstimee, 1);
      const reached = done.length > 0 && Number(odds.toFixed(2)) >= top.targetOdds;
      if (!best || reached || odds > best.odds) best = { legs, odds, reached, possible: sel.targetReached };
      if (reached || !sel.targetReached || !done.length) break;
      margin = Math.min((1 / sel.joint / odds) * 1.01, 1.5); // l'IA a retiré (cote du modèle ÷ cote finale) à la cote : le prochain choix vise d'autant plus haut, plus 1 %
    }
    if (best) for (const leg of best.legs) results[leg.index] = leg;

    const ok = results.filter((x) => x.etat === "ok");
    const joint = ok.reduce((acc, x) => acc * (x.probabilite / 100), 1);
    const odds = ok.reduce((acc, x) => acc * x.coteEstimee, 1);
    const reached = ok.length ? Number(odds.toFixed(2)) >= top.targetOdds : null;
    let message = "";
    if (reached === false) {
      const n = ok.length;
      message = `La cote visée (${top.targetOdds}) n'est pas atteinte (cote totale : ${odds.toFixed(2)}).`;
      message += best && !best.possible ? ` Avec ${n} match${n > 1 ? "s" : ""}, des paris fiables ne permettent pas d'aller plus haut : ajoutez des matchs.` : " La relecture de l'IA a légèrement modifié les probabilités.";
    }
    return {
      resultats: results,
      analyses: ok.length,
      probabiliteCombinee: ok.length ? pct1(joint) : null,
      coteTotale: ok.length ? odds.toFixed(2) : null,
      objectifCote: top.targetOdds,
      objectifCoteAtteint: reached,
      ...(message ? { message } : {}),
      avertissement: WARNING_ODDS,
    };
  }

  return { topMatches, autoCoupon, computeTop };
}

module.exports = { createCoupons };
