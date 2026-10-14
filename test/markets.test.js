"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MARKETS, resolveMarket, evaluate, evaluateAll, refundRule } = require("../src/markets");
const { scoreMatrix } = require("../src/model");

// ---------- Règles écrites à part (sans réutiliser le code de markets.js) ----------
// judge(libellé, buts équipe 1, buts équipe 2) -> "win" (gagné), "push" (remboursé) ou "lose" (perdu), d'après le LIBELLÉ seul.

const RESULT = {
  "Victoire domicile": (h, a) => h > a,
  "Victoire/nul domicile": (h, a) => h >= a,
  "Victoire extérieur": (h, a) => a > h,
  "Victoire/nul extérieur": (h, a) => a >= h,
};
const RES = "(Victoire domicile|Victoire/nul domicile|Victoire extérieur|Victoire/nul extérieur)";
const NUM = "(\\d(?:\\.5)?)";
const countOf = (what, h, a) => (what === "total" ? h + a : what === "domicile" ? h : what === "extérieur" ? a : Math.max(h, a));
// Compte contre ligne : pile sur la ligne (lignes entières seulement) = remboursé.
const vs = (count, dir, n) => (count === n ? "push" : (dir === "plus" ? count > n : count < n) ? "win" : "lose");

const SIMPLE = {
  "Victoire domicile": (h, a) => h > a,
  "Victoire extérieur": (h, a) => a > h,
  "Match nul": (h, a) => h === a,
  "Victoire ou nul domicile": (h, a) => h >= a,
  "Victoire ou nul extérieur": (h, a) => a >= h,
  "Victoire domicile ou extérieur": (h, a) => h !== a,
  "Les deux équipes marquent": (h, a) => h > 0 && a > 0,
  "Les deux équipes ne marquent pas": (h, a) => h === 0 || a === 0,
};

function judge(label, h, a) {
  if (SIMPLE[label]) return SIMPLE[label](h, a) ? "win" : "lose";
  let m;
  if ((m = /^(Plus|Moins) de (\d(?:\.5)?) buts?$/.exec(label))) return vs(h + a, m[1].toLowerCase(), Number(m[2]));
  if ((m = /^Equipe (domicile|extérieur) (\d\.5) buts plus$/.exec(label))) return vs(countOf(m[1], h, a), "plus", Number(m[2]));
  if ((m = /^Equipe (domicile|extérieur) (plus|moins) de (\d(?:\.5)?) buts?$/.exec(label))) return vs(countOf(m[1], h, a), m[2], Number(m[3]));
  if ((m = /^Au moins une équipe plus de (\d\.5) buts$/.exec(label))) return vs(countOf("meilleure", h, a), "plus", Number(m[1]));
  if ((m = new RegExp(`^${RES} \\+ ${NUM} buts plus$`).exec(label))) return RESULT[m[1]](h, a) ? vs(h + a, "plus", Number(m[2])) : "lose";
  if ((m = new RegExp(`^${RES} \\+ moins de ${NUM} buts$`).exec(label))) return RESULT[m[1]](h, a) ? vs(h + a, "moins", Number(m[2])) : "lose";
  if ((m = new RegExp(`^${RES} \\+ Equipe (domicile|extérieur) ${NUM} buts plus$`).exec(label))) return RESULT[m[1]](h, a) ? vs(countOf(m[2], h, a), "plus", Number(m[3])) : "lose";
  if ((m = new RegExp(`^${RES} \\+ Equipe (domicile|extérieur) moins de ${NUM} buts$`).exec(label))) return RESULT[m[1]](h, a) ? vs(countOf(m[2], h, a), "moins", Number(m[3])) : "lose";
  throw new Error(`Libellé non couvert par la règle de test : ${label}`);
}

test("chaque pari donne, pour chaque score de 0-0 à 9-9, le même verdict (gagné / remboursé / perdu) que sa règle écrite à part", () => {
  assert.equal(MARKETS.length, 102);
  const seen = new Set();
  for (const m of MARKETS) {
    assert.ok(!seen.has(m.label), `libellé en double : ${m.label}`);
    seen.add(m.label);
    for (let h = 0; h <= 9; h++) {
      for (let a = 0; a <= 9; a++) {
        const verdict = judge(m.label, h, a);
        assert.equal(m.test(h, a), verdict === "win", `${m.label} à ${h}-${a} : gagné ?`);
        assert.equal(Boolean(m.refund && m.refund.test(h, a)), verdict === "push", `${m.label} à ${h}-${a} : remboursé ?`);
      }
    }
  }
});

