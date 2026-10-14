"use strict";

// Les types de paris : chacun des 94 pronostics demandés est écrit ici sous la forme où l'utilisateur les a listés, puis comparé à un calcul
// indépendant, case par case, sur la grille des scores (sans passer par les masques de markets.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const { MARKETS, LABEL, resolveMarket, evaluate, evaluateAll, settle, refundInfo, describeMatrix, baseRate } = require("../src/markets");
const { scoreMatrix } = require("../src/model");

// ---------- Spécification indépendante ----------

const SIDE = {
  plus: (v, n) => (v > n ? "win" : v === n ? "push" : "lose"),
  moins: (v, n) => (v < n ? "win" : v === n ? "push" : "lose"),
};
const RESULT = {
  V1: { label: "Victoire équipe 1", is: (h, a) => h > a },
  "1X": { label: "Victoire ou nul équipe 1", is: (h, a) => h >= a },
  V2: { label: "Victoire équipe 2", is: (h, a) => a > h },
  "2X": { label: "Victoire ou nul équipe 2", is: (h, a) => a >= h },
};
const goalsOf = { total: (h, a) => h + a, 1: (h) => h, 2: (h, a) => a };
const but = (n) => (n === 1 ? "but" : "buts");
const Cap = (s) => s[0].toUpperCase() + s.slice(1);
const win = (cond) => (cond ? "win" : "lose");

// { section, user (écriture de l'utilisateur), label (nom du serveur), outcome(h, a) -> "win" | "push" | "lose" }
function userSpec() {
  const out = [];
  const add = (section, user, label, outcome) => out.push({ section, user, label, outcome });

  // 1. Résultat
  for (const code of ["V1", "V2", "1X", "2X"]) {
    const r = RESULT[code];
    add(1, r.label, r.label, (h, a) => win(r.is(h, a)));
  }
  // 2. Total de buts du match
  for (const side of ["plus", "moins"]) {
    for (const n of [0.5, 1, 1.5, 2, 2.5, 3]) add(2, `${Cap(side)} de ${n} but`, `${Cap(side)} de ${n} ${but(n)}`, (h, a) => SIDE[side](h + a, n));
  }
  // 3 et 4. Total de buts de l'équipe 1 puis de l'équipe 2
  for (const k of [1, 2]) {
    for (const side of ["plus", "moins"]) {
      for (const n of [0.5, 1, 1.5, 2, 2.5]) add(2 + k, `Total équipe ${k} ${side} de ${n} but`, `Équipe ${k} ${side} de ${n} ${but(n)}`, (h, a) => SIDE[side](goalsOf[k](h, a), n));
    }
  }
  // 5. Résultat et total du match
  const lines5 = { V1: [[0.5, 1.5, 2.5, 3.5], [1.5, 2.5, 3.5]], V2: [[0.5, 1.5, 2.5, 3.5], [1.5, 2.5, 3.5]], "1X": [[1.5, 2.5, 3.5], [1.5, 2.5, 3.5]], "2X": [[1.5, 2.5, 3.5], [1.5, 2.5, 3.5]] };
  for (const code of ["V1", "1X", "V2", "2X"]) {
    const r = RESULT[code];
    const [plus, moins] = lines5[code];
    for (const n of plus) add(5, `${code} et plus de ${n} but`, `${r.label} et plus de ${n} buts`, (h, a) => win(r.is(h, a) && h + a > n));
    for (const n of moins) add(5, `${code} et moins de ${n} but`, `${r.label} et moins de ${n} buts`, (h, a) => win(r.is(h, a) && h + a < n));
  }
  for (const n of [0.5, 1.5, 2.5, 3.5]) add(5, `Au moins une équipe va marquer plus de ${n} but`, `Au moins une équipe marque plus de ${n} buts`, (h, a) => win(Math.max(h, a) > n));
  // 6. Résultat et total de l'équipe
  for (const [code, k] of [["V1", 1], ["1X", 1], ["V2", 2], ["2X", 2]]) {
    const r = RESULT[code];
    for (const n of [0.5, 1.5, 2.5, 3.5]) add(6, `${code} et Total ${k} plus de ${n} but`, `${r.label} et total équipe ${k} plus de ${n} buts`, (h, a) => win(r.is(h, a) && goalsOf[k](h, a) > n));
    for (const n of [1.5, 2.5, 3.5]) add(6, `${code} et Total ${k} moins de ${n} but`, `${r.label} et total équipe ${k} moins de ${n} buts`, (h, a) => win(r.is(h, a) && goalsOf[k](h, a) < n));
  }
  return out;
}

