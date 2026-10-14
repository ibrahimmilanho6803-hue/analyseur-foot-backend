"use strict";

const { round, DAY_MS } = require("./util");
const { fitLeague, expectedGoals, scoreMatrix } = require("./model");
const { MARKETS, evaluate, evaluateAll } = require("./markets");
const { bestForFixture } = require("./picks");

// Contrôle de fiabilité « pas à pas » : pour chaque semaine récente, le modèle est ajusté
// uniquement avec les matchs déjà joués à ce moment-là, puis ses probabilités sont comparées
// au résultat réel. On les compare aussi à une référence simple (les fréquences moyennes du
// championnat, sans connaître les équipes). Plus le score de Brier est bas, mieux c'est.

const EVAL_LABELS = [
  "Victoire domicile",
  "Match nul",
  "Victoire extérieur",
  "Victoire ou nul domicile",
  "Victoire ou nul extérieur",
  "Plus de 1.5 buts",
  "Plus de 2.5 buts",
  "Les deux équipes marquent",
  // Marchés ajoutés pour vérifier qu'un réglage du modèle n'en abîme pas d'autres (totaux élevés, buts de chaque équipe).
  "Plus de 3.5 buts",
  "Equipe domicile 0.5 buts plus",
  "Equipe extérieur 0.5 buts plus",
  "Equipe domicile 1.5 buts plus",
  "Equipe extérieur 1.5 buts plus",
];
const EVAL = EVAL_LABELS.map((label) => MARKETS.find((m) => m.label === label));
const BINNED = 8; // seuls les 8 premiers marchés alimentent les tranches de calibration (comparables aux anciens contrôles)
const EPS = 1e-4;
const logLoss = (p, y) => -(y ? Math.log(Math.max(EPS, p)) : Math.log(Math.max(EPS, 1 - p)));

function newAcc() {
  return {
    matches: 0,
    first: Infinity,
    last: -Infinity,
    markets: EVAL.map(() => ({ n: 0, bm: 0, br: 0, lm: 0, lr: 0, sp: 0, sy: 0, sp2: 0, spy: 0 })),
    goals: { n: 0, pred: 0, real: 0, real2: 0 },
    bins: Array.from({ length: 10 }, () => ({ n: 0, sp: 0, sy: 0 })),
    x12: { n: 0, bm: 0, br: 0 },
    picks: { n: 0, hits: 0, sp: 0 },
    byLeague: new Map(),
  };
}

function runLeague(acc, key, finished, opts) {
  const { now, evalDays, stepDays, minTrain, model, pick } = opts; // pick : faux = on ne mesure pas les paris automatiques (plus rapide)
  const from = now - evalDays * DAY_MS;
  const local = { n: 0, bm: 0, br: 0, goalsPred: 0, goalsReal: 0 };
  for (let t = from; t < now; t += stepDays * DAY_MS) {
    const block = finished.filter((m) => m.kickoff >= t && m.kickoff < Math.min(now, t + stepDays * DAY_MS));
    if (!block.length) continue;
    const train = finished.filter((m) => m.kickoff < t);
    if (train.length < minTrain) continue;
    const fit = fitLeague(train, {
      now: t,
      halfLifeDays: model.halfLifeDays,
      priorMatches: model.priorMatches,
      levelHalfLifeDays: model.levelHalfLifeDays,
      levelPriorMatches: model.levelPriorMatches,
      strengthExponent: model.strengthExponent,
      qualityExponent: model.qualityExponent,
      rhythmExponent: model.rhythmExponent,
      levelFactor: model.levelFactor,
    });
    const ref = EVAL.map((mk) => train.filter((m) => mk.test(m.hg, m.ag)).length / train.length);
    for (const m of block) {
      if (!fit.teams.has(m.home.id) || !fit.teams.has(m.away.id)) continue; // équipe inconnue du modèle à cette date
      const { lh, la } = expectedGoals(fit, m.home.id, m.away.id);
      const matrix = scoreMatrix(lh, la, { rho: model.rho, maxGoals: model.maxGoals });
      // Les paris automatiques demandent tous les types de paris ; sans eux, seuls les marchés suivis sont calculés.
      const probs = pick ? evaluateAll(matrix) : EVAL.map((mk) => ({ label: mk.label, p: evaluate(matrix, mk).p }));
      const pOf = new Map(probs.map((x) => [x.label, x.p]));
      acc.matches++;
      acc.goals.n++;
      acc.goals.pred += lh + la;
      acc.goals.real += m.hg + m.ag;
      acc.goals.real2 += (m.hg + m.ag) ** 2;
      local.goalsPred += lh + la;
      local.goalsReal += m.hg + m.ag;
      acc.first = Math.min(acc.first, m.kickoff);
      acc.last = Math.max(acc.last, m.kickoff);
      EVAL.forEach((mk, i) => {
        const p = pOf.get(mk.label);
        const y = mk.test(m.hg, m.ag) ? 1 : 0;
        const a = acc.markets[i];
        a.n++;
        a.bm += (p - y) ** 2;
        a.br += (ref[i] - y) ** 2;
        a.lm += logLoss(p, y);
        a.lr += logLoss(ref[i], y);
        a.sp += p;
        a.sy += y;
        a.sp2 += p * p;
        a.spy += p * y;
        if (i < BINNED) {
          const bin = acc.bins[Math.min(9, Math.floor(p * 10))];
          bin.n++;
          bin.sp += p;
          bin.sy += y;
        }
      });
      // Résultat 1-N-2 : score de Brier à trois issues.
      const outcome = m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2;
      const idx = [0, 1, 2];
      const bm = idx.reduce((s, k) => s + (pOf.get(EVAL_LABELS[k]) - (k === outcome ? 1 : 0)) ** 2, 0);
      const br = idx.reduce((s, k) => s + (ref[k] - (k === outcome ? 1 : 0)) ** 2, 0);
      acc.x12.n++;
      acc.x12.bm += bm;
      acc.x12.br += br;
      local.n++;
      local.bm += bm;
      local.br += br;
      // Le pari que l'application choisirait pour ce match.
      const best = pick ? bestForFixture(probs) : null;
      if (best) {
        const mk = MARKETS.find((x) => x.label === best.label);
        acc.picks.n++;
        acc.picks.sp += best.p;
        if (mk && mk.test(m.hg, m.ag)) acc.picks.hits++;
      }
    }
  }
  acc.byLeague.set(key, local);
}