test("seuls les paris à ligne entière (1, 2 ou 3 buts) sont remboursables : 14 paris, aucun à demi-but", () => {
  const refundable = MARKETS.filter((m) => m.refund).map((m) => m.label);
  assert.deepEqual(refundable.sort(), [
    "Equipe domicile moins de 1 but",
    "Equipe domicile moins de 2 buts",
    "Equipe domicile plus de 1 but",
    "Equipe domicile plus de 2 buts",
    "Equipe extérieur moins de 1 but",
    "Equipe extérieur moins de 2 buts",
    "Equipe extérieur plus de 1 but",
    "Equipe extérieur plus de 2 buts",
    "Moins de 1 but",
    "Moins de 2 buts",
    "Moins de 3 buts",
    "Plus de 1 but",
    "Plus de 2 buts",
    "Plus de 3 buts",
  ]);
  for (const m of MARKETS) assert.equal(Boolean(m.refund), /(?:^| )(?:plus|moins) de \d buts?$/i.test(m.label), m.label);
});

test("exemples de remboursement : la mise est rendue quand le nombre de buts tombe pile sur la ligne", () => {
  const v = (label, h, a) => judge(label, h, a);
  // Total du match
  assert.deepEqual([v("Plus de 2 buts", 2, 1), v("Plus de 2 buts", 1, 1), v("Plus de 2 buts", 1, 0)], ["win", "push", "lose"]);
  assert.deepEqual([v("Moins de 1 but", 0, 0), v("Moins de 1 but", 1, 0), v("Moins de 1 but", 1, 1)], ["win", "push", "lose"]);
  assert.deepEqual([v("Moins de 3 buts", 1, 1), v("Moins de 3 buts", 2, 1), v("Moins de 3 buts", 2, 2)], ["win", "push", "lose"]);
  // Total d'une équipe
  assert.deepEqual([v("Equipe domicile plus de 1 but", 2, 0), v("Equipe domicile plus de 1 but", 1, 3), v("Equipe domicile plus de 1 but", 0, 2)], ["win", "push", "lose"]);
  assert.deepEqual([v("Equipe extérieur moins de 2 buts", 3, 1), v("Equipe extérieur moins de 2 buts", 0, 2), v("Equipe extérieur moins de 2 buts", 0, 3)], ["win", "push", "lose"]);
  // Les lignes à demi-but ne sont jamais remboursées.
  for (const label of ["Plus de 2.5 buts", "Moins de 2.5 buts", "Equipe domicile moins de 1.5 buts", "Au moins une équipe plus de 1.5 buts"]) {
    for (let h = 0; h <= 9; h++) for (let a = 0; a <= 9; a++) assert.notEqual(judge(label, h, a), "push", label);
  }
});

// ---------- Probabilités ----------

