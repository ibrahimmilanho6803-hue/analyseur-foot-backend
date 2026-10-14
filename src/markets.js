"use strict";

const { norm, round } = require("./util");
const { scoreMatrix } = require("./model");

// Tous les types de paris reconnus, calculés à partir de la même matrice de scores :
// les probabilités sont donc cohérentes entre elles (ex. « plus de 2.5 » + « moins de 2.5 » = 100 %).
//
// Équipe 1 = l'équipe qui reçoit (domicile), équipe 2 = l'équipe qui se déplace. « 1X » = victoire ou nul de l'équipe 1,
// « 2X » = victoire ou nul de l'équipe 2.
//
// Lignes entières (plus de 1, 2 ou 3 buts…) : si le nombre de buts tombe exactement sur la ligne, le pari est REMBOURSÉ (ni gagné ni
// perdu). La probabilité annoncée est alors celle de gagner quand le pari n'est pas remboursé, p = gain ÷ (1 − remboursement) : c'est
// elle qui donne la cote équitable 1 ÷ p, et le produit de plusieurs p reste la probabilité qu'un coupon dont les paris remboursés sont
// retirés soit gagné. La probabilité de remboursement est fournie à part (`push`).
const MARKETS = [];
const BY_NAME = new Map();

function register(market, names) {
  for (const name of names) {
    const key = norm(name);
    const known = BY_NAME.get(key);
    if (known && known !== market) throw new Error(`Libellé de pari en double : « ${name} » (${known.label} et ${market.label})`);
    BY_NAME.set(key, market);
  }
}

// label : nom affiché ; test(h, a) : pari gagné pour ce score (h buts de l'équipe 1, a buts de l'équipe 2) ;
// push(h, a) : pari remboursé pour ce score (lignes entières seulement) ; refundWhen : le cas du remboursement, en français.
function add(label, test, { aliases = [], push = null, refundWhen = "" } = {}) {
  const market = { label, test, push, refundWhen };
  MARKETS.push(market);
  register(market, [label, ...aliases]);
}

const but = (n) => (n === 1 ? "but" : "buts");
// Écritures acceptées pour une ligne : « plus de 1.5 but » et « plus de 1.5 buts » (singulier fréquent chez les opérateurs).
const withBut = (start, n, end = "") => [`${start} ${n} but${end}`, `${start} ${n} buts${end}`];

const LABEL = {
  HOME: "Victoire équipe 1",
  AWAY: "Victoire équipe 2",
  DRAW: "Match nul",
  OVER25: "Plus de 2.5 buts",
  BTTS: "Les deux équipes marquent",
};

// ---------- Résultat du match ----------
// short : écriture courte des opérateurs ; oldAll : écritures des anciennes versions de l'application (pour « + N buts plus »).
const RESULTS = {
  V1: { label: LABEL.HOME, test: (h, a) => h > a, short: "V1", oldAll: ["Victoire domicile"] },
  X1: { label: "Victoire ou nul équipe 1", test: (h, a) => h >= a, short: "1X", oldAll: ["Victoire/nul domicile"] },
  V2: { label: LABEL.AWAY, test: (h, a) => a > h, short: "V2", oldAll: ["Victoire extérieur", "Victoire exterieur"] },
  X2: { label: "Victoire ou nul équipe 2", test: (h, a) => a >= h, short: "2X", oldAll: ["Victoire/nul extérieur", "Victoire/nul exterieur"] },
};

add(RESULTS.V1.label, RESULTS.V1.test, { aliases: ["Victoire domicile", "Victoire dom", "V1", "1"] });
add(RESULTS.V2.label, RESULTS.V2.test, { aliases: ["Victoire extérieur", "Victoire exterieur", "Victoire ext", "V2", "2"] });
add(LABEL.DRAW, (h, a) => h === a, { aliases: ["Nul", "X"] });
add(RESULTS.X1.label, RESULTS.X1.test, { aliases: ["Victoire ou nul domicile", "1X", "Double chance 1X"] });
add(RESULTS.X2.label, RESULTS.X2.test, { aliases: ["Victoire ou nul extérieur", "Victoire ou nul exterieur", "X2", "2X", "Double chance X2"] });
add("Victoire équipe 1 ou équipe 2", (h, a) => h !== a, { aliases: ["Victoire domicile ou extérieur", "Victoire domicile ou exterieur", "12", "Pas de match nul", "Double chance 12"] });

