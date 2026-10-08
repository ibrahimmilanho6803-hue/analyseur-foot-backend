"use strict";

const { round } = require("./util");
const { MARKETS } = require("./markets");

// Sélection du « Top Matchs » : trois matchs différents, une sélection par match,
// dont la cote totale (cotes équitables = 1 / probabilité) atteint l'objectif en restant
// aussi probable que possible. Ce sont des cotes estimées, pas celles d'un bookmaker.

const ORDER = new Map(MARKETS.map((m, i) => [m.label, i]));
const complexity = (label) => (ORDER.has(label) ? ORDER.get(label) : 999);

// Garde les sélections dont la probabilité est dans la plage voulue, sans doublons quasi identiques :
// dans un groupe de probabilités très proches, on garde le type de pari le plus simple.
function thinLegs(probs, { minP, maxP, max = 6, gap = 0.025 }) {
  const inRange = probs.filter((x) => x.p >= minP && x.p <= maxP).sort((a, b) => a.p - b.p);
  const groups = [];
  for (const leg of inRange) {
    const last = groups[groups.length - 1];
    if (last && leg.p - last[0].p < gap) last.push(leg);
    else groups.push([leg]);
  }
  let picks = groups.map((g) => g.reduce((best, x) => (complexity(x.label) < complexity(best.label) ? x : best)));
  if (picks.length > max) {
    const step = (picks.length - 1) / (max - 1);
    picks = Array.from({ length: max }, (_, i) => picks[Math.round(i * step)]);
  }
  return picks;
}

// fixtures : [{ id, leagueKey, kickoff, quality: 0|1|2, legs: [{ label, p }] }]
function selectCoupon(fixtures, { count = 3, targetOdds = 2.5, maxFixtures = 30 } = {}) {
  const usable = fixtures
    .filter((f) => f.legs && f.legs.length)
    .sort((a, b) => b.quality - a.quality || a.kickoff - b.kickoff)
    .slice(0, maxFixtures);
  const n = Math.min(count, usable.length);
  if (n === 0) return { legs: [], joint: 0, fairOdds: 0, targetReached: false };

  const targetJoint = 1 / targetOdds;
  const chosen = new Array(n);
  let bestReached = null;
  let bestClosest = null;

  function distinctLeagues() {
    let count = 0;
    for (let i = 0; i < n; i++) {
      let seen = false;
      for (let j = 0; j < i; j++) if (chosen[j].fixture.leagueKey === chosen[i].fixture.leagueKey) seen = true;
      if (!seen) count++;
    }
    return count;
  }

  function evaluate(joint, minLeg, quality) {
    const reached = joint <= targetJoint + 1e-9;
    // Probabilité conjointe d'abord ; à égalité, des sélections équilibrées, des championnats variés
    // et des équipes bien connues du modèle.
    const objective = joint + 0.1 * minLeg + 0.005 * distinctLeagues() + 0.01 * quality;
    if (reached) {
      if (!bestReached || objective > bestReached.objective) bestReached = { chosen: chosen.slice(), joint, objective };
    } else if (!bestClosest || joint < bestClosest.joint) {
      bestClosest = { chosen: chosen.slice(), joint, objective };
    }
  }

  function dfs(depth, start, joint, minLeg, quality) {
    if (depth === n) return evaluate(joint, minLeg, quality);
    for (let i = start; i <= usable.length - (n - depth); i++) {
      const fixture = usable[i];
      for (const leg of fixture.legs) {
        chosen[depth] = { fixture, leg };
        dfs(depth + 1, i + 1, joint * leg.p, Math.min(minLeg, leg.p), Math.min(quality, fixture.quality));
      }
    }
  }
  dfs(0, 0, 1, 1, 2);

  const best = bestReached || bestClosest;
  const legs = best.chosen
    .map((c) => ({ fixture: c.fixture, label: c.leg.label, p: c.leg.p }))
    .sort((a, b) => a.fixture.kickoff - b.fixture.kickoff);
  const fairOdds = legs.reduce((acc, l) => acc * (1 / l.p), 1);
  return { legs, joint: best.joint, fairOdds: round(fairOdds, 2), targetReached: Boolean(bestReached) };
}

// Meilleur pari d'un seul match : le plus probable dans la plage voulue (sinon le plus proche de la plage).
function bestForFixture(probs, { minP = 0.55, maxP = 0.88 } = {}) {
  const inRange = probs.filter((x) => x.p >= minP && x.p <= maxP);
  const pool = inRange.length ? inRange : probs.filter((x) => x.p < maxP);
  if (!pool.length) return null;
  return pool.reduce((best, x) => {
    if (x.p > best.p + 1e-9) return x;
    if (Math.abs(x.p - best.p) <= 1e-9 && complexity(x.label) < complexity(best.label)) return x;
    return best;
  });
}

module.exports = { thinLegs, selectCoupon, bestForFixture };
