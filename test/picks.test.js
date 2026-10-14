"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { bestForFixture, selectTop } = require("../src/picks");
const { MARKETS, evaluateAll } = require("../src/markets");
const { scoreMatrix } = require("../src/model");
const { mulberry32 } = require("./helpers");

const leg = (label, p, extra = {}) => ({ label, p, ...extra });

test("bestForFixture : le pari le plus probable, sans plage ni plafond de cote", () => {
  const probs = [leg("Plus de 0.5 buts", 0.94), leg("Victoire ou nul équipe 1", 0.84), leg("Plus de 1.5 buts", 0.7), leg("Match nul", 0.25)];
  // 94 % n'est plus écarté comme « trop probable » : c'est le pari le plus fiable, donc il est retenu.
  assert.equal(bestForFixture(probs).label, "Plus de 0.5 buts");
  assert.equal(bestForFixture([leg("Match nul", 0.25), leg("Score exact", 0.1)]).label, "Match nul");
  assert.equal(bestForFixture([leg("Plus de 0.5 buts", 0.999)]).label, "Plus de 0.5 buts");
  assert.equal(bestForFixture([]), null);
});

test("bestForFixture : plafond et plancher facultatifs (PICK_MAX_PROBABILITY)", () => {
  const probs = [leg("Plus de 0.5 buts", 0.94), leg("Victoire ou nul équipe 1", 0.84), leg("Plus de 1.5 buts", 0.7), leg("Match nul", 0.25)];
  assert.equal(bestForFixture(probs, { maxP: 0.9 }).label, "Victoire ou nul équipe 1");
  assert.equal(bestForFixture(probs, { maxP: 0.8 }).label, "Plus de 1.5 buts");
  assert.equal(bestForFixture(probs, { maxP: 0.94 }).label, "Plus de 0.5 buts", "le plafond est inclus");
  assert.equal(bestForFixture(probs, { minP: 0.9 }).label, "Plus de 0.5 buts");
  assert.equal(bestForFixture(probs, { minP: 0.95 }), null);
  assert.equal(bestForFixture(probs, { maxP: 0.2 }), null);
});

test("bestForFixture : à probabilité égale, le pari le plus simple ; une vraie différence l'emporte sur la simplicité", () => {
  // Deux écritures du même événement : « plus de 0.5 buts » est plus simple.
  const same = [leg("Au moins une équipe marque plus de 0.5 buts", 0.92), leg("Plus de 0.5 buts", 0.92)];
  assert.equal(bestForFixture(same).label, "Plus de 0.5 buts");
  assert.equal(bestForFixture([...same].reverse()).label, "Plus de 0.5 buts", "indépendant de l'ordre d'entrée");
  const nearly = [leg("Plus de 0.5 buts", 0.92), leg("Au moins une équipe marque plus de 0.5 buts", 0.92 + 1e-12)];
  assert.equal(bestForFixture(nearly).label, "Plus de 0.5 buts", "écart numérique négligeable : égalité");
  const better = [leg("Plus de 0.5 buts", 0.92), leg("Victoire équipe 1 et plus de 2.5 buts", 0.921)];
  assert.equal(bestForFixture(better).label, "Victoire équipe 1 et plus de 2.5 buts");
  // Un pari inconnu de la liste des marchés perd les égalités.
  assert.equal(bestForFixture([leg("Pari inconnu", 0.8), leg("Match nul", 0.8)]).label, "Match nul");
  // À égalité, un pari remboursable cède la place à un pari qui ne l'est pas, même s'il est plus compliqué.
  const tie = [leg("Moins de 1 but", 0.95, { push: 0.1 }), leg("Moins de 1.5 buts", 0.95, { push: 0 })];
  assert.equal(bestForFixture(tie).label, "Moins de 1.5 buts");
});

test("bestForFixture : ne modifie pas la liste reçue et rend un des éléments tels quels", () => {
  const probs = [leg("Plus de 1.5 buts", 0.7), leg("Plus de 0.5 buts", 0.94)];
  const copy = JSON.parse(JSON.stringify(probs));
  const best = bestForFixture(probs);
  assert.deepEqual(probs, copy);
  assert.equal(best, probs[1]);
});

test("bestForFixture sur les vrais marchés : c'est bien le maximum, jamais une ligne entière remboursable", () => {
  const rand = mulberry32(5);
  const wholeLines = new Set(MARKETS.filter((m) => m.push).map((m) => m.label));
  assert.equal(wholeLines.size, 14);
  for (let i = 0; i < 400; i++) {
    const lh = 0.25 + rand() * 3.3;
    const la = 0.2 + rand() * 2.8;
    const probs = evaluateAll(scoreMatrix(lh, la));
    const best = bestForFixture(probs);
    const max = Math.max(...probs.map((x) => x.p));
    assert.ok(Math.abs(best.p - max) < 1e-9, `${best.label} : ${best.p} contre ${max} (λ = ${lh.toFixed(2)}, ${la.toFixed(2)})`);
    // Une ligne entière se place entre les deux demi-lignes voisines : elle n'est jamais strictement la plus probable.
    assert.ok(!wholeLines.has(best.label), `${best.label} (λ = ${lh.toFixed(2)}, ${la.toFixed(2)})`);
  }
});