const M = scoreMatrix(1.6, 1.1, { rho: -0.08, maxGoals: 9 });
const p = (label) => evaluate(M, resolveMarket(label)).p;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg} : ${a} contre ${b}`);

test("pari à ligne entière : gagné + remboursé + perdu = 100 %, et « plus de » + « moins de » se complètent", () => {
  for (const [over, under] of [
    ["Plus de 1 but", "Moins de 1 but"],
    ["Plus de 2 buts", "Moins de 2 buts"],
    ["Plus de 3 buts", "Moins de 3 buts"],
    ["Equipe domicile plus de 1 but", "Equipe domicile moins de 1 but"],
    ["Equipe domicile plus de 2 buts", "Equipe domicile moins de 2 buts"],
    ["Equipe extérieur plus de 1 but", "Equipe extérieur moins de 1 but"],
    ["Equipe extérieur plus de 2 buts", "Equipe extérieur moins de 2 buts"],
  ]) {
    const a = evaluate(M, resolveMarket(over));
    const b = evaluate(M, resolveMarket(under));
    assert.ok(a.push > 0.01 && a.push < 0.5, `${over} : remboursement ${a.push}`);
    close(a.push, b.push, `${over} / ${under} : même probabilité de remboursement`);
    close(a.p + a.push + b.p, 1, `${over} : gagné + remboursé + perdu`);
  }
  // On gagne « plus de 2 » exactement quand on gagne « plus de 2.5 » (3 buts ou plus) : seul le cas des 2 buts pile change, remboursé au lieu d'être perdu.
  close(p("Plus de 2 buts"), p("Plus de 2.5 buts"), "plus de 2 / plus de 2.5");
  close(p("Moins de 2 buts"), p("Moins de 1.5 buts"), "moins de 2 / moins de 1.5");
  close(p("Plus de 1 but"), p("Plus de 1.5 buts"), "plus de 1 / plus de 1.5");
  close(p("Moins de 3 buts"), p("Moins de 2.5 buts"), "moins de 3 / moins de 2.5");
  close(p("Equipe domicile plus de 1 but"), p("Equipe domicile 1.5 buts plus"), "l'équipe 1 : plus de 1 / plus de 1.5");
  close(p("Equipe extérieur moins de 2 buts"), p("Equipe extérieur moins de 1.5 buts"), "l'équipe 2 : moins de 2 / moins de 1.5");
});

test("evaluate / evaluateAll : `push` seulement pour les paris à ligne entière", () => {
  assert.equal(evaluate(M, resolveMarket("Plus de 2.5 buts")).push, undefined);
  assert.ok(evaluate(M, resolveMarket("Plus de 2 buts")).push > 0);
  const all = evaluateAll(M);
  assert.equal(all.length, 102);
  assert.equal(all.filter((x) => x.refund).length, 14);
  for (const x of all) {
    assert.ok(x.p >= 0 && x.p <= 1, x.label);
    assert.equal(x.push !== undefined, Boolean(x.refund), x.label);
    close(x.p, evaluate(M, resolveMarket(x.label)).p, `evaluateAll et evaluate (${x.label})`);
  }
});

test("paris composés : cohérents avec leurs éléments", () => {
  close(p("Victoire domicile + 0.5 buts plus"), p("Victoire domicile"), "une victoire a forcément au moins un but");
  close(p("Victoire extérieur + 0.5 buts plus"), p("Victoire extérieur"), "idem à l'extérieur");
  close(p("Victoire domicile + Equipe domicile 0.5 buts plus"), p("Victoire domicile"), "V1 et l'équipe 1 marque");
  close(p("Victoire extérieur + Equipe extérieur 0.5 buts plus"), p("Victoire extérieur"), "V2 et l'équipe 2 marque");
  close(p("Au moins une équipe plus de 0.5 buts"), p("Plus de 0.5 buts"), "au moins un but dans le match");
  // Une ligne à demi-but partage un résultat en deux.
  for (const n of [1.5, 2.5, 3.5]) {
    close(p(`Victoire domicile + ${n} buts plus`) + p(`Victoire domicile + moins de ${n} buts`), p("Victoire domicile"), `V1 et total ${n}`);
    close(p(`Victoire/nul domicile + ${n} buts plus`) + p(`Victoire/nul domicile + moins de ${n} buts`), p("Victoire ou nul domicile"), `1X et total ${n}`);
    close(p(`Victoire extérieur + ${n} buts plus`) + p(`Victoire extérieur + moins de ${n} buts`), p("Victoire extérieur"), `V2 et total ${n}`);
    close(p(`Victoire/nul extérieur + ${n} buts plus`) + p(`Victoire/nul extérieur + moins de ${n} buts`), p("Victoire ou nul extérieur"), `2X et total ${n}`);
    close(p(`Victoire domicile + Equipe domicile ${n} buts plus`) + p(`Victoire domicile + Equipe domicile moins de ${n} buts`), p("Victoire domicile"), `V1 et total 1 (${n})`);
    close(p(`Victoire/nul domicile + Equipe domicile ${n} buts plus`) + p(`Victoire/nul domicile + Equipe domicile moins de ${n} buts`), p("Victoire ou nul domicile"), `1X et total 1 (${n})`);
    close(p(`Victoire extérieur + Equipe extérieur ${n} buts plus`) + p(`Victoire extérieur + Equipe extérieur moins de ${n} buts`), p("Victoire extérieur"), `V2 et total 2 (${n})`);
    close(p(`Victoire/nul extérieur + Equipe extérieur ${n} buts plus`) + p(`Victoire/nul extérieur + Equipe extérieur moins de ${n} buts`), p("Victoire ou nul extérieur"), `2X et total 2 (${n})`);
  }
  // Victoire de l'équipe 1 avec moins de 1.5 but au total : seulement 1-0.
  close(p("Victoire domicile + moins de 1.5 buts"), M[1][0], "V1 et moins de 1.5 but = 1-0");
  close(p("Victoire domicile + Equipe domicile moins de 1.5 buts"), M[1][0], "V1 et l'équipe 1 à moins de 1.5 but = 1-0");
  // Équipe 1 sans but : toute la première ligne de la matrice.
  close(p("Equipe domicile moins de 0.5 buts"), M[0].reduce((s, x) => s + x, 0), "l'équipe 1 ne marque pas");
  // « Au moins une équipe plus de 1.5 » : 2 buts ou plus pour l'une des deux équipes.
  let two = 0;
  M.forEach((row, h) => row.forEach((v, a) => (Math.max(h, a) >= 2 ? (two += v) : 0)));
  close(p("Au moins une équipe plus de 1.5 buts"), two, "au moins une équipe à 2 buts");
  assert.ok(p("Au moins une équipe plus de 1.5 buts") < p("Plus de 1.5 buts"), "plus exigeant que 2 buts au total");
});

// ---------- La liste de paris envoyée, mot pour mot ----------

const USER_LIST = `
Victoire équipe 1
Victoire équipe 2
Victoire ou nul équipe 1
Victoire ou nul équipe 2
Total de but dans le match : plus de (0.5) but ; plus de (1) but ; plus de (1.5) but ; plus de (2) but ; plus de (2.5) but ; plus de (3) but.
Moins de (0.5) but ; moins de (1) but ; moins de (1.5) but ; moins de (2) but ; moins de (2.5) but ; moins de (3) but.
Total but équipe 1 : plus de (0.5) but ; plus de (1) but ; plus de (1.5) but ; plus de (2) but ; plus de (2.5) but.
Moins de (0.5) but ; moins de (1) but ; moins de (1.5) but ; moins de (2) but ; moins de (2.5) but.
Total but équipe 2 : plus de (0.5) but ; plus de (1) but ; plus de (1.5) but ; plus de (2) but ; plus de (2.5) but.
Moins de (0.5) but ; moins de (1) but ; moins de (1.5) but ; moins de (2) but ; moins de (2.5) but.
Résultat et Total : V1 et plus de (0.5) but ; V1 et plus de (1.5) but ; V1 et plus de (2.5) but ; V1 et plus de (3.5) but.
V1 et moins de (1.5) but ; V1 et moins de (2.5) but ; V1 et moins de (3.5) but.
1X et plus de (1.5) but ; 1X et plus de (2.5) but ; 1X et plus de (3.5) but.
1X et moins de (1.5) but ; 1X et moins de (2.5) but ; 1X et moins de (3.5) but.
V2 et plus de (0.5) but ; V2 et plus de (1.5) but ; V2 et plus de (2.5) but ; V2 et plus de (3.5) but.
V2 et moins de (1.5) but ; V2 et moins de (2.5) but ; V2 et moins de (3.5) but.
2X et plus de (1.5) but ; 2X et plus de (2.5) but ; 2X et plus de (3.5) but.
2X et moins de (1.5) but ; 2X et moins de (2.5) but ; 2X et moins de (3.5) but.
- Au moins une équipe va marquer plus de (0.5) but
- Au moins une équipe va marquer plus de (1.5) but
- Au moins une équipe va marquer plus de (2.5) but
- Au moins une équipe va marquer plus de (3.5) but
Résultat + Total 1 : V1 et Total 1 plus de (0.5) but ; V1 et Total 1 plus de (1.5) but ; V1 et Total 1 plus de (2.5) but ; V1 et Total 1 plus de (3.5) but.
V1 et Total 1 moins de (1.5) but ; V1 et Total 1 moins de (2.5) but ; V1 et Total 1 moins de (3.5) but.
1X et Total 1 plus de (0.5) but ; 1X et Total 1 plus de (1.5) but ; 1X et Total 1 plus de (2.5) but ; 1X et Total 1 plus de (3.5) but.
1X et Total 1 moins de (1.5) but ; 1X et Total 1 moins de (2.5) but ; 1X et Total 1 moins de (3.5) but.
V2 et Total 2 plus de (0.5) but ; V2 et Total 2 plus de (1.5) but ; V2 et Total 2 plus de (2.5) but ; V2 et Total 2 plus de (3.5) but.
V2 et Total 2 moins de (1.5) but ; V2 et Total 2 moins de (2.5) but ; V2 et Total 2 moins de (3.5) but.
2X et Total 2 plus de (0.5) but ; 2X et Total 2 plus de (1.5) but ; 2X et Total 2 plus de (2.5) but ; 2X et Total 2 plus de (3.5) but.
2X et Total 2 moins de (1.5) but ; 2X et Total 2 moins de (2.5) but ; 2X et Total 2 moins de (3.5) but.
`;

const labelOf = (n) => `${n} ${Number(n) === 1 ? "but" : "buts"}`;
const KEY = { V1: "Victoire domicile", "1X": "Victoire/nul domicile", V2: "Victoire extérieur", "2X": "Victoire/nul extérieur" };
const SIDE_OF = { V1: "domicile", "1X": "domicile", V2: "extérieur", "2X": "extérieur" };
const SIDE_NUM = { 1: "domicile", 2: "extérieur" };
const SIMPLE_USER = { "Victoire équipe 1": "Victoire domicile", "Victoire équipe 2": "Victoire extérieur", "Victoire ou nul équipe 1": "Victoire ou nul domicile", "Victoire ou nul équipe 2": "Victoire ou nul extérieur" };

// Lit la liste et renvoie, pour chaque ligne de pari : le texte tel qu'envoyé (avec son titre de famille) et le libellé attendu dans l'application.
function parseUserList(text) {
  const out = [];
  let header = "";
  for (const raw of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (SIMPLE_USER[raw]) {
      out.push({ phrase: raw, label: SIMPLE_USER[raw] });
      continue;
    }
    if (raw.startsWith("- ")) {
      const phrase = raw.slice(2);
      const m = /^Au moins une équipe va marquer plus de \((\d\.5)\) but$/.exec(phrase);
      out.push({ phrase, label: `Au moins une équipe plus de ${m[1]} buts` });
      continue;
    }
    let items = raw;
    if (raw.includes(" : ")) {
      header = raw.split(" : ")[0];
      items = raw.slice(raw.indexOf(" : ") + 3);
    }
    for (const item of items.split(";").map((x) => x.trim().replace(/\.$/, ""))) {
      let m;
      if (header === "Total de but dans le match" && (m = /^(plus|moins) de \(([\d.]+)\) but$/i.exec(item))) {
        out.push({ phrase: `${header} ${item}`, label: `${m[1].toLowerCase() === "plus" ? "Plus" : "Moins"} de ${labelOf(m[2])}` });
      } else if (/^Total but équipe [12]$/.test(header) && (m = /^(plus|moins) de \(([\d.]+)\) but$/i.exec(item))) {
        const side = SIDE_NUM[header.slice(-1)];
        const n = Number(m[2]);
        const label = m[1].toLowerCase() === "moins" ? `Equipe ${side} moins de ${labelOf(n)}` : Number.isInteger(n) ? `Equipe ${side} plus de ${labelOf(n)}` : `Equipe ${side} ${n} buts plus`;
        out.push({ phrase: `${header} ${item}`, label });
      } else if (header === "Résultat et Total" && (m = /^(V1|1X|V2|2X) et (plus|moins) de \(([\d.]+)\) but$/i.exec(item))) {
        out.push({ phrase: item, label: m[2].toLowerCase() === "plus" ? `${KEY[m[1]]} + ${m[3]} buts plus` : `${KEY[m[1]]} + moins de ${m[3]} buts` });
      } else if (header === "Résultat + Total 1" && (m = /^(V1|1X|V2|2X) et Total ([12]) (plus|moins) de \(([\d.]+)\) but$/i.exec(item))) {
        assert.equal(SIDE_NUM[m[2]], SIDE_OF[m[1]], `${item} : le total est celui de l'équipe du résultat`);
        const side = SIDE_NUM[m[2]];
        out.push({ phrase: item, label: m[3].toLowerCase() === "plus" ? `${KEY[m[1]]} + Equipe ${side} ${m[4]} buts plus` : `${KEY[m[1]]} + Equipe ${side} moins de ${m[4]} buts` });
      } else {
        throw new Error(`Ligne non comprise : « ${item} » (famille « ${header} »)`);
      }
    }
  }
  return out;
}

