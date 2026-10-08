"use strict";

const { norm } = require("./util");
const { scoreMatrix } = require("./model");

// Tous les types de paris reconnus, calculés à partir de la même matrice de scores :
// les probabilités sont donc cohérentes entre elles (ex. « plus de 2.5 » + « moins de 2.5 » = 100 %).
const MARKETS = [];
const BY_NAME = new Map();

function add(label, test, aliases = []) {
  const market = { label, test };
  MARKETS.push(market);
  for (const name of [label, ...aliases]) BY_NAME.set(norm(name), market);
}

add("Victoire domicile", (h, a) => h > a, ["Victoire equipe 1", "V1", "1", "Victoire dom"]);
add("Victoire extérieur", (h, a) => a > h, ["Victoire exterieur", "Victoire equipe 2", "V2", "2", "Victoire ext"]);
add("Match nul", (h, a) => h === a, ["Nul", "X"]);
add("Victoire ou nul domicile", (h, a) => h >= a, ["Victoire ou nul equipe 1", "1X", "Double chance 1X"]);
add("Victoire ou nul extérieur", (h, a) => a >= h, ["Victoire ou nul exterieur", "Victoire ou nul equipe 2", "X2", "2X", "Double chance X2"]);
add("Victoire domicile ou extérieur", (h, a) => h !== a, ["12", "Pas de match nul", "Double chance 12"]);

for (const n of [0.5, 1.5, 2.5, 3.5]) {
  const extra = n === 1.5 ? ["Total buts 1.5 plus"] : [];
  add(`Plus de ${n} buts`, (h, a) => h + a > n, [`Plus de ${n} but`, ...extra]);
  add(`Moins de ${n} buts`, (h, a) => h + a < n, [`Moins de ${n} but`]);
}

add("Les deux équipes marquent", (h, a) => h > 0 && a > 0, ["Les deux equipes marquent - Oui", "BTTS", "BTTS Oui"]);
add("Les deux équipes ne marquent pas", (h, a) => h === 0 || a === 0, ["Les deux equipes marquent - Non", "BTTS Non"]);

for (const n of [0.5, 1.5, 2.5]) {
  add(`Equipe domicile ${n} buts plus`, (h) => h > n, [`Equipe 1 plus de ${n} but`, `Equipe 1 plus de ${n} buts`]);
  add(`Equipe extérieur ${n} buts plus`, (h, a) => a > n, [`Equipe 2 plus de ${n} but`, `Equipe 2 plus de ${n} buts`, `Equipe exterieur ${n} buts plus`]);
}
for (const n of [0.5, 1.5, 2.5]) {
  add(`Victoire/nul domicile + ${n} buts plus`, (h, a) => h >= a && h + a > n, [`1X et plus de ${n} buts`]);
  add(`Victoire/nul extérieur + ${n} buts plus`, (h, a) => a >= h && h + a > n, [`2X et plus de ${n} buts`, `Victoire/nul exterieur + ${n} buts plus`]);
}
for (const n of [1.5, 2.5]) {
  add(`Victoire domicile + ${n} buts plus`, (h, a) => h > a && h + a > n, [`V1 et plus de ${n} buts`]);
  add(`Victoire extérieur + ${n} buts plus`, (h, a) => a > h && h + a > n, [`V2 et plus de ${n} buts`, `Victoire exterieur + ${n} buts plus`]);
}

// « Score exact » sans score précis : on évalue le score le plus probable.
const EXACT = { label: "Score exact", exact: true };
BY_NAME.set(norm("Score exact"), EXACT);

function resolveMarket(text) {
  if (typeof text !== "string") return null;
  return BY_NAME.get(norm(text)) || null;
}

function evaluate(matrix, market) {
  if (market.exact) {
    let best = { p: 0, h: 0, a: 0 };
    matrix.forEach((row, h) => row.forEach((p, a) => p > best.p && (best = { p, h, a })));
    return { p: best.p, detail: `${best.h}-${best.a}` };
  }
  let p = 0;
  matrix.forEach((row, h) => row.forEach((v, a) => market.test(h, a) && (p += v)));
  return { p };
}

function evaluateAll(matrix) {
  return MARKETS.map((m) => ({ label: m.label, p: evaluate(matrix, m).p }));
}

// Probabilités « moyennes » d'un match de championnat, utilisées quand on ne connaît pas les équipes.
const GENERIC = scoreMatrix(1.5, 1.15);
const baseRate = (market) => evaluate(GENERIC, market).p;

module.exports = { MARKETS, resolveMarket, evaluate, evaluateAll, baseRate };