const SPEC = userSpec();
const MATRICES = [
  ["équilibré", scoreMatrix(1.5, 1.15)],
  ["fort favori", scoreMatrix(2.9, 0.45)],
  ["match fermé", scoreMatrix(0.7, 0.6)],
  ["extérieur favori", scoreMatrix(0.8, 2.2)],
];
const SCORES = Array.from({ length: 10 }, (_, h) => Array.from({ length: 10 }, (_, a) => [h, a])).flat();

test("la liste de l'utilisateur compte bien 94 pronostics, répartis comme demandé", () => {
  assert.equal(SPEC.length, 94);
  const bySection = (s) => SPEC.filter((x) => x.section === s).length;
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(bySection), [4, 12, 10, 10, 30, 28]);
  assert.equal(new Set(SPEC.map((x) => x.label)).size, 94, "aucun doublon dans la liste");
});

test("chacun des 94 pronostics est reconnu, sous l'écriture de l'utilisateur comme sous son nom officiel", () => {
  const markets = new Set();
  for (const s of SPEC) {
    const byUser = resolveMarket(s.user);
    const byLabel = resolveMarket(s.label);
    assert.ok(byLabel, `non reconnu : ${s.label}`);
    assert.ok(byUser, `non reconnu : ${s.user}`);
    assert.equal(byUser, byLabel, `${s.user} devrait donner ${s.label} (donne ${byUser && byUser.label})`);
    assert.equal(byLabel.label, s.label);
    markets.add(byLabel);
  }
  assert.equal(markets.size, 94);
});

test("chacun des 94 pronostics : gagné, remboursé ou perdu pour chaque score possible, comme dans la spécification", () => {
  for (const s of SPEC) {
    const m = resolveMarket(s.label);
    for (const [h, a] of SCORES) assert.equal(settle(m, h, a), s.outcome(h, a), `${s.label} pour ${h}-${a}`);
  }
});

test("chacun des 94 pronostics : probabilité = calcul direct sur la grille des scores (gain, remboursement et probabilité annoncée)", () => {
  for (const [name, M] of MATRICES) {
    for (const s of SPEC) {
      let w = 0;
      let u = 0;
      for (const [h, a] of SCORES) {
        const o = s.outcome(h, a);
        if (o === "win") w += M[h][a];
        else if (o === "push") u += M[h][a];
      }
      const m = resolveMarket(s.label);
      const ev = evaluate(M, m);
      if (u === 0) {
        assert.ok(Math.abs(ev.p - w) < 1e-12, `${s.label} (${name}) : ${ev.p} contre ${w}`);
        assert.equal(ev.push, undefined, `${s.label} n'est pas remboursable`);
      } else {
        assert.ok(Math.abs(ev.win - w) < 1e-12 && Math.abs(ev.push - u) < 1e-12, `${s.label} (${name}) : gain ${ev.win}/${w}, remboursement ${ev.push}/${u}`);
        assert.ok(Math.abs(ev.p - w / (1 - u)) < 1e-12, `${s.label} (${name}) : ${ev.p} contre ${w / (1 - u)}`);
      }
    }
  }
});

test("liste complète du serveur : les 94 demandés plus 8 paris déjà présents dans l'application, rien d'autre", () => {
  const asked = new Set(SPEC.map((x) => x.label));
  const already = [
    "Match nul",
    "Victoire équipe 1 ou équipe 2",
    "Plus de 3.5 buts",
    "Moins de 3.5 buts",
    "Les deux équipes marquent",
    "Les deux équipes ne marquent pas",
    "Victoire ou nul équipe 1 et plus de 0.5 buts",
    "Victoire ou nul équipe 2 et plus de 0.5 buts",
  ];
  const labels = MARKETS.map((m) => m.label);
  assert.equal(labels.length, 102);
  assert.equal(new Set(labels).size, 102, "noms uniques");
  assert.deepEqual([...labels].sort(), [...asked, ...already].sort());
  for (const label of already) assert.ok(resolveMarket(label), label);
});