test("la liste de paris envoyée est entièrement disponible : chaque ligne, avec ses mots, désigne le bon pari de l'application", () => {
  const items = parseUserList(USER_LIST);
  assert.equal(items.length, 94, "toutes les lignes de la liste sont lues");
  for (const { phrase, label } of items) {
    const market = resolveMarket(phrase);
    assert.ok(market, `non reconnu : « ${phrase} »`);
    assert.equal(market.label, label, `« ${phrase} »`);
    assert.equal(resolveMarket(label), market, `le libellé « ${label} » existe`);
  }
});

test("les lignes entières de la liste envoyée sont remboursables, les lignes à demi-but non", () => {
  for (const { phrase, label } of parseUserList(USER_LIST)) {
    const whole = /\(\d\)/.test(phrase);
    assert.equal(Boolean(resolveMarket(label).refund), whole, `${phrase} → ${label}`);
  }
});

test("écritures libres : avec ou sans accents, singulier ou pluriel, et anciens libellés toujours reconnus", () => {
  const same = (a, b) => assert.equal(resolveMarket(a), resolveMarket(b), `${a} / ${b}`);
  same("plus de 1.5 buts", "Plus de 1.5 buts");
  same("Plus de (1) but", "Plus de 1 but");
  same("Plus de 2 but", "Plus de 2 buts");
  same("Equipe 1 moins de 1 but", "Equipe domicile moins de 1 but");
  same("Equipe 2 plus de 2 buts", "Equipe extérieur plus de 2 buts");
  same("equipe exterieur moins de 0,5 buts".replace(",", "."), "Equipe extérieur moins de 0.5 buts");
  same("v1 ET plus DE 3.5 buts", "Victoire domicile + 3.5 buts plus");
  same("2x et moins de 2.5 buts", "Victoire/nul extérieur + moins de 2.5 buts");
  same("1X et Total 1 moins de 1.5 buts", "Victoire/nul domicile + Equipe domicile moins de 1.5 buts");
  // Anciens libellés et anciennes écritures.
  same("Equipe domicile 1.5 buts plus", "Equipe 1 plus de 1.5 buts");
  same("Total buts 1.5 plus", "Plus de 1.5 buts");
  same("Victoire/nul exterieur + 2.5 buts plus", "2X et plus de 2.5 buts");
  same("Victoire exterieur + 1.5 buts plus", "V2 et plus de 1.5 buts");
  assert.equal(resolveMarket("Plus de 4 buts"), null, "une ligne qui n'existe pas n'est pas devinée");
  assert.equal(resolveMarket("Equipe domicile moins de 3.5 buts"), null);
  assert.equal(resolveMarket("V1 et Total 2 plus de 1.5 buts"), null, "V1 se combine avec le total de l'équipe 1 seulement");
});

