"use strict";

const { MARKETS } = require("./markets");

// Choix des paris du « Top Matchs » et du mode « Auto » : pour chaque match, le pari le plus probable, donc le plus fiable,
// QUELLE QUE SOIT SA COTE (aucune cote minimale ni cote visée, aucune plage de probabilité). Les cotes affichées sont des cotes
// équitables estimées (1 ÷ probabilité), pas celles d'un bookmaker.

const ORDER = new Map(MARKETS.map((m, i) => [m.label, i]));
const complexity = (label) => (ORDER.has(label) ? ORDER.get(label) : 999);

// Pari le plus probable d'un match ; à probabilité égale (paris équivalents, comme « plus de 0.5 buts » et « au moins une équipe marque
// plus de 0.5 buts »), celui qui ne peut pas être remboursé, puis le plus simple. `maxP` (facultatif) plafonne la probabilité des paris
// retenus (PICK_MAX_PROBABILITY) ; `minP` (facultatif) en fixe un plancher.
const refundable = (x) => (x.push > 0 ? 1 : 0);
function bestForFixture(probs, { minP = 0, maxP = 1 } = {}) {
  const pool = probs.filter((x) => x.p >= minP && x.p <= maxP);
  if (!pool.length) return null;
  return pool.reduce((best, x) => {
    if (x.p > best.p + 1e-9) return x;
    if (Math.abs(x.p - best.p) > 1e-9) return best;
    if (refundable(x) !== refundable(best)) return refundable(x) < refundable(best) ? x : best;
    return complexity(x.label) < complexity(best.label) ? x : best;
  });
}

// Les `count` matchs dont le meilleur pari est le plus probable (un seul pari par match, donc des matchs différents).
// fixtures : [{ id, kickoff, quality: 0|1|2, best: { label, p } }]. Des équipes bien connues du modèle (quality) départagent des
// probabilités voisines : un point de probabilité par niveau.
function selectTop(fixtures, { count = 3 } = {}) {
  return fixtures
    .filter((f) => f.best)
    .map((f) => ({ f, score: f.best.p + 0.01 * f.quality }))
    .sort((a, b) => b.score - a.score || a.f.kickoff - b.f.kickoff)
    .slice(0, count)
    .map(({ f }) => f);
}

module.exports = { bestForFixture, selectTop };