test("paris remboursables : exactement 14 (lignes entières), chacun avec son cas de remboursement en français", () => {
  const refundable = MARKETS.filter((m) => m.push);
  assert.deepEqual(
    refundable.map((m) => m.label).sort(),
    [
      "Plus de 1 but",
      "Moins de 1 but",
      "Plus de 2 buts",
      "Moins de 2 buts",
      "Plus de 3 buts",
      "Moins de 3 buts",
      ...[1, 2].flatMap((k) => ["plus", "moins"].flatMap((side) => [1, 2].map((n) => `Équipe ${k} ${side} de ${n} ${but(n)}`))),
    ].sort()
  );
  assert.equal(refundable.length, 14);
  for (const m of MARKETS) {
    if (m.push) assert.ok(m.refundWhen.length > 10, m.label);
    else assert.equal(m.refundWhen, "", m.label);
  }
  assert.equal(resolveMarket("Plus de 1 but").refundWhen, "le match se termine avec exactement 1 but au total");
  assert.equal(resolveMarket("Moins de 3 buts").refundWhen, "le match se termine avec exactement 3 buts au total");
  assert.equal(resolveMarket("Équipe 2 plus de 2 buts").refundWhen, "l'équipe 2 marque exactement 2 buts");
  assert.equal(resolveMarket("Équipe 1 moins de 1 but").refundWhen, "l'équipe 1 marque exactement 1 but");
  assert.deepEqual(refundInfo(resolveMarket("Plus de 2 buts"), 0.2345), { probabilite: 23.5, quand: "le match se termine avec exactement 2 buts au total" });
});

test("exemple chiffré : plus de 1 but à 1,5 – 1,15 but attendu (probabilité de gagner quand le pari n'est pas remboursé)", () => {
  const M = scoreMatrix(1.5, 1.15);
  const ev = evaluate(M, resolveMarket("Plus de 1 but"));
  // Total de buts : 0 → P0, 1 → P1, 2 ou plus → le reste.
  const total = (n) => SCORES.filter(([h, a]) => h + a === n).reduce((s, [h, a]) => s + M[h][a], 0);
  const p0 = total(0);
  const p1 = total(1);
  assert.ok(Math.abs(ev.push - p1) < 1e-12);
  assert.ok(Math.abs(ev.win - (1 - p0 - p1)) < 1e-12);
  assert.ok(Math.abs(ev.p - (1 - p0 - p1) / (1 - p1)) < 1e-12);
  assert.ok(ev.p > 0.88 && ev.p < 0.93, `${ev.p}`);
  assert.ok(ev.push > 0.15 && ev.push < 0.19, `${ev.push}`);
  // Un pari ordinaire ne porte ni gain ni remboursement.
  assert.deepEqual(Object.keys(evaluate(M, resolveMarket("Plus de 1.5 buts"))), ["p"]);
});

// ---------- Cohérence entre paris ----------

const GRID = [];
for (const lh of [0.35, 0.8, 1.2, 1.7, 2.4, 3.3]) for (const la of [0.3, 0.7, 1.1, 1.6, 2.3]) GRID.push([lh, la, scoreMatrix(lh, la)]);
const near = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

test("cohérence : résultats, double chance, buts et lignes complémentaires (demi-lignes : plus + moins = 100 %)", () => {
  for (const [lh, la, M] of GRID) {
    const p = (label) => evaluate(M, resolveMarket(label)).p;
    const at = `λ = ${lh}, ${la}`;
    assert.ok(near(p("Victoire équipe 1") + p("Match nul") + p("Victoire équipe 2"), 1), at);
    assert.ok(near(p("Victoire ou nul équipe 1"), p("Victoire équipe 1") + p("Match nul")), at);
    assert.ok(near(p("Victoire ou nul équipe 2"), p("Victoire équipe 2") + p("Match nul")), at);
    assert.ok(near(p("Victoire équipe 1 ou équipe 2"), 1 - p("Match nul")), at);
    assert.ok(near(p("Les deux équipes marquent") + p("Les deux équipes ne marquent pas"), 1), at);
    for (const n of [0.5, 1.5, 2.5, 3.5]) assert.ok(near(p(`Plus de ${n} buts`) + p(`Moins de ${n} buts`), 1), `${at} ${n}`);
    for (const k of [1, 2]) for (const n of [0.5, 1.5, 2.5]) assert.ok(near(p(`Équipe ${k} plus de ${n} buts`) + p(`Équipe ${k} moins de ${n} buts`), 1), `${at} équipe ${k} ${n}`);
  }
});

test("cohérence : lignes entières – gain + remboursement + perte = 100 %, même remboursement pour « plus de » et « moins de »", () => {
  for (const [lh, la, M] of GRID) {
    for (const [family, lines] of [["", [1, 2, 3]], ["Équipe 1 ", [1, 2]], ["Équipe 2 ", [1, 2]]]) {
      for (const n of lines) {
        const name = (side) => (family ? `${family}${side} de ${n} ${but(n)}` : `${Cap(side)} de ${n} ${but(n)}`);
        const plus = evaluate(M, resolveMarket(name("plus")));
        const moins = evaluate(M, resolveMarket(name("moins")));
        const at = `${name("plus")} λ = ${lh}, ${la}`;
        assert.ok(near(plus.push, moins.push), at);
        assert.ok(near(plus.win + moins.win + plus.push, 1), at);
        assert.ok(near(plus.p, plus.win / (1 - plus.push)) && near(moins.p, moins.win / (1 - moins.push)), at);
        // Annoncé : « plus » et « moins » se complètent toujours à 100 % hors remboursement.
        assert.ok(near(plus.p + moins.p, 1), at);
      }
    }
  }
});