// ---------- Total de buts du match ----------
for (const n of [0.5, 1, 1.5, 2, 2.5, 3, 3.5]) {
  const whole = Number.isInteger(n);
  const push = whole ? (h, a) => h + a === n : null;
  const refundWhen = whole ? `le match se termine avec exactement ${n} ${but(n)} au total` : "";
  add(`Plus de ${n} ${but(n)}`, (h, a) => h + a > n, { aliases: [...withBut("Plus de", n), ...(n === 1.5 ? ["Total buts 1.5 plus"] : [])], push, refundWhen });
  add(`Moins de ${n} ${but(n)}`, (h, a) => h + a < n, { aliases: withBut("Moins de", n), push, refundWhen });
}

add(LABEL.BTTS, (h, a) => h > 0 && a > 0, { aliases: ["Les deux equipes marquent - Oui", "BTTS", "BTTS Oui"] });
add("Les deux équipes ne marquent pas", (h, a) => h === 0 || a === 0, { aliases: ["Les deux equipes marquent - Non", "BTTS Non"] });

// ---------- Buts d'une équipe ----------
for (const k of [1, 2]) {
  const goals = k === 1 ? (h) => h : (h, a) => a;
  const oldName = k === 1 ? ["domicile"] : ["extérieur", "exterieur"];
  for (const n of [0.5, 1, 1.5, 2, 2.5]) {
    const whole = Number.isInteger(n);
    const push = whole ? (h, a) => goals(h, a) === n : null;
    const refundWhen = whole ? `l'équipe ${k} marque exactement ${n} ${but(n)}` : "";
    const names = (dir) => [...withBut(`Équipe ${k} ${dir} de`, n), ...withBut(`Total équipe ${k} ${dir} de`, n), ...withBut(`Total ${k} ${dir} de`, n)];
    add(`Équipe ${k} plus de ${n} ${but(n)}`, (h, a) => goals(h, a) > n, {
      aliases: [...names("plus"), ...oldName.map((o) => `Equipe ${o} ${n} buts plus`)],
      push,
      refundWhen,
    });
    add(`Équipe ${k} moins de ${n} ${but(n)}`, (h, a) => goals(h, a) < n, { aliases: names("moins"), push, refundWhen });
  }
}

// ---------- Résultat et total de buts du match ----------
const MATCH_LINES = { plus: [0.5, 1.5, 2.5, 3.5], moins: [1.5, 2.5, 3.5] };
for (const r of [RESULTS.V1, RESULTS.X1, RESULTS.V2, RESULTS.X2]) {
  for (const n of MATCH_LINES.plus) {
    add(`${r.label} et plus de ${n} buts`, (h, a) => r.test(h, a) && h + a > n, {
      aliases: [...withBut(`${r.short} et plus de`, n), ...r.oldAll.map((o) => `${o} + ${n} buts plus`)],
    });
  }
  for (const n of MATCH_LINES.moins) {
    add(`${r.label} et moins de ${n} buts`, (h, a) => r.test(h, a) && h + a < n, { aliases: withBut(`${r.short} et moins de`, n) });
  }
}
for (const n of [0.5, 1.5, 2.5, 3.5]) {
  add(`Au moins une équipe marque plus de ${n} buts`, (h, a) => Math.max(h, a) > n, {
    aliases: [...withBut("Au moins une équipe va marquer plus de", n), ...withBut("Au moins une équipe plus de", n), ...withBut("Au moins une équipe marque plus de", n)],
  });
}

// ---------- Résultat et total de buts de l'équipe ----------
for (const [k, results] of [[1, [RESULTS.V1, RESULTS.X1]], [2, [RESULTS.V2, RESULTS.X2]]]) {
  const goals = k === 1 ? (h) => h : (h, a) => a;
  for (const r of results) {
    for (const n of MATCH_LINES.plus) {
      add(`${r.label} et total équipe ${k} plus de ${n} buts`, (h, a) => r.test(h, a) && goals(h, a) > n, { aliases: withBut(`${r.short} et Total ${k} plus de`, n) });
    }
    for (const n of MATCH_LINES.moins) {
      add(`${r.label} et total équipe ${k} moins de ${n} buts`, (h, a) => r.test(h, a) && goals(h, a) < n, { aliases: withBut(`${r.short} et Total ${k} moins de`, n) });
    }
  }
}

