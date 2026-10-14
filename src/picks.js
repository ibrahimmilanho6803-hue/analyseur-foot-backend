"use strict";

const { MARKETS } = require("./markets");

// Choix des paris automatiques (« Top Matchs » et « Auto »).
// Règle unique : le pari le PLUS FIABLE, c'est-à-dire le plus probable, quelle que soit sa cote. Aucune limite de cote, aucune
// plage de probabilité. Les cotes affichées sont des cotes équitables (1 ÷ probabilité), pas celles d'un bookmaker.

const ORDER = new Map(MARKETS.map((m, i) => [m.label, i]));
// Rang d'un type de pari : les plus simples (les premiers de la liste) passent avant les paris composés à probabilité égale.
const complexity = (label) => (ORDER.has(label) ? ORDER.get(label) : 999);

// Bonus de classement par niveau de données (0 faible, 1 moyen, 2 bon) : à fiabilité voisine (1 point par niveau), on préfère les
// équipes dont le modèle connaît bien les derniers matchs.
const QUALITY_BONUS = 0.01;

// Pari le plus fiable d'un seul match : le plus probable de tous les types de paris. Les paris à ligne entière (« plus de 2 buts »,
// remboursés quand le total tombe pile sur la ligne) sont écartés : leur probabilité de GAGNER ne dit pas à quel point ils sont sûrs,
// et on ne peut pas les comparer à un pari qui se gagne ou se perd. À probabilité égale, le pari le plus simple l'emporte.
function bestForFixture(probs) {
  let best = null;
  for (const x of probs) {
    if (x.refund) continue;
    if (!best || x.p > best.p + 1e-9 || (Math.abs(x.p - best.p) <= 1e-9 && complexity(x.label) < complexity(best.label))) best = x;
  }
  return best;
}

// candidates : [{ id, kickoff, quality: 0|1|2, pick: { label, p } }] (un pari par match, voir bestForFixture).
// Renvoie les `count` matchs dont le pari est le plus fiable, du plus au moins fiable. Un match ne peut y figurer qu'une fois.
function selectTop(candidates, { count = 3 } = {}) {
  const ranked = candidates
    .filter((c) => c && c.pick)
    .map((c) => ({ c, score: c.pick.p + QUALITY_BONUS * (c.quality || 0) }))
    .sort((a, b) => b.score - a.score || a.c.kickoff - b.c.kickoff);
  const seen = new Set();
  const out = [];
  for (const { c } of ranked) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length >= count) break;
  }
  return out;
}

module.exports = { bestForFixture, selectTop };