test("cohérence : une ligne entière se place entre ses deux demi-lignes voisines (elle ne bat jamais la plus sûre des deux)", () => {
  for (const [lh, la, M] of GRID) {
    const p = (label) => evaluate(M, resolveMarket(label)).p;
    const at = `λ = ${lh}, ${la}`;
    const eps = 1e-12;
    // Total du match : plus de n est entre plus de (n − 0,5) et plus de (n + 0,5) ; moins de n entre moins de (n − 0,5) et moins de (n + 0,5).
    for (const n of [1, 2, 3]) {
      const lo = n - 0.5;
      const hi = n + 0.5;
      const over = p(`Plus de ${n} ${but(n)}`);
      assert.ok(p(`Plus de ${hi} buts`) - eps <= over && over <= p(`Plus de ${lo} buts`) + eps, `plus de ${n} ${at}`);
      const under = p(`Moins de ${n} ${but(n)}`);
      assert.ok(p(`Moins de ${lo} buts`) - eps <= under && under <= p(`Moins de ${hi} buts`) + eps, `moins de ${n} ${at}`);
    }
    for (const k of [1, 2]) {
      for (const n of [1, 2]) {
        const over = p(`Équipe ${k} plus de ${n} ${but(n)}`);
        assert.ok(p(`Équipe ${k} plus de ${n + 0.5} buts`) - eps <= over && over <= p(`Équipe ${k} plus de ${n - 0.5} buts`) + eps, `équipe ${k} plus de ${n} ${at}`);
        const under = p(`Équipe ${k} moins de ${n} ${but(n)}`);
        assert.ok(p(`Équipe ${k} moins de ${n - 0.5} buts`) - eps <= under && under <= p(`Équipe ${k} moins de ${n + 0.5} buts`) + eps, `équipe ${k} moins de ${n} ${at}`);
      }
    }
  }
});

test("cohérence : plus la ligne est haute, moins « plus de » est probable (et plus « moins de » l'est)", () => {
  for (const [lh, la, M] of GRID) {
    const p = (label) => evaluate(M, resolveMarket(label)).p;
    const decreasing = (labels, at) => labels.map(p).reduce((prev, cur, i) => (assert.ok(cur <= prev + 1e-12, `${at} : ${labels[i]} (${cur}) > ${labels[i - 1]} (${prev}) pour λ = ${lh}, ${la}`), cur));
    const rising = (labels, at) => decreasing([...labels].reverse(), at);
    const matchLines = ["0.5", "1", "1.5", "2", "2.5", "3"];
    decreasing(matchLines.map((n) => `Plus de ${n} ${but(Number(n))}`), "plus de (match)");
    rising(matchLines.map((n) => `Moins de ${n} ${but(Number(n))}`), "moins de (match)");
    for (const k of [1, 2]) {
      const lines = ["0.5", "1", "1.5", "2", "2.5"];
      decreasing(lines.map((n) => `Équipe ${k} plus de ${n} ${but(Number(n))}`), `équipe ${k} plus de`);
      rising(lines.map((n) => `Équipe ${k} moins de ${n} ${but(Number(n))}`), `équipe ${k} moins de`);
    }
    for (const r of Object.values(RESULT)) {
      decreasing([0.5, 1.5, 2.5, 3.5].map((n) => `${r.label} et plus de ${n} buts`), `${r.label} et plus de`);
      rising([1.5, 2.5, 3.5].map((n) => `${r.label} et moins de ${n} buts`), `${r.label} et moins de`);
    }
    decreasing([0.5, 1.5, 2.5, 3.5].map((n) => `Au moins une équipe marque plus de ${n} buts`), "au moins une équipe");
  }
});

