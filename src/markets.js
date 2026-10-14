"use strict";

const { norm } = require("./util");
const { scoreMatrix } = require("./model");

// Tous les types de paris reconnus, calculés à partir de la même matrice de scores :
// les probabilités sont donc cohérentes entre elles (ex. « plus de 2.5 » + « moins de 2.5 » = 100 %).
const MARKETS = [];
const BY_NAME = new Map();

// `test(h, a)` dit quand le pari est GAGNÉ (h = buts de l'équipe 1, à domicile ; a = buts de l'équipe 2, à l'extérieur).
// `refund` (facultatif) décrit les paris à LIGNE ENTIÈRE, comme chez les bookmakers : « plus de 2 buts » est gagné à 3 buts ou plus,
// perdu à 1 but ou moins et REMBOURSÉ à 2 buts pile. { test(h, a), line, subject } : `test` dit quand la mise est remboursée,
// `subject` ce qui est compté (« total », « home » ou « away »). La probabilité d'un pari reste celle de le gagner.
function add(label, test, aliases = [], refund = null) {
  const market = { label, test, refund };
  MARKETS.push(market);
  for (const name of [label, ...aliases]) {
    const key = norm(name);
    const known = BY_NAME.get(key);
    if (known && known !== market) throw new Error(`Nom de pari en double : « ${name} » (${known.label} et ${label})`);
    BY_NAME.set(key, market);
  }
  return market;
}

// ---------- Aides pour écrire les familles de paris sur les buts ----------

const but = (n) => `${n} ${n === 1 ? "but" : "buts"}`; // « 1 but », « 2.5 buts »
// Écritures acceptées pour une saisie libre : avec ou sans « s » (« plus de (1.5) but » et « plus de 1.5 buts » sont reconnus).
const forms = (prefixes, dir, n) => prefixes.flatMap((p) => [`${n} but`, `${n} buts`].map((b) => `${p ? `${p} ` : ""}${dir} ${b}`));

const COUNT = {
  total: (h, a) => h + a,
  home: (h) => h,
  away: (h, a) => a,
  best: (h, a) => Math.max(h, a),
};
const OVER = (count, n) => (h, a) => count(h, a) > n;
const UNDER = (count, n) => (h, a) => count(h, a) < n;
// Seules les lignes entières (1, 2, 3…) ont un remboursement ; une ligne à demi-but (1.5) est toujours gagnée ou perdue.
const refundOn = (subject, n) => (Number.isInteger(n) ? { test: (h, a) => COUNT[subject](h, a) === n, line: n, subject } : null);

const TOTAL_PREFIXES = ["", "Total", "Total buts", "Total de but dans le match", "Total de buts dans le match"];
const SIDES = [
  { key: "home", name: "domicile", num: 1, count: COUNT.home, prefixes: ["Equipe 1", "Total equipe 1", "Total but equipe 1", "Total buts equipe 1"] },
  { key: "away", name: "extérieur", num: 2, count: COUNT.away, prefixes: ["Equipe 2", "Total equipe 2", "Total but equipe 2", "Total buts equipe 2"] },
];
const RESULTS = [
  { key: "V1", name: "Victoire domicile", side: SIDES[0], test: (h, a) => h > a },
  { key: "1X", name: "Victoire/nul domicile", side: SIDES[0], test: (h, a) => h >= a },
  { key: "V2", name: "Victoire extérieur", side: SIDES[1], test: (h, a) => a > h },
  { key: "2X", name: "Victoire/nul extérieur", side: SIDES[1], test: (h, a) => a >= h },
];

// ---------- Résultat du match ----------

add("Victoire domicile", (h, a) => h > a, ["Victoire equipe 1", "V1", "1", "Victoire dom"]);
add("Victoire extérieur", (h, a) => a > h, ["Victoire exterieur", "Victoire equipe 2", "V2", "2", "Victoire ext"]);
add("Match nul", (h, a) => h === a, ["Nul", "X"]);
add("Victoire ou nul domicile", (h, a) => h >= a, ["Victoire ou nul equipe 1", "1X", "Double chance 1X"]);
add("Victoire ou nul extérieur", (h, a) => a >= h, ["Victoire ou nul exterieur", "Victoire ou nul equipe 2", "X2", "2X", "Double chance X2"]);
add("Victoire domicile ou extérieur", (h, a) => h !== a, ["12", "Pas de match nul", "Double chance 12"]);

