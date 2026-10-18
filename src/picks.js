"use strict";

const { round } = require("./util");
const { MARKETS } = require("./markets");

// Choix des paris du « Top Matchs » et du mode « Auto » : un pari par match, tel que la COTE TOTALE du coupon atteigne l'objectif (5 par
// défaut) avec des paris aussi fiables que possible. Les cotes sont des cotes équitables estimées (1 ÷ probabilité), pas celles d'un
// bookmaker.
//
// Le calcul impose son compromis : une cote totale de 5 correspond à une probabilité combinée d'environ 20 %. Avec 4 matchs, cela fait en
// moyenne 67 % de chances par pari (0,2 puissance 1/4). Les paris les plus fiables possibles sont donc ceux qui se ressemblent tous :
// ni un pari quasi certain qui obligerait les autres à être des pièces à pile ou face, ni l'inverse. On cherche donc d'abord à relever le
// pari le plus faible du coupon, puis on utilise la marge restante pour que la cote totale reste juste au-dessus de l'objectif.

const ORDER = new Map(MARKETS.map((m, i) => [m.label, i]));
const complexity = (label) => (ORDER.has(label) ? ORDER.get(label) : 999);
const refundable = (x) => (x.push > 0 ? 1 : 0);
const EPS = 1e-9;

// À probabilité voisine : le pari qui ne peut pas être remboursé, puis le plus simple.
const preferable = (a, b) => (refundable(a) !== refundable(b) ? refundable(a) < refundable(b) : complexity(a.label) < complexity(b.label));

// Probabilité de chacun des `count` paris d'un coupon équilibré qui atteint exactement la cote `targetOdds` : (1 ÷ cote) puissance 1/count.
const legTarget = (targetOdds, count) => Math.pow(1 / targetOdds, 1 / Math.max(1, count));

// Paris candidats d'un match : ceux dont la probabilité est dans la plage voulue, sans quasi-doublons (dans un groupe de probabilités à
// moins de `gap` l'une de l'autre, on garde le pari qui ne peut pas être remboursé, puis le plus simple). S'il en reste plus de `max`, on
// garde ceux qui sont les plus proches de `around` (la probabilité visée), ou à défaut un échantillon régulier. Triés par probabilité.
function thinLegs(probs, { minP = 0, maxP = 1, around = null, max = 8, gap = 0.02 } = {}) {
  const inRange = probs.filter((x) => x.p >= minP - EPS && x.p <= maxP + EPS).sort((a, b) => a.p - b.p || (preferable(a, b) ? -1 : 1));
  const groups = [];
  for (const leg of inRange) {
    const last = groups[groups.length - 1];
    if (last && leg.p - last[0].p < gap) last.push(leg);
    else groups.push([leg]);
  }
  let legs = groups.map((g) => g.reduce((best, x) => (preferable(x, best) ? x : best)));
  if (legs.length > max) {
    if (around === null) {
      const step = (legs.length - 1) / (max - 1);
      legs = Array.from({ length: max }, (_, i) => legs[Math.round(i * step)]);
    } else {
      legs = legs
        .map((x) => ({ x, d: Math.abs(x.p - around) }))
        .sort((a, b) => a.d - b.d || a.x.p - b.x.p)
        .slice(0, max)
        .map(({ x }) => x)
        .sort((a, b) => a.p - b.p);
    }
  }
  return legs;
}

// Un pari par match (sets[i] : paris candidats du match i, triés par probabilité croissante) dont le produit des probabilités ne dépasse
// pas `maxJoint` (c'est-à-dire dont la cote totale atteint l'objectif). Parmi eux : le pari le plus faible le plus fort possible, puis,
// en relevant les paris les plus faibles d'abord, un produit le plus proche possible de `maxJoint`. Rend les rangs choisis, ou null si
// l'objectif est hors d'atteinte avec ces candidats.
function fitLegs(sets, maxJoint) {
  const n = sets.length;
  if (!n || sets.some((s) => !s.length)) return null;
  const thresholds = [...new Set(sets.flatMap((s) => s.map((l) => l.p)))].sort((a, b) => b - a);
  let rank = null;
  let joint = 1;
  for (const floor of thresholds) {
    const trial = new Array(n);
    let product = 1;
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      const k = sets[i].findIndex((l) => l.p >= floor - EPS);
      if (k < 0) ok = false;
      else {
        trial[i] = k;
        product *= sets[i][k].p;
      }
    }
    if (ok && product <= maxJoint + EPS) {
      rank = trial;
      joint = product;
      break;
    }
  }
  if (!rank) return null;
  for (;;) {
    let raised = false;
    const order = rank.map((k, i) => i).sort((a, b) => sets[a][rank[a]].p - sets[b][rank[b]].p || a - b);
    for (const i of order) {
      const next = sets[i][rank[i] + 1];
      if (!next) continue;
      const product = (joint / sets[i][rank[i]].p) * next.p;
      if (product <= maxJoint + EPS) {
        rank[i]++;
        joint = product;
        raised = true;
        break;
      }
    }
    if (!raised) break;
  }
  return { rank, joint };
}