test("cohérence : résultat et total – « plus de » + « moins de » redonnent le résultat seul ; « plus de 0.5 » ne retire que le 0-0", () => {
  for (const [lh, la, M] of GRID) {
    const p = (label) => evaluate(M, resolveMarket(label)).p;
    const p00 = M[0][0];
    const at = `λ = ${lh}, ${la}`;
    for (const r of Object.values(RESULT)) {
      for (const n of [1.5, 2.5, 3.5]) assert.ok(near(p(`${r.label} et plus de ${n} buts`) + p(`${r.label} et moins de ${n} buts`), p(r.label)), `${r.label} ${n} ${at}`);
    }
    // Une victoire exige au moins un but ; une double chance ne retire que le 0-0.
    assert.ok(near(p("Victoire équipe 1 et plus de 0.5 buts"), p("Victoire équipe 1")), at);
    assert.ok(near(p("Victoire équipe 2 et plus de 0.5 buts"), p("Victoire équipe 2")), at);
    assert.ok(near(p("Victoire ou nul équipe 1 et plus de 0.5 buts"), p("Victoire ou nul équipe 1") - p00), at);
    assert.ok(near(p("Victoire ou nul équipe 2 et plus de 0.5 buts"), p("Victoire ou nul équipe 2") - p00), at);
    // Un pari « résultat et total » n'est jamais plus probable que le résultat ni que le total pris seuls.
    for (const r of Object.values(RESULT)) {
      for (const n of [1.5, 2.5, 3.5]) {
        assert.ok(p(`${r.label} et plus de ${n} buts`) <= Math.min(p(r.label), p(`Plus de ${n} buts`)) + 1e-12, `${r.label} ${n} ${at}`);
        assert.ok(p(`${r.label} et moins de ${n} buts`) <= Math.min(p(r.label), p(`Moins de ${n} buts`)) + 1e-12, `${r.label} ${n} ${at}`);
      }
    }
  }
});

test("cohérence : résultat et total de l'équipe – « plus de » + « moins de » redonnent le résultat seul", () => {
  for (const [lh, la, M] of GRID) {
    const p = (label) => evaluate(M, resolveMarket(label)).p;
    const at = `λ = ${lh}, ${la}`;
    for (const [code, k] of [["V1", 1], ["1X", 1], ["V2", 2], ["2X", 2]]) {
      const r = RESULT[code];
      for (const n of [1.5, 2.5, 3.5]) assert.ok(near(p(`${r.label} et total équipe ${k} plus de ${n} buts`) + p(`${r.label} et total équipe ${k} moins de ${n} buts`), p(r.label)), `${code} total ${k} ${n} ${at}`);
      const atLeastOne = p(`${r.label} et total équipe ${k} plus de 0.5 buts`);
      // La victoire de l'équipe k donne au moins un but à cette équipe ; avec la double chance, seul le 0-0 est retiré.
      assert.ok(near(atLeastOne, code[0] === "V" ? p(r.label) : p(r.label) - M[0][0]), `${code} total ${k} 0.5 ${at}`);
    }
    // Équipe 1 gagne ET marque plus de n : au moins aussi rare que le total de buts du match ne l'exige.
    assert.ok(p("Victoire équipe 1 et total équipe 1 plus de 2.5 buts") <= p("Victoire équipe 1 et plus de 2.5 buts") + 1e-12, at);
    assert.ok(p("Victoire équipe 2 et total équipe 2 plus de 2.5 buts") <= p("Victoire équipe 2 et plus de 2.5 buts") + 1e-12, at);
  }
});

test("cohérence : « au moins une équipe marque plus de n » = 1 − (aucune équipe ne dépasse n)", () => {
  for (const [lh, la, M] of GRID) {
    const p = (label) => evaluate(M, resolveMarket(label)).p;
    const at = `λ = ${lh}, ${la}`;
    for (const n of [0.5, 1.5, 2.5, 3.5]) {
      let nobody = 0;
      for (const [h, a] of SCORES) if (h <= n && a <= n) nobody += M[h][a];
      const one = p(`Au moins une équipe marque plus de ${n} buts`);
      assert.ok(near(one, 1 - nobody), `${n} ${at}`);
      assert.ok(one <= p(`Plus de ${n} buts`) + 1e-12, `${n} ${at}`);
      if (n <= 2.5) {
        // Les paris sur le total d'une équipe vont jusqu'à 2.5 buts.
        assert.ok(one >= p(`Équipe 1 plus de ${n} buts`) - 1e-12 && one >= p(`Équipe 2 plus de ${n} buts`) - 1e-12, `${n} ${at}`);
        assert.ok(one <= p(`Équipe 1 plus de ${n} buts`) + p(`Équipe 2 plus de ${n} buts`) + 1e-12, `${n} ${at}`);
      }
    }
    // Au moins un but dans le match = au moins une équipe marque.
    assert.ok(near(p("Au moins une équipe marque plus de 0.5 buts"), p("Plus de 0.5 buts")), at);
  }
});

