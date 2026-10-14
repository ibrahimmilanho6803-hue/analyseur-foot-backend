"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { bestForFixture, selectTop } = require("../src/picks");
const { mulberry32 } = require("./helpers");

const leg = (label, p, extra = {}) => ({ label, p, ...extra });

test("bestForFixture : le pari le plus probable, sans plafond de probabilité ni plancher", () => {
  const probs = [leg("Plus de 0.5 buts", 0.94), leg("Victoire ou nul domicile", 0.84), leg("Plus de 1.5 buts", 0.7), leg("Match nul", 0.25)];
  assert.equal(bestForFixture(probs).label, "Plus de 0.5 buts", "94 % est retenu : il n'y a plus de plafond à 88 %");
  assert.equal(bestForFixture([leg("Match nul", 0.25), leg("Score exact", 0.1)]).label, "Match nul", "25 % est retenu : il n'y a plus de plancher à 55 %");
  assert.equal(bestForFixture([leg("Plus de 0.5 buts", 0.99)]).p, 0.99);
  assert.equal(bestForFixture([]), null);
});

test("bestForFixture : ne dépend ni de la cote ni de l'ordre des paris", () => {
  const rand = mulberry32(3);
  const probs = Array.from({ length: 60 }, (_, i) => leg(`Pari ${i}`, rand()));
  const expected = probs.reduce((a, b) => (b.p > a.p ? b : a));
  assert.equal(bestForFixture(probs).label, expected.label);
  assert.equal(bestForFixture([...probs].reverse()).label, expected.label);
});

test("bestForFixture : les paris à ligne entière (remboursables) sont écartés, même s'ils sont plus probables à gagner", () => {
  const probs = [leg("Plus de 1 but", 0.9, { refund: true, push: 0.08 }), leg("Plus de 1.5 buts", 0.75), leg("Moins de 3 buts", 0.97, { refund: true, push: 0.01 })];
  assert.equal(bestForFixture(probs).label, "Plus de 1.5 buts");
  assert.equal(bestForFixture([leg("Plus de 2 buts", 0.9, { refund: true, push: 0.05 })]), null, "rien d'autre à proposer");
});

test("bestForFixture : à probabilité égale, le pari le plus simple l'emporte", () => {
  const tie = [leg("Victoire/nul domicile + 0.5 buts plus", 0.8), leg("Victoire ou nul domicile", 0.8)];
  assert.equal(bestForFixture(tie).label, "Victoire ou nul domicile");
  assert.equal(bestForFixture([...tie].reverse()).label, "Victoire ou nul domicile");
  // Deux écritures du même pari : « au moins une équipe plus de 0.5 buts » est « plus de 0.5 buts ».
  const same = [leg("Au moins une équipe plus de 0.5 buts", 0.92), leg("Plus de 0.5 buts", 0.92)];
  assert.equal(bestForFixture(same).label, "Plus de 0.5 buts");
});

const fixture = (id, p, quality = 2, kickoff = 1000) => ({ id, kickoff, quality, pick: leg(`pari ${id}`, p) });

test("selectTop : les trois matchs au pari le plus fiable, du plus au moins fiable, sans limite de cote", () => {
  const fixtures = [fixture("a", 0.9), fixture("b", 0.97), fixture("c", 0.7), fixture("d", 0.99), fixture("e", 0.95), fixture("f", 0.4)];
  assert.deepEqual(selectTop(fixtures, { count: 3 }).map((f) => f.id), ["d", "b", "e"]);
  assert.deepEqual(selectTop(fixtures).map((f) => f.id), ["d", "b", "e"], "trois par défaut");
  assert.deepEqual(selectTop(fixtures, { count: 1 }).map((f) => f.id), ["d"]);
});

test("selectTop : même résultat que le classement complet, quel que soit l'ordre d'entrée", () => {
  const rand = mulberry32(8);
  const fixtures = Array.from({ length: 200 }, (_, i) => fixture(`F${i}`, 0.5 + rand() * 0.49, 2, i));
  const expected = [...fixtures].sort((a, b) => b.pick.p - a.pick.p).slice(0, 3).map((f) => f.id);
  assert.deepEqual(selectTop(fixtures).map((f) => f.id), expected);
  assert.deepEqual(selectTop([...fixtures].reverse()).map((f) => f.id), expected);
});

test("selectTop : à fiabilité voisine (1 point par niveau), préfère les équipes bien connues du modèle", () => {
  const fixtures = [fixture("connu", 0.93, 2), fixture("moyen", 0.935, 1), fixture("inconnu", 0.94, 0), fixture("autre", 0.5, 2)];
  assert.deepEqual(selectTop(fixtures, { count: 3 }).map((f) => f.id), ["connu", "moyen", "inconnu"]);
  // Mais un écart net de fiabilité l'emporte sur la connaissance des équipes.
  const net = [fixture("sur", 0.98, 0), fixture("moins-sur", 0.9, 2)];
  assert.deepEqual(selectTop(net, { count: 2 }).map((f) => f.id), ["sur", "moins-sur"]);
});

test("selectTop : à égalité, le match qui commence le premier passe devant", () => {
  const fixtures = [fixture("tard", 0.9, 2, 300), fixture("tot", 0.9, 2, 100), fixture("milieu", 0.9, 2, 200)];
  assert.deepEqual(selectTop(fixtures, { count: 2 }).map((f) => f.id), ["tot", "milieu"]);
});

test("selectTop : peu de matchs, aucun match, matchs sans pari, même match proposé deux fois", () => {
  assert.equal(selectTop([fixture("a", 0.9), fixture("b", 0.8)], { count: 3 }).length, 2);
  assert.deepEqual(selectTop([], { count: 3 }), []);
  assert.deepEqual(selectTop([{ id: "x", kickoff: 1, quality: 2, pick: null }, null], { count: 3 }), []);
  assert.deepEqual(selectTop([fixture("a", 0.9), fixture("a", 0.9), fixture("b", 0.8)], { count: 3 }).map((f) => f.id), ["a", "b"]);
});

test("selectTop : reste instantané avec beaucoup de matchs", () => {
  const rand = mulberry32(2);
  const fixtures = Array.from({ length: 5000 }, (_, i) => fixture(`F${i}`, rand(), 2, i));
  const t0 = Date.now();
  assert.equal(selectTop(fixtures).length, 3);
  assert.ok(Date.now() - t0 < 200, `trop lent : ${Date.now() - t0} ms`);
});