const productOf = (legs) => legs.reduce((acc, l) => acc * l.p, 1);
const resultOf = (legs, extra) => {
  const joint = productOf(legs);
  return { legs, joint, fairOdds: joint > 0 ? round(1 / joint, 2) : 0, ...extra };
};

// Seuils de probabilité minimale d'un pari, du plus exigeant au plus souple : le seuil demandé, puis 5 points de moins (jamais sous 50 %).
// On ne descend au second que si l'objectif de cote est hors d'atteinte avec le premier (par exemple 3 matchs seulement : 0,2 puissance
// 1/3 = 58 % par pari, sous un plancher de 60 %).
const floorsOf = (minP) => (Array.isArray(minP) ? minP : [minP, Math.max(0.5, round(minP - 0.05, 3))]).filter((f, i, all) => all.indexOf(f) === i);

// Le pari le moins probable d'un match qui reste fiable (au moins `minP`, au plus `maxP`) : le plus près d'un objectif de cote élevé. À probabilité
// égale : le non remboursable, puis le plus simple. Sans pari dans la plage, le moins probable de tous.
function lowestLeg(probs, minP, maxP) {
  const pool = probs.filter((x) => x.p >= minP - EPS && x.p <= maxP + EPS);
  return (pool.length ? pool : probs).reduce((best, x) => (x.p < best.p - EPS || (Math.abs(x.p - best.p) <= EPS && preferable(x, best)) ? x : best));
}

// Mode « Auto » : un pari pour CHAQUE match de la liste (fixtures : [{ probs: [{ label, p, push? }] }]), de façon que la cote totale
// atteigne `targetOdds`. Si l'objectif est hors d'atteinte avec des paris d'au moins 55 %, on prend, pour chaque match, le pari le moins
// probable qui reste fiable (au moins 55 %) : le plus près possible de l'objectif, signalé par `targetReached: false`.
function selectAll(fixtures, { targetOdds = 5, minP = 0.6, maxP = 0.88, maxLegs = 8, gap = 0.02 } = {}) {
  const n = fixtures.length;
  if (!n) return resultOf([], { targetReached: false });
  const around = legTarget(targetOdds, n);
  const maxJoint = 1 / targetOdds;
  const floors = floorsOf(minP);
  for (const floor of floors) {
    const sets = fixtures.map((f) => thinLegs(f.probs, { minP: floor, maxP, around, max: maxLegs, gap }));
    const fit = fitLegs(sets, maxJoint);
    if (fit) return resultOf(fit.rank.map((k, i) => sets[i][k]), { targetReached: true, floor });
  }
  return resultOf(fixtures.map((f) => lowestLeg(f.probs, floors[floors.length - 1], maxP)), { targetReached: false, floor: floors[floors.length - 1] });
}