test("le côté de l'équipe 1 et de l'équipe 2 : échanger les équipes échange les paris correspondants", () => {
  for (const [lh, la] of [[1.9, 0.8], [0.6, 1.4], [2.6, 1.9]]) {
    const A = scoreMatrix(lh, la);
    const B = scoreMatrix(la, lh);
    const pa = (label) => evaluate(A, resolveMarket(label)).p;
    const pb = (label) => evaluate(B, resolveMarket(label)).p;
    for (const [one, two] of [
      ["Victoire équipe 1", "Victoire équipe 2"],
      ["Victoire ou nul équipe 1", "Victoire ou nul équipe 2"],
      ["Équipe 1 plus de 1.5 buts", "Équipe 2 plus de 1.5 buts"],
      ["Équipe 1 moins de 2 buts", "Équipe 2 moins de 2 buts"],
      ["Victoire équipe 1 et plus de 2.5 buts", "Victoire équipe 2 et plus de 2.5 buts"],
      ["Victoire ou nul équipe 1 et moins de 3.5 buts", "Victoire ou nul équipe 2 et moins de 3.5 buts"],
      ["Victoire équipe 1 et total équipe 1 plus de 1.5 buts", "Victoire équipe 2 et total équipe 2 plus de 1.5 buts"],
      ["Victoire ou nul équipe 1 et total équipe 1 moins de 2.5 buts", "Victoire ou nul équipe 2 et total équipe 2 moins de 2.5 buts"],
    ]) {
      assert.ok(near(pa(one), pb(two)), `${one} / ${two} (${lh}, ${la})`);
      assert.ok(near(pa(two), pb(one)), `${two} / ${one} (${lh}, ${la})`);
    }
    for (const label of ["Plus de 2 buts", "Les deux équipes marquent", "Au moins une équipe marque plus de 1.5 buts", "Match nul"]) assert.ok(near(pa(label), pb(label)), label);
  }
});

// ---------- Noms acceptés ----------

test("écritures tolérées : majuscules, accents, virgule décimale, parenthèses, singulier et pluriel", () => {
  const same = (a, b) => assert.equal(resolveMarket(a), resolveMarket(b), `${a} / ${b}`);
  same("PLUS DE 2.5 BUTS", "Plus de 2.5 buts");
  same("plus de (2.5) but", "Plus de 2.5 buts");
  same("Plus de 2,5 buts", "Plus de 2.5 buts");
  same("plus de (1) but", "Plus de 1 but");
  same("Plus de 1 buts", "Plus de 1 but");
  same("moins de 0,5 but", "Moins de 0.5 buts");
  same("Equipe 1 plus de 1.5 buts", "Équipe 1 plus de 1.5 buts");
  same("Total équipe 2 moins de 2 buts", "Équipe 2 moins de 2 buts");
  same("Total 1 plus de 0.5 but", "Équipe 1 plus de 0.5 buts");
  same("victoire equipe 1", "Victoire équipe 1");
  same("Victoire ou nul equipe 2", "Victoire ou nul équipe 2");
  same("V1 et plus de 0,5 but", "Victoire équipe 1 et plus de 0.5 buts");
  same("v2 et moins de 3.5 buts", "Victoire équipe 2 et moins de 3.5 buts");
  same("1x et plus de 1.5 but", "Victoire ou nul équipe 1 et plus de 1.5 buts");
  same("2X et moins de 2.5 buts", "Victoire ou nul équipe 2 et moins de 2.5 buts");
  same("Au moins une équipe plus de 1.5 buts", "Au moins une équipe marque plus de 1.5 buts");
  same("1X et Total 1 moins de 2.5 but", "Victoire ou nul équipe 1 et total équipe 1 moins de 2.5 buts");
  same("V2 et Total 2 plus de 3.5 buts", "Victoire équipe 2 et total équipe 2 plus de 3.5 buts");
  same("  V1   et   Total 1  plus de 0.5  but ", "Victoire équipe 1 et total équipe 1 plus de 0.5 buts");
});

test("paris qui n'existent pas : refusés (le total de l'équipe 1 ne se combine pas avec le résultat de l'équipe 2)", () => {
  for (const label of [
    "Autre",
    "",
    "Plus de 4.5 buts",
    "Plus de 3.5 but 2",
    "Moins de 0 but",
    "Équipe 1 plus de 3 buts",
    "Équipe 1 plus de 3.5 buts",
    "Équipe 3 plus de 1.5 buts",
    "V1 et plus de 4.5 buts",
    "V1 et moins de 0.5 buts",
    "V1 et moins de 1 but",
    "Au moins une équipe marque plus de 1 but",
    "Au moins une équipe marque plus de 4.5 buts",
    "V1 et Total 2 plus de 0.5 but",
    "V2 et Total 1 plus de 0.5 but",
    "1X et Total 2 moins de 1.5 but",
    "2X et Total 1 moins de 1.5 but",
    "V1 et Total 1 moins de 0.5 but",
    "Victoire équipe 3",
  ]) {
    assert.equal(resolveMarket(label), null, `« ${label} » ne devrait pas exister`);
  }
  assert.equal(resolveMarket(undefined), null);
  assert.equal(resolveMarket(null), null);
  assert.equal(resolveMarket(42), null);
  assert.equal(resolveMarket({}), null);
});