function report(acc, opts) {
  const gain = (m, r) => (r > 0 ? round((1 - m / r) * 100, 1) : null);
  const x12 = acc.x12;
  const marches = EVAL.map((mk, i) => {
    const a = acc.markets[i];
    // Pente de calibration : régression du résultat (0 ou 1) sur la probabilité annoncée. 1 = probabilités justes ;
    // moins de 1 = annonces trop tranchées (trop proches de 0 % ou de 100 %) ; plus de 1 = trop prudentes.
    const meanP = a.n ? a.sp / a.n : 0;
    const meanY = a.n ? a.sy / a.n : 0;
    const varP = a.n ? a.sp2 / a.n - meanP * meanP : 0;
    const covPY = a.n ? a.spy / a.n - meanP * meanY : 0;
    return {
      marche: mk.label,
      matchs: a.n,
      probabiliteMoyenne: a.n ? round(a.sp / a.n, 3) : null,
      frequenceReelle: a.n ? round(a.sy / a.n, 3) : null,
      pente: a.n && varP > 1e-9 ? round(covPY / varP, 3) : null,
      brierModele: a.n ? round(a.bm / a.n, 4) : null,
      brierReference: a.n ? round(a.br / a.n, 4) : null,
      gainBrierPct: a.n ? gain(a.bm, a.br) : null,
      logLossModele: a.n ? round(a.lm / a.n, 4) : null,
      logLossReference: a.n ? round(a.lr / a.n, 4) : null,
    };
  });
  const calibration = acc.bins
    .map((b, i) => ({ tranche: `${i * 10}-${i * 10 + 10} %`, matchs: b.n, probabilitePredite: b.n ? round(b.sp / b.n, 3) : null, frequenceObservee: b.n ? round(b.sy / b.n, 3) : null }))
    .filter((b) => b.matchs > 0);
  const gain1x2 = x12.n ? gain(x12.bm, x12.br) : null;
  const hitRate = acc.picks.n ? acc.picks.hits / acc.picks.n : null;
  const predicted = acc.picks.n ? acc.picks.sp / acc.picks.n : null;
  return {
    parametres: {
      jours: opts.evalDays,
      pasEnJours: opts.stepDays,
      modele: {
        demiVieJours: opts.model.halfLifeDays,
        matchsAPriori: opts.model.priorMatches,
        rho: opts.model.rho,
        niveauDemiVieJours: opts.model.levelHalfLifeDays || null,
        niveauMatchsAPriori: opts.model.levelHalfLifeDays ? opts.model.levelPriorMatches : null,
        exposantDesForces: opts.model.strengthExponent,
        exposantForce: opts.model.qualityExponent || null,
        exposantRythme: opts.model.rhythmExponent || null,
        coefficientDeNiveau: opts.model.levelFactor,
      },
    },
    matchsEvalues: acc.matches,
    periode: acc.matches ? { du: new Date(acc.first).toISOString().slice(0, 10), au: new Date(acc.last).toISOString().slice(0, 10) } : null,
    resultat1N2: x12.n ? { brierModele: round(x12.bm / x12.n, 4), brierReference: round(x12.br / x12.n, 4), gainPct: gain1x2 } : null,
    marches,
    calibration,
    paris: acc.picks.n
      ? {
          description: "Pari choisi automatiquement pour chaque match (le plus fiable : le plus probable de tous les types de paris, quelle que soit sa cote)",
          matchs: acc.picks.n,
          probabiliteMoyennePredite: round(predicted, 3),
          tauxDeReussiteReel: round(hitRate, 3),
          ecart: round(hitRate - predicted, 3),
        }
      : null,
    // Buts par match : prévus par le modèle et réellement marqués. Un écart durable fausse « plus de 2.5 buts », « les deux équipes marquent »…
    butsParMatch: acc.goals.n
      ? {
          prevus: round(acc.goals.pred / acc.goals.n, 3),
          reels: round(acc.goals.real / acc.goals.n, 3),
          // Dispersion des buts réellement marqués : sert à juger si l'écart entre prévus et réels est significatif.
          ecartTypeReels: round(Math.sqrt(Math.max(0, acc.goals.real2 / acc.goals.n - (acc.goals.real / acc.goals.n) ** 2)), 3),
        }
      : null,
    parChampionnat: [...acc.byLeague.entries()].map(([key, v]) => ({
      championnat: key,
      matchs: v.n,
      gainBrier1N2Pct: v.n ? gain(v.bm, v.br) : null,
      butsPrevus: v.n ? round(v.goalsPred / v.n, 2) : null,
      butsReels: v.n ? round(v.goalsReal / v.n, 2) : null,
    })),
    lecture: !acc.matches
      ? "Pas assez de matchs joués pour mesurer la fiabilité."
      : `Sur ${acc.matches} matchs récents rejoués pas à pas, le modèle ${gain1x2 > 0 ? "fait mieux" : "ne fait pas mieux"} que la référence (fréquences moyennes du championnat) de ${Math.abs(gain1x2)} % sur le résultat 1-N-2` +
        (hitRate !== null ? `, et les paris choisis automatiquement se sont réalisés dans ${Math.round(hitRate * 100)} % des cas pour ${Math.round(predicted * 100)} % annoncés.` : "."),
  };
}