// ---------- Total de buts du match ----------

for (const n of [0.5, 1.5, 2.5, 3.5]) {
  add(`Plus de ${n} buts`, OVER(COUNT.total, n), [...forms(TOTAL_PREFIXES, "plus de", n), ...(n === 1.5 ? ["Total buts 1.5 plus"] : [])]);
  add(`Moins de ${n} buts`, UNDER(COUNT.total, n), forms(TOTAL_PREFIXES, "moins de", n));
}

add("Les deux équipes marquent", (h, a) => h > 0 && a > 0, ["Les deux equipes marquent - Oui", "BTTS", "BTTS Oui"]);
add("Les deux équipes ne marquent pas", (h, a) => h === 0 || a === 0, ["Les deux equipes marquent - Non", "BTTS Non"]);

// ---------- Total de buts d'une équipe : « plus de » (anciennes écritures « Equipe domicile 1.5 buts plus ») ----------

for (const n of [0.5, 1.5, 2.5]) {
  for (const s of SIDES) add(`Equipe ${s.name} ${n} buts plus`, OVER(s.count, n), forms(s.prefixes, "plus de", n));
}

// ---------- Résultat + total de buts du match (anciennes écritures « Victoire/nul domicile + 1.5 buts plus ») ----------

const resultAliases = (r, dir, n) => forms([`${r.key} et`], dir, n);
for (const n of [0.5, 1.5, 2.5]) {
  add(`Victoire/nul domicile + ${n} buts plus`, (h, a) => h >= a && h + a > n, resultAliases(RESULTS[1], "plus de", n));
  add(`Victoire/nul extérieur + ${n} buts plus`, (h, a) => a >= h && h + a > n, [...resultAliases(RESULTS[3], "plus de", n), `Victoire/nul exterieur + ${n} buts plus`]);
}
for (const n of [1.5, 2.5]) {
  add(`Victoire domicile + ${n} buts plus`, (h, a) => h > a && h + a > n, resultAliases(RESULTS[0], "plus de", n));
  add(`Victoire extérieur + ${n} buts plus`, (h, a) => a > h && h + a > n, [...resultAliases(RESULTS[2], "plus de", n), `Victoire exterieur + ${n} buts plus`]);
}

// ---------- Plus de paris (liste de l'application) ----------

// Total de buts du match à ligne entière : remboursé quand le total tombe pile sur la ligne.
for (const n of [1, 2, 3]) {
  add(`Plus de ${but(n)}`, OVER(COUNT.total, n), forms(TOTAL_PREFIXES, "plus de", n), refundOn("total", n));
  add(`Moins de ${but(n)}`, UNDER(COUNT.total, n), forms(TOTAL_PREFIXES, "moins de", n), refundOn("total", n));
}

// Total de buts d'une équipe : « plus de » aux lignes entières, et tous les « moins de ».
for (const s of SIDES) {
  for (const n of [1, 2]) {
    add(`Equipe ${s.name} plus de ${but(n)}`, OVER(s.count, n), [...forms(s.prefixes, "plus de", n), `Equipe ${s.name} ${n} but plus`, `Equipe ${s.name} ${n} buts plus`], refundOn(s.key, n));
  }
  for (const n of [0.5, 1, 1.5, 2, 2.5]) {
    add(`Equipe ${s.name} moins de ${but(n)}`, UNDER(s.count, n), forms(s.prefixes, "moins de", n), refundOn(s.key, n));
  }
}

// Résultat + total de buts du match : les lignes manquantes (le « plus de 0.5 » d'une victoire, les « plus de 3.5 », tous les « moins de »).
const NEW_OVER = { V1: [0.5, 3.5], "1X": [3.5], V2: [0.5, 3.5], "2X": [3.5] };
for (const r of RESULTS) {
  for (const n of NEW_OVER[r.key]) add(`${r.name} + ${n} buts plus`, (h, a) => r.test(h, a) && h + a > n, resultAliases(r, "plus de", n));
  for (const n of [1.5, 2.5, 3.5]) add(`${r.name} + moins de ${n} buts`, (h, a) => r.test(h, a) && h + a < n, resultAliases(r, "moins de", n));
}