// Combinaisons de k éléments parmi n (indices croissants), dans l'ordre.
function* combinations(n, k) {
  const idx = Array.from({ length: k }, (_, i) => i);
  if (k > n) return;
  for (;;) {
    yield idx;
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

// Mode « Top Matchs » : parmi les matchs à venir, `count` matchs différents (un pari chacun) dont la cote totale atteint `targetOdds`.
// fixtures : [{ id, leagueKey, kickoff, quality: 0|1|2, probs: [{ label, p, push? }] }].
// Parmi les combinaisons qui atteignent l'objectif : des paris équilibrés (le plus faible aussi fort que possible), une probabilité
// combinée juste sous la limite, des équipes bien connues du modèle et des championnats variés. Si aucune ne l'atteint, la plus proche.
// Les matchs bien connus du modèle passent en premier, puis les plus proches dans le temps ; on n'étudie que les `maxFixtures` premiers.
function selectCoupon(fixtures, { count = 4, targetOdds = 5, minP = 0.6, maxP = 0.88, maxFixtures = 18, maxLegs = 8, gap = 0.02 } = {}) {
  const usable = fixtures.filter((f) => f.probs && f.probs.length);
  const wanted = Math.min(count, usable.length);
  if (!wanted) return resultOf([], { targetReached: false });
  const maxJoint = 1 / targetOdds;
  const around = legTarget(targetOdds, wanted);
  const order = (a, b) => b.quality - a.quality || a.kickoff - b.kickoff;
  const floors = floorsOf(minP);

  for (const floor of floors) {
    const pool = usable
      .map((f) => ({ f, legs: thinLegs(f.probs, { minP: floor, maxP, around, max: maxLegs, gap }) }))
      .filter((x) => x.legs.length)
      .sort((a, b) => order(a.f, b.f))
      .slice(0, maxFixtures);
    if (pool.length < wanted) continue;
    let best = null;
    for (const combo of combinations(pool.length, wanted)) {
      const chosen = combo.map((i) => pool[i]);
      const fit = fitLegs(chosen.map((c) => c.legs), maxJoint);
      if (!fit) continue;
      const legs = fit.rank.map((k, i) => chosen[i].legs[k]);
      const minLeg = Math.min(...legs.map((l) => l.p));
      const quality = Math.min(...chosen.map((c) => c.f.quality));
      const leagues = new Set(chosen.map((c) => c.f.leagueKey)).size;
      // Probabilité combinée d'abord ; à égalité, des paris équilibrés, des équipes bien connues et des championnats variés.
      const objective = fit.joint + 0.3 * minLeg + 0.01 * quality + 0.005 * leagues;
      if (!best || objective > best.objective + 1e-12) best = { objective, chosen, legs };
    }
    if (best) {
      const sorted = best.chosen.map((c, i) => ({ fixture: c.f, ...best.legs[i] })).sort((a, b) => a.fixture.kickoff - b.fixture.kickoff);
      return resultOf(sorted, { targetReached: true, floor });
    }
  }

  // Objectif hors d'atteinte : les `wanted` matchs dont le pari le moins probable (mais fiable, au moins le dernier seuil) est le plus bas.
  const last = floors[floors.length - 1];
  const lows = usable
    .map((f) => ({ f, leg: lowestLeg(f.probs, last, maxP) }))
    .sort((a, b) => a.leg.p - b.leg.p || order(a.f, b.f))
    .slice(0, wanted)
    .map(({ f, leg }) => ({ fixture: f, ...leg }))
    .sort((a, b) => a.fixture.kickoff - b.fixture.kickoff);
  return resultOf(lows, { targetReached: false, floor: last });
}

// Le pari d'un match le plus proche de la probabilité `target` (à égalité : le non remboursable, puis le plus simple). Sert au contrôle de
// fiabilité : c'est le genre de pari que les modes « Top Matchs » et « Auto » retiennent.
function nearestPick(probs, target, { minP = 0, maxP = 1 } = {}) {
  let best = null;
  for (const x of probs) {
    if (x.p < minP - EPS || x.p > maxP + EPS) continue;
    if (!best) {
      best = x;
      continue;
    }
    const d = Math.abs(x.p - target);
    const db = Math.abs(best.p - target);
    if (d < db - EPS || (Math.abs(d - db) <= EPS && preferable(x, best))) best = x;
  }
  return best;
}

// Plage des paris que « Top Matchs » retient d'après la configuration (config.top) : probabilité visée pour un pari d'un coupon équilibré,
// plancher et plafond. Le contrôle de fiabilité (backtest.js) s'en sert pour mesurer des paris du même genre.
const pickWindow = (top) => ({ target: legTarget(top.targetOdds, top.count), minP: top.minLegP, maxP: top.maxLegP });

module.exports = { legTarget, thinLegs, fitLegs, selectAll, selectCoupon, nearestPick, pickWindow };