test("bestForFixture : un favori écrasant donne un pari de l'équipe adverse « moins de », pas une cote artificielle", () => {
  const probs = evaluateAll(scoreMatrix(3.2, 0.35));
  const best = bestForFixture(probs);
  assert.ok(best.p > 0.95, `${best.label} ${best.p}`);
  const capped = bestForFixture(probs, { maxP: 0.9 });
  assert.ok(capped.p <= 0.9 && capped.p > 0.6, `${capped.label} ${capped.p}`);
});

const fx = (id, p, extra = {}) => ({ id, kickoff: 1000 + Number(id.slice(1)), quality: 2, best: { label: `pari ${id}`, p }, ...extra });

test("selectTop : les trois matchs dont le meilleur pari est le plus probable", () => {
  const fixtures = [fx("F1", 0.7), fx("F2", 0.95), fx("F3", 0.8), fx("F4", 0.9), fx("F5", 0.6), fx("F6", 0.85)];
  assert.deepEqual(selectTop(fixtures, { count: 3 }).map((f) => f.id), ["F2", "F4", "F6"]);
  assert.deepEqual(selectTop(fixtures).map((f) => f.id), ["F2", "F4", "F6"], "trois par défaut");
  assert.deepEqual(selectTop(fixtures, { count: 1 }).map((f) => f.id), ["F2"]);
  assert.deepEqual(selectTop(fixtures, { count: 10 }).map((f) => f.id), ["F2", "F4", "F6", "F3", "F1", "F5"]);
});

test("selectTop : peu de matchs, matchs sans pari, liste vide", () => {
  assert.deepEqual(selectTop([], { count: 3 }), []);
  assert.deepEqual(selectTop([fx("F1", 0.8)], { count: 3 }).map((f) => f.id), ["F1"]);
  const noBest = [{ id: "F9", kickoff: 1, quality: 2, best: null }, fx("F1", 0.8), { id: "F8", kickoff: 2, quality: 2 }];
  assert.deepEqual(selectTop(noBest, { count: 3 }).map((f) => f.id), ["F1"]);
});

test("selectTop : à probabilité voisine, les équipes bien connues du modèle passent devant (un point par niveau)", () => {
  const fixtures = [fx("F1", 0.9, { quality: 0 }), fx("F2", 0.895, { quality: 1 }), fx("F3", 0.89, { quality: 2 }), fx("F4", 0.88, { quality: 2 })];
  // Scores : F1 0,90 ; F2 0,905 ; F3 0,91 ; F4 0,90 (égalité avec F1 : coup d'envoi le plus proche).
  assert.deepEqual(selectTop(fixtures, { count: 3 }).map((f) => f.id), ["F3", "F2", "F1"]);
  // Mais un écart de probabilité de plus de deux points ne se rattrape pas.
  const far = [fx("F1", 0.96, { quality: 0 }), fx("F2", 0.9, { quality: 2 }), fx("F3", 0.9, { quality: 2 }), fx("F4", 0.9, { quality: 2 })];
  assert.equal(selectTop(far, { count: 3 })[0].id, "F1");
});

test("selectTop : égalité parfaite, le match qui commence le premier ; l'entrée n'est pas modifiée", () => {
  const a = { id: "A", kickoff: 50, quality: 2, best: { label: "x", p: 0.9 } };
  const b = { id: "B", kickoff: 10, quality: 2, best: { label: "x", p: 0.9 } };
  const c = { id: "C", kickoff: 30, quality: 2, best: { label: "x", p: 0.9 } };
  const list = [a, b, c];
  assert.deepEqual(selectTop(list, { count: 2 }).map((f) => f.id), ["B", "C"]);
  assert.deepEqual(list.map((f) => f.id), ["A", "B", "C"]);
});

test("selectTop : même résultat qu'un tri complet indépendant, et reste rapide avec beaucoup de matchs", () => {
  const rand = mulberry32(21);
  const fixtures = Array.from({ length: 5000 }, (_, i) => ({ id: `F${i}`, kickoff: i, quality: Math.floor(rand() * 3), best: { label: "x", p: 0.5 + rand() * 0.49 } }));
  const t0 = Date.now();
  const top = selectTop(fixtures, { count: 3 });
  assert.ok(Date.now() - t0 < 500, `trop lent : ${Date.now() - t0} ms`);
  const expected = [...fixtures].sort((x, y) => y.best.p + 0.01 * y.quality - (x.best.p + 0.01 * x.quality)).slice(0, 3).map((f) => f.id);
  assert.deepEqual(top.map((f) => f.id), expected);
  assert.equal(new Set(top.map((f) => f.id)).size, 3);
});