const defer = () => new Promise((resolve) => setImmediate(resolve));

function prepare({ now = Date.now(), evalDays = 120, stepDays = 7, minTrain = 120, model, pick = true } = {}) {
  return {
    now,
    evalDays,
    stepDays,
    minTrain,
    model: { halfLifeDays: 300, priorMatches: 10, rho: -0.08, maxGoals: 9, levelHalfLifeDays: 0, levelPriorMatches: 40, strengthExponent: 1, levelFactor: 1, ...model },
    pick: Boolean(pick),
  };
}

// leagues : [{ key, finished }] ; model : { halfLifeDays, priorMatches, rho, maxGoals }
function runBacktest(leagues, options) {
  const opts = prepare(options);
  const acc = newAcc();
  for (const l of leagues) runLeague(acc, l.key, l.finished, opts);
  return report(acc, opts);
}

// Même calcul, mais en laissant respirer le serveur entre deux championnats.
async function runBacktestAsync(leagues, options, yieldFn = defer) {
  const opts = prepare(options);
  const acc = newAcc();
  for (const l of leagues) {
    runLeague(acc, l.key, l.finished, opts);
    await yieldFn();
  }
  return report(acc, opts);
}

// Réglage automatique : essaie plusieurs réglages du modèle sur les matchs récents (tous championnats
// confondus) et garde le meilleur, à condition qu'il fasse nettement mieux que le réglage actuel.
async function tuneModel(leagues, { now = Date.now(), current, grid, model = {}, evalDays = 150, stepDays = 14, minGain = 0.003, yieldFn = defer } = {}) {
  const candidates = [];
  for (const halfLifeDays of grid.halfLifeDays) {
    for (const priorMatches of grid.priorMatches) {
      const r = await runBacktestAsync(leagues, { now, evalDays, stepDays, pick: false, model: { ...model, halfLifeDays, priorMatches } }, yieldFn);
      if (r.resultat1N2) candidates.push({ halfLifeDays, priorMatches, brier1N2: r.resultat1N2.brierModele, matchs: r.matchsEvalues });
    }
  }
  if (!candidates.length) return { changed: false, raison: "pas assez de matchs pour comparer des réglages", candidats: [], retenu: current };
  const sameAsCurrent = (c) => c.halfLifeDays === current.halfLifeDays && c.priorMatches === current.priorMatches;
  const best = candidates.reduce((a, b) => (b.brier1N2 < a.brier1N2 ? b : a));
  const cur = candidates.find(sameAsCurrent);
  const better = !cur || best.brier1N2 < cur.brier1N2 * (1 - minGain);
  const retenu = better ? { halfLifeDays: best.halfLifeDays, priorMatches: best.priorMatches } : current;
  return {
    changed: better && !sameAsCurrent(best),
    raison: better ? "réglage nettement meilleur sur les matchs récents" : "le réglage actuel reste le meilleur ou équivalent",
    candidats: candidates,
    retenu,
    matchsEvalues: best.matchs,
  };
}

module.exports = { runBacktest, runBacktestAsync, tuneModel, EVAL_LABELS };