// « Score exact » sans score précis : on évalue le score le plus probable.
const EXACT = { label: "Score exact", exact: true };
BY_NAME.set(norm("Score exact"), EXACT);

function resolveMarket(text) {
  if (typeof text !== "string") return null;
  return BY_NAME.get(norm(text)) || null;
}

// Le test de chaque score est calculé une fois pour toutes (par taille de matrice) : l'évaluation d'un pari est ensuite une simple somme.
const MASKS = new WeakMap();
function masksOf(market, rows, cols) {
  let bySize = MASKS.get(market);
  if (!bySize) MASKS.set(market, (bySize = new Map()));
  const key = rows * 1000 + cols;
  let masks = bySize.get(key);
  if (!masks) {
    const win = new Uint8Array(rows * cols);
    const push = market.push ? new Uint8Array(rows * cols) : null;
    for (let h = 0; h < rows; h++) {
      for (let a = 0; a < cols; a++) {
        if (market.test(h, a)) win[h * cols + a] = 1;
        else if (push && market.push(h, a)) push[h * cols + a] = 1;
      }
    }
    masks = { win, push };
    bySize.set(key, masks);
  }
  return masks;
}

// { p } pour un pari ordinaire. Pour un pari à ligne entière : { p, win, push } avec win = probabilité de gagner, push = probabilité
// d'être remboursé et p = win ÷ (1 − push) (voir plus haut).
function evaluate(matrix, market) {
  if (market.exact) {
    let best = { p: 0, h: 0, a: 0 };
    matrix.forEach((row, h) => row.forEach((p, a) => p > best.p && (best = { p, h, a })));
    return { p: best.p, detail: `${best.h}-${best.a}` };
  }
  const rows = matrix.length;
  const cols = rows ? matrix[0].length : 0;
  const { win, push } = masksOf(market, rows, cols);
  let w = 0;
  let u = 0;
  for (let h = 0; h < rows; h++) {
    const row = matrix[h];
    const offset = h * cols;
    for (let a = 0; a < cols; a++) {
      if (win[offset + a]) w += row[a];
      else if (push && push[offset + a]) u += row[a];
    }
  }
  if (!push) return { p: w };
  return { p: u < 1 ? w / (1 - u) : 0, win: w, push: u };
}

function evaluateAll(matrix) {
  return MARKETS.map((m) => {
    const r = evaluate(matrix, m);
    return r.push === undefined ? { label: m.label, p: r.p } : { label: m.label, p: r.p, push: r.push };
  });
}

// Issue d'un pari pour un score connu : « win », « push » (remboursé) ou « lose ».
function settle(market, h, a) {
  if (market.test(h, a)) return "win";
  if (market.push && market.push(h, a)) return "push";
  return "lose";
}

// Ce qu'il faut dire à l'utilisateur d'un pari remboursable : la probabilité du remboursement (en %) et son cas.
function refundInfo(market, pushP) {
  return { probabilite: round(pushP * 100, 1), quand: market.refundWhen };
}

// Lecture d'une matrice de scores : probabilité de chaque pari, résultats principaux et score le plus probable.
function describeMatrix(matrix) {
  const probs = evaluateAll(matrix);
  const get = (label) => (probs.find((x) => x.label === label) || { p: 0 }).p;
  const outcomes = {
    home: get(LABEL.HOME),
    draw: get(LABEL.DRAW),
    away: get(LABEL.AWAY),
    over25: get(LABEL.OVER25),
    btts: get(LABEL.BTTS),
  };
  const exact = evaluate(matrix, resolveMarket("Score exact"));
  return { probs, outcomes, likelyScore: exact.detail, likelyScoreP: exact.p };
}

// Probabilités « moyennes » d'un match de championnat, utilisées quand on ne connaît pas les équipes.
const GENERIC = scoreMatrix(1.5, 1.15);
const baseRate = (market) => evaluate(GENERIC, market).p;

module.exports = { MARKETS, LABEL, resolveMarket, evaluate, evaluateAll, settle, refundInfo, describeMatrix, baseRate };