// ---------- Anciens noms (anciennes versions de l'application et historique des téléphones) ----------

// ancien nom -> [nom actuel, ce que l'ancien nom voulait dire (score -> gagné ?)]
const LEGACY = [
  ["Victoire domicile", "Victoire équipe 1", (h, a) => h > a],
  ["Victoire extérieur", "Victoire équipe 2", (h, a) => a > h],
  ["Victoire exterieur", "Victoire équipe 2", (h, a) => a > h],
  ["Victoire ou nul domicile", "Victoire ou nul équipe 1", (h, a) => h >= a],
  ["Victoire ou nul extérieur", "Victoire ou nul équipe 2", (h, a) => a >= h],
  ["Victoire ou nul exterieur", "Victoire ou nul équipe 2", (h, a) => a >= h],
  ["Victoire domicile ou extérieur", "Victoire équipe 1 ou équipe 2", (h, a) => h !== a],
  ["Total buts 1.5 plus", "Plus de 1.5 buts", (h, a) => h + a > 1.5],
  ["Equipe domicile 0.5 buts plus", "Équipe 1 plus de 0.5 buts", (h) => h > 0.5],
  ["Equipe domicile 1.5 buts plus", "Équipe 1 plus de 1.5 buts", (h) => h > 1.5],
  ["Equipe domicile 2.5 buts plus", "Équipe 1 plus de 2.5 buts", (h) => h > 2.5],
  ["Equipe extérieur 0.5 buts plus", "Équipe 2 plus de 0.5 buts", (h, a) => a > 0.5],
  ["Equipe extérieur 1.5 buts plus", "Équipe 2 plus de 1.5 buts", (h, a) => a > 1.5],
  ["Equipe extérieur 2.5 buts plus", "Équipe 2 plus de 2.5 buts", (h, a) => a > 2.5],
  ["Equipe exterieur 2.5 buts plus", "Équipe 2 plus de 2.5 buts", (h, a) => a > 2.5],
  ["Victoire/nul domicile + 0.5 buts plus", "Victoire ou nul équipe 1 et plus de 0.5 buts", (h, a) => h >= a && h + a > 0.5],
  ["Victoire/nul domicile + 1.5 buts plus", "Victoire ou nul équipe 1 et plus de 1.5 buts", (h, a) => h >= a && h + a > 1.5],
  ["Victoire/nul domicile + 2.5 buts plus", "Victoire ou nul équipe 1 et plus de 2.5 buts", (h, a) => h >= a && h + a > 2.5],
  ["Victoire/nul extérieur + 0.5 buts plus", "Victoire ou nul équipe 2 et plus de 0.5 buts", (h, a) => a >= h && h + a > 0.5],
  ["Victoire/nul extérieur + 1.5 buts plus", "Victoire ou nul équipe 2 et plus de 1.5 buts", (h, a) => a >= h && h + a > 1.5],
  ["Victoire/nul extérieur + 2.5 buts plus", "Victoire ou nul équipe 2 et plus de 2.5 buts", (h, a) => a >= h && h + a > 2.5],
  ["Victoire/nul exterieur + 2.5 buts plus", "Victoire ou nul équipe 2 et plus de 2.5 buts", (h, a) => a >= h && h + a > 2.5],
  ["Victoire domicile + 1.5 buts plus", "Victoire équipe 1 et plus de 1.5 buts", (h, a) => h > a && h + a > 1.5],
  ["Victoire domicile + 2.5 buts plus", "Victoire équipe 1 et plus de 2.5 buts", (h, a) => h > a && h + a > 2.5],
  ["Victoire extérieur + 1.5 buts plus", "Victoire équipe 2 et plus de 1.5 buts", (h, a) => a > h && h + a > 1.5],
  ["Victoire extérieur + 2.5 buts plus", "Victoire équipe 2 et plus de 2.5 buts", (h, a) => a > h && h + a > 2.5],
  ["Victoire exterieur + 2.5 buts plus", "Victoire équipe 2 et plus de 2.5 buts", (h, a) => a > h && h + a > 2.5],
  ...[0.5, 1.5, 2.5, 3.5].flatMap((n) => [
    [`Plus de ${n} buts`, `Plus de ${n} buts`, (h, a) => h + a > n],
    [`Plus de ${n} but`, `Plus de ${n} buts`, (h, a) => h + a > n],
    [`Moins de ${n} buts`, `Moins de ${n} buts`, (h, a) => h + a < n],
  ]),
  ["Match nul", "Match nul", (h, a) => h === a],
  ["Les deux équipes marquent", "Les deux équipes marquent", (h, a) => h > 0 && a > 0],
  ["Les deux équipes ne marquent pas", "Les deux équipes ne marquent pas", (h, a) => h === 0 || a === 0],
  ["BTTS", "Les deux équipes marquent", (h, a) => h > 0 && a > 0],
  ["V1", "Victoire équipe 1", (h, a) => h > a],
  ["2", "Victoire équipe 2", (h, a) => a > h],
  ["1X", "Victoire ou nul équipe 1", (h, a) => h >= a],
  ["X2", "Victoire ou nul équipe 2", (h, a) => a >= h],
  ["12", "Victoire équipe 1 ou équipe 2", (h, a) => h !== a],
];