test("règle de remboursement en français", () => {
  assert.equal(refundRule(resolveMarket("Plus de 2 buts"), "Arsenal", "Chelsea"), "Si le match se termine avec exactement 2 buts, la mise est remboursée (ni gagnée, ni perdue).");
  assert.equal(refundRule(resolveMarket("Moins de 1 but"), "Arsenal", "Chelsea"), "Si le match se termine avec exactement 1 but, la mise est remboursée (ni gagnée, ni perdue).");
  assert.equal(refundRule(resolveMarket("Equipe domicile plus de 1 but"), "Arsenal", "Chelsea"), "Si Arsenal marque exactement 1 but, la mise est remboursée (ni gagnée, ni perdue).");
  assert.equal(refundRule(resolveMarket("Equipe extérieur moins de 2 buts"), "Arsenal", "Chelsea"), "Si Chelsea marque exactement 2 buts, la mise est remboursée (ni gagnée, ni perdue).");
  assert.equal(refundRule(resolveMarket("Plus de 2.5 buts"), "Arsenal", "Chelsea"), null);
  assert.equal(refundRule(null, "A", "B"), null);
});

test("le calcul de tous les paris reste rapide", () => {
  const t0 = Date.now();
  for (let i = 0; i < 500; i++) evaluateAll(M);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms pour 500 matchs`);
});