// « Au moins une équipe va marquer plus de X buts » : la meilleure des deux attaques dépasse la ligne.
for (const n of [0.5, 1.5, 2.5, 3.5]) {
  add(`Au moins une équipe plus de ${n} buts`, OVER(COUNT.best, n), forms(["Au moins une equipe va marquer", "Au moins une equipe marque", "Au moins une equipe"], "plus de", n));
}

// Résultat + total de buts de l'équipe concernée (V1 et 1X avec l'équipe 1, V2 et 2X avec l'équipe 2).
for (const r of RESULTS) {
  const s = r.side;
  const teamAliases = (dir, n) => forms([`${r.key} et Total ${s.num}`, `${r.key} et Total equipe ${s.num}`], dir, n);
  for (const n of [0.5, 1.5, 2.5, 3.5]) add(`${r.name} + Equipe ${s.name} ${n} buts plus`, (h, a) => r.test(h, a) && s.count(h, a) > n, teamAliases("plus de", n));
  for (const n of [1.5, 2.5, 3.5]) add(`${r.name} + Equipe ${s.name} moins de ${n} buts`, (h, a) => r.test(h, a) && s.count(h, a) < n, teamAliases("moins de", n));
}

// « Score exact » sans score précis : on évalue le score le plus probable.
const EXACT = { label: "Score exact", exact: true };
BY_NAME.set(norm("Score exact"), EXACT);

function resolveMarket(text) {
  if (typeof text !== "string") return null;
  return BY_NAME.get(norm(text)) || null;
}

// Cases de la matrice à plat [buts équipe 1, buts équipe 2, probabilité, …] : une seule lecture pour tous les paris.
function cellsOf(matrix) {
  const cells = [];
  matrix.forEach((row, h) => row.forEach((v, a) => cells.push(h, a, v)));
  return cells;
}

function sum(cells, market) {
  let p = 0;
  let push = 0;
  const refund = market.refund;
  for (let i = 0; i < cells.length; i += 3) {
    if (market.test(cells[i], cells[i + 1])) p += cells[i + 2];
    else if (refund && refund.test(cells[i], cells[i + 1])) push += cells[i + 2];
  }
  return refund ? { p, push } : { p };
}

// Un pari à ligne entière renvoie aussi `push` : la probabilité d'être remboursé.
function evaluate(matrix, market) {
  if (market.exact) {
    let best = { p: 0, h: 0, a: 0 };
    matrix.forEach((row, h) => row.forEach((p, a) => p > best.p && (best = { p, h, a })));
    return { p: best.p, detail: `${best.h}-${best.a}` };
  }
  return sum(cellsOf(matrix), market);
}

// `refund: true` marque les paris à ligne entière (avec `push`) : on ne les compare pas aux autres pour choisir « le plus fiable ».
function evaluateAll(matrix) {
  const cells = cellsOf(matrix);
  return MARKETS.map((m) => {
    const ev = sum(cells, m);
    return m.refund ? { label: m.label, p: ev.p, push: ev.push, refund: true } : { label: m.label, p: ev.p };
  });
}

// Lecture d'une matrice de scores : probabilité de chaque pari, résultats principaux et score le plus probable.
function describeMatrix(matrix) {
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
  return { probs, outcomes, likelyScore: exact.detail, likelyScoreP: exact.p };
}

// Règle de remboursement d'un pari à ligne entière, en français (null pour les autres paris).
function refundRule(market, home, away) {
  const r = market && market.refund;
  if (!r) return null;
  const who = r.subject === "total" ? "le match se termine avec exactement" : `${r.subject === "home" ? home : away} marque exactement`;
  return `Si ${who} ${but(r.line)}, la mise est remboursée (ni gagnée, ni perdue).`;
}

// Probabilités « moyennes » d'un match de championnat, utilisées quand on ne connaît pas les équipes.
const GENERIC = scoreMatrix(1.5, 1.15);
const baseRate = (market) => evaluate(GENERIC, market).p;

module.exports = { MARKETS, resolveMarket, evaluate, evaluateAll, describeMatrix, baseRate, refundRule };
