"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { thinLegs, selectCoupon, bestForFixture } = require("../src/picks");
const { mulberry32 } = require("./helpers");

const leg = (label, p) => ({ label, p });

test("thinLegs : respecte la plage et supprime les quasi-doublons en gardant le pari le plus simple", () => {
  const probs = [
    leg("Plus de 0.5 buts", 0.94), // trop probable
    leg("Victoire ou nul domicile", 0.82),
    leg("Victoire/nul domicile + 0.5 buts plus", 0.815), // quasi identique, plus compliqué
    leg("Plus de 1.5 buts", 0.7),
    leg("Match nul", 0.26), // trop improbable
    leg("Les deux équipes marquent", 0.56),
  ];
  const out = thinLegs(probs, { minP: 0.55, maxP: 0.88 });
  assert.deepEqual(
    out.map((x) => x.label),
    ["Les deux équipes marquent", "Plus de 1.5 buts", "Victoire ou nul domicile"]
  );
});

test("thinLegs : limite le nombre de sélections en gardant l'étalement", () => {
  const probs = Array.from({ length: 20 }, (_, i) => leg(`Plus de ${i}.5 buts`, 0.56 + i * 0.015));
  const out = thinLegs(probs, { minP: 0.55, maxP: 0.88, max: 5 });
  assert.equal(out.length, 5);
  assert.ok(out[0].p < 0.6 && out[4].p > 0.8);
});

// Brute force indépendante : meilleure probabilité conjointe qui reste sous l'objectif.
function bruteForce(fixtures, target) {
  let best = 0;
  const lim = 1 / target;
  const fs = fixtures;
  for (let i = 0; i < fs.length; i++)
    for (let j = i + 1; j < fs.length; j++)
      for (let k = j + 1; k < fs.length; k++)
        for (const a of fs[i].legs)
          for (const b of fs[j].legs)
            for (const c of fs[k].legs) {
              const joint = a.p * b.p * c.p;
              if (joint <= lim && joint > best) best = joint;
            }
  return best;
}

function randomFixtures(count, seed) {
  const rand = mulberry32(seed);
  const leagues = ["PL", "PD", "SA", "BL1", "FL1"];
  return Array.from({ length: count }, (_, i) => ({
    id: `F${i}`,
    leagueKey: leagues[i % leagues.length],
    kickoff: 1000 + i,
    quality: 2,
    legs: Array.from({ length: 5 }, (_, j) => leg(`pari ${i}-${j}`, 0.55 + rand() * 0.33)),
  }));
}

test("selectCoupon : trois matchs différents, objectif atteint, probabilité conjointe quasi optimale", () => {
  for (const seed of [1, 2, 3, 4]) {
    const fixtures = randomFixtures(12, seed);
    const r = selectCoupon(fixtures, { count: 3, targetOdds: 2.5 });
    assert.equal(r.legs.length, 3);
    assert.equal(new Set(r.legs.map((l) => l.fixture.id)).size, 3, "trois matchs distincts");
    assert.equal(r.targetReached, true);
    assert.ok(r.joint <= 0.4 + 1e-9, `joint ${r.joint}`);
    assert.ok(r.fairOdds >= 2.5 - 1e-9);
    const optimum = bruteForce(fixtures, 2.5);
    assert.ok(optimum - r.joint < 0.03, `optimum ${optimum} vs choisi ${r.joint}`);
  }
});

test("selectCoupon : plus de trois sélections possibles, une seule par match", () => {
  const r = selectCoupon(randomFixtures(8, 9), { count: 3, targetOdds: 2.5 });
  const ids = r.legs.map((l) => l.fixture.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    r.legs.map((l) => l.fixture.kickoff),
    [...r.legs.map((l) => l.fixture.kickoff)].sort((a, b) => a - b),
    "classées par heure de coup d'envoi"
  );
});

test("selectCoupon : si l'objectif est inatteignable, on prend la cote la plus haute et on le signale", () => {
  const safe = Array.from({ length: 5 }, (_, i) => ({ id: `S${i}`, leagueKey: "PL", kickoff: i, quality: 2, legs: [leg("a", 0.85), leg("b", 0.8)] }));
  const r = selectCoupon(safe, { count: 3, targetOdds: 2.5 });
  assert.equal(r.targetReached, false);
  assert.ok(Math.abs(r.joint - 0.8 ** 3) < 1e-9, "le trio le plus risqué possible, donc la cote la plus haute");
});

test("selectCoupon : peu de matchs disponibles", () => {
  const two = randomFixtures(2, 3);
  assert.equal(selectCoupon(two, { count: 3 }).legs.length, 2);
  assert.equal(selectCoupon([], { count: 3 }).legs.length, 0);
  const noLegs = [{ id: "x", leagueKey: "PL", kickoff: 1, quality: 2, legs: [] }];
  assert.equal(selectCoupon(noLegs, { count: 3 }).legs.length, 0);
});

test("selectCoupon : préfère les équipes bien connues du modèle à probabilité conjointe voisine", () => {
  const mk = (id, quality, p) => ({ id, leagueKey: "PL", kickoff: 1, quality, legs: [leg("x", p)] });
  const fixtures = [mk("a", 2, 0.74), mk("b", 2, 0.74), mk("c", 2, 0.74), mk("d", 0, 0.74)];
  const r = selectCoupon(fixtures, { count: 3, targetOdds: 2.5 });
  assert.ok(!r.legs.some((l) => l.fixture.id === "d"));
});

test("selectCoupon : reste rapide avec beaucoup de matchs", () => {
  const fixtures = randomFixtures(80, 11).map((f) => ({ ...f, legs: [...f.legs, leg("extra", 0.7)] }));
  const t0 = Date.now();
  const r = selectCoupon(fixtures, { count: 3, targetOdds: 2.5 });
  assert.equal(r.legs.length, 3);
  assert.ok(Date.now() - t0 < 2000, `trop lent : ${Date.now() - t0} ms`);
});

test("bestForFixture : le plus probable dans la plage, sinon le plus proche", () => {
  const probs = [leg("Plus de 0.5 buts", 0.94), leg("Victoire ou nul domicile", 0.84), leg("Plus de 1.5 buts", 0.7), leg("Match nul", 0.25)];
  assert.equal(bestForFixture(probs).label, "Victoire ou nul domicile");
  assert.equal(bestForFixture(probs, { minP: 0.55, maxP: 0.8 }).label, "Plus de 1.5 buts");
  assert.equal(bestForFixture([leg("Match nul", 0.25), leg("Score exact", 0.1)]).label, "Match nul");
  assert.equal(bestForFixture([leg("Plus de 0.5 buts", 0.95)]), null);
  // À probabilité égale, le pari le plus simple l'emporte.
  const tie = [leg("Victoire/nul domicile + 0.5 buts plus", 0.8), leg("Victoire ou nul domicile", 0.8)];
  assert.equal(bestForFixture(tie).label, "Victoire ou nul domicile");
});