test("anciens noms de paris : reconnus, avec le même sens qu'avant (comparé score par score)", () => {
  for (const [old, current, wins] of LEGACY) {
    const m = resolveMarket(old);
    assert.ok(m, `ancien nom non reconnu : ${old}`);
    assert.equal(m.label, current, `${old} devrait donner ${current}`);
    for (const [h, a] of SCORES) assert.equal(settle(m, h, a) === "win", wins(h, a), `${old} pour ${h}-${a}`);
    assert.equal(m.push, null, `${old} n'était pas remboursable`);
  }
});

// ---------- Fonctions d'ensemble ----------

test("evaluateAll : un résultat par pari ; « push » seulement pour les paris remboursables ; probabilités entre 0 et 1", () => {
  const all = evaluateAll(scoreMatrix(1.4, 1.0));
  assert.equal(all.length, MARKETS.length);
  assert.deepEqual(all.map((x) => x.label), MARKETS.map((m) => m.label));
  for (const [i, x] of all.entries()) {
    assert.ok(x.p >= 0 && x.p <= 1, x.label);
    if (MARKETS[i].push) assert.ok(x.push > 0 && x.push < 1, `${x.label} : remboursement ${x.push}`);
    else assert.equal(x.push, undefined, x.label);
  }
});

test("describeMatrix : résultats principaux et score le plus probable sous les noms actuels", () => {
  const M = scoreMatrix(1.8, 1.0);
  const d = describeMatrix(M);
  const p = (label) => evaluate(M, resolveMarket(label)).p;
  assert.equal(LABEL.HOME, "Victoire équipe 1");
  assert.equal(LABEL.AWAY, "Victoire équipe 2");
  assert.ok(near(d.outcomes.home, p("Victoire équipe 1")) && near(d.outcomes.away, p("Victoire équipe 2")) && near(d.outcomes.draw, p("Match nul")));
  assert.ok(near(d.outcomes.over25, p("Plus de 2.5 buts")) && near(d.outcomes.btts, p("Les deux équipes marquent")));
  assert.equal(d.probs.length, MARKETS.length);
  assert.match(d.likelyScore, /^\d-\d$/);
});

test("taux moyens (baseRate) : définis pour tous les paris, entre 0 et 1, et cohérents entre eux", () => {
  const rates = new Map(MARKETS.map((m) => [m.label, baseRate(m)]));
  for (const [label, r] of rates) assert.ok(Number.isFinite(r) && r > 0 && r < 1, `${label} : ${r}`);
  assert.ok(near(rates.get("Plus de 2.5 buts") + rates.get("Moins de 2.5 buts"), 1));
  assert.ok(rates.get("Plus de 0.5 buts") > 0.9 && rates.get("Match nul") > 0.2 && rates.get("Match nul") < 0.35);
});

test("rapidité : calculer les 102 paris d'un match reste quasi instantané", () => {
  const M = scoreMatrix(1.5, 1.2);
  const t0 = Date.now();
  let acc = 0;
  for (let i = 0; i < 3000; i++) acc += evaluateAll(M)[0].p;
  assert.ok(acc > 0);
  assert.ok(Date.now() - t0 < 4000, `trop lent : ${Date.now() - t0} ms pour 3000 matchs`);
});

test("« Score exact » reste reconnu et renvoie le score le plus probable", () => {
  const out = evaluate(scoreMatrix(1.1, 0.9), resolveMarket("Score exact"));
  assert.match(out.detail, /^\d-\d$/);
  assert.ok(out.p > 0.05 && out.p < 0.2);
  assert.equal(MARKETS.some((m) => m.label === "Score exact"), false, "il ne fait pas partie des paris choisis automatiquement");
});
