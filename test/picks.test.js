"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { legTarget, thinLegs, fitLegs, selectAll, selectCoupon, nearestPick, pickWindow } = require("../src/picks");
const { MARKETS, evaluateAll } = require("../src/markets");
const { scoreMatrix } = require("../src/model");
const { mulberry32 } = require("./helpers");

const leg = (label, p, extra = {}) => ({ label, p, ...extra });
// Des paris aux libellés réels (donc à la simplicité réelle : le rang dans MARKETS) pour une liste de probabilités.
const legsOf = (ps) => ps.map((p, i) => leg(MARKETS[i].label, p));
const product = (legs) => legs.reduce((acc, l) => acc * l.p, 1);
const realProbs = (lh, la) => evaluateAll(scoreMatrix(lh, la));

test("legTarget : probabilité de chaque pari d'un coupon équilibré qui atteint juste la cote visée", () => {
  assert.ok(Math.abs(legTarget(5, 4) - 0.6687) < 1e-4, String(legTarget(5, 4)));
  assert.ok(Math.abs(legTarget(5, 1) - 0.2) < 1e-12);
  assert.ok(Math.abs(legTarget(2.5, 3) - 0.7368) < 1e-4);
  assert.ok(Math.abs(Math.pow(legTarget(5, 4), 4) - 0.2) < 1e-12);
  assert.ok(Number.isFinite(legTarget(5, 0)), "un nombre de paris nul ne casse rien");
});

test("thinLegs : plage de probabilité, quasi-doublons écartés (non remboursable, puis le plus simple), triés", () => {
  const probs = [
    leg("Équipe 2 plus de 2.5 buts", 0.7), // plus compliqué
    leg("Plus de 1.5 buts", 0.705), // même groupe de probabilités : le plus simple
    leg("Plus de 2 buts", 0.71, { push: 0.2 }), // remboursable : passe après
    leg("Match nul", 0.3), // hors plage
    leg("Victoire ou nul équipe 1", 0.8),
    leg("Plus de 0.5 buts", 0.95), // hors plage
  ];
  const legs = thinLegs(probs, { minP: 0.6, maxP: 0.9, gap: 0.02 });
  assert.deepEqual(legs.map((l) => l.label), ["Plus de 1.5 buts", "Victoire ou nul équipe 1"]);
  assert.deepEqual(legs.map((l) => l.p), [0.705, 0.8]);
  // Les bornes sont incluses.
  assert.deepEqual(thinLegs([leg("Plus de 1.5 buts", 0.6), leg("Plus de 2.5 buts", 0.9)], { minP: 0.6, maxP: 0.9 }).map((l) => l.p), [0.6, 0.9]);
  assert.deepEqual(thinLegs([], { minP: 0.6, maxP: 0.9 }), []);
  assert.deepEqual(thinLegs(probs, { minP: 0.96, maxP: 0.99 }), []);
});

test("thinLegs : à probabilité égale, le pari qui ne peut pas être remboursé l'emporte même s'il est moins simple", () => {
  const probs = [leg("Plus de 2 buts", 0.7, { push: 0.2 }), leg("Équipe 1 plus de 2.5 buts", 0.7)];
  assert.equal(thinLegs(probs, { minP: 0.5 })[0].label, "Équipe 1 plus de 2.5 buts");
  assert.equal(thinLegs([...probs].reverse(), { minP: 0.5 })[0].label, "Équipe 1 plus de 2.5 buts", "indépendant de l'ordre");
});

test("thinLegs : au plus `max` paris, les plus proches de la probabilité visée ; sinon un échantillon régulier ; l'entrée n'est pas modifiée", () => {
  const ps = Array.from({ length: 30 }, (_, i) => 0.6 + i * 0.01); // 0,60 … 0,89
  const probs = legsOf(ps);
  const copy = JSON.stringify(probs);
  const near = thinLegs(probs, { minP: 0.6, maxP: 0.9, around: 0.7, max: 5, gap: 0.005 });
  assert.equal(near.length, 5);
  assert.deepEqual(near.map((l) => Math.round(l.p * 100)), [68, 69, 70, 71, 72]);
  const even = thinLegs(probs, { minP: 0.6, maxP: 0.9, max: 4, gap: 0.005 });
  assert.equal(even.length, 4);
  assert.equal(even[0].p, 0.6);
  assert.ok(Math.abs(even[3].p - 0.89) < 1e-9);
  assert.ok(even.every((l, i) => i === 0 || l.p > even[i - 1].p));
  assert.equal(JSON.stringify(probs), copy);
});

test("fitLegs : le pari le plus faible aussi fort que possible, puis un produit le plus proche possible de la limite", () => {
  const sets = [legsOf([0.6, 0.7, 0.8]), legsOf([0.6, 0.7, 0.8])];
  const fit = fitLegs(sets, 0.5);
  assert.deepEqual(fit.rank, [1, 1], "0,7 × 0,7 = 0,49 : deux paris équilibrés plutôt que 0,8 × 0,6");
  assert.ok(Math.abs(fit.joint - 0.49) < 1e-12);
  // Marge restante : on relève d'abord le pari le plus faible, puis les autres, tant que la limite tient.
  const wide = fitLegs([legsOf([0.5, 0.9]), legsOf([0.5, 0.9])], 0.46);
  assert.deepEqual(wide.rank, [1, 0]);
  assert.ok(Math.abs(wide.joint - 0.45) < 1e-12);
});

test("fitLegs : hors d'atteinte, listes vides, aucun match", () => {
  assert.equal(fitLegs([legsOf([0.8]), legsOf([0.8])], 0.5), null, "même les paris les plus bas donnent 0,64 > 0,5");
  assert.equal(fitLegs([legsOf([0.6, 0.7]), []], 0.5), null);
  assert.equal(fitLegs([], 0.5), null);
  // Un seul match : un pari dont la probabilité ne dépasse pas la limite.
  const one = fitLegs([legsOf([0.1, 0.2, 0.3])], 0.25);
  assert.deepEqual(one.rank, [1]);
});

test("fitLegs : le produit ne dépasse jamais la limite et le pari le plus faible est maximal (essais aléatoires, comparés à une recherche exhaustive)", () => {
  const rand = mulberry32(8);
  for (let t = 0; t < 300; t++) {
    const n = 2 + Math.floor(rand() * 3);
    const sets = Array.from({ length: n }, () => legsOf(Array.from({ length: 2 + Math.floor(rand() * 4) }, () => 0.5 + rand() * 0.45).sort((a, b) => a - b)));
    const maxJoint = 0.05 + rand() * 0.4;
    const fit = fitLegs(sets, maxJoint);
    // Recherche exhaustive du plus grand « pari le plus faible » possible.
    let bestMin = -1;
    const walk = (i, prod, min) => {
      if (i === n) {
        if (prod <= maxJoint + 1e-9 && min > bestMin) bestMin = min;
        return;
      }
      for (const l of sets[i]) walk(i + 1, prod * l.p, Math.min(min, l.p));
    };
    walk(0, 1, 1);
    if (bestMin < 0) {
      assert.equal(fit, null);
      continue;
    }
    assert.ok(fit, `une solution existe (pari le plus faible ${bestMin})`);
    const chosen = fit.rank.map((k, i) => sets[i][k]);
    assert.ok(product(chosen) <= maxJoint + 1e-9);
    assert.ok(Math.abs(fit.joint - product(chosen)) < 1e-12);
    assert.ok(Math.abs(Math.min(...chosen.map((l) => l.p)) - bestMin) < 1e-12, `pari le plus faible ${Math.min(...chosen.map((l) => l.p))} au lieu de ${bestMin}`);
  }
});

const matches = [realProbs(1.9, 0.9), realProbs(1.2, 1.1), realProbs(0.9, 1.6), realProbs(2.3, 1.3), realProbs(1.4, 0.7), realProbs(1.1, 1.0)].map((probs) => ({ probs }));

test("selectAll : un pari par match, cote totale au moins égale à l'objectif, paris équilibrés autour de la probabilité visée", () => {
  const four = selectAll(matches.slice(0, 4), { targetOdds: 5 });
  assert.equal(four.targetReached, true);
  assert.equal(four.legs.length, 4);
  assert.ok(product(four.legs) <= 0.2 + 1e-12 && four.fairOdds >= 5, `cote ${four.fairOdds}`);
  assert.ok(product(four.legs) > 0.17, "juste sous la limite : pas de paris inutilement hasardeux");
  const ps = four.legs.map((l) => l.p);
  assert.ok(Math.min(...ps) >= 0.6 - 1e-9 && Math.max(...ps) <= 0.88 + 1e-9);
  assert.ok(Math.max(...ps) - Math.min(...ps) < 0.1, ps.join(", "));
  // Les paris sont rendus dans l'ordre des matchs reçus et appartiennent à leur match.
  four.legs.forEach((l, i) => assert.ok(matches[i].probs.includes(l), `pari ${i}`));
  // Plus de matchs : des paris plus sûrs pour la même cote.
  const six = selectAll(matches, { targetOdds: 5 });
  assert.equal(six.targetReached, true);
  assert.ok(Math.min(...six.legs.map((l) => l.p)) > Math.min(...ps) + 0.04);
  assert.ok(product(six.legs) <= 0.2 + 1e-12);
});

test("selectAll : trois matchs seulement, le seuil de 60 % descend à 55 % pour atteindre l'objectif ; deux matchs ou moins, hors d'atteinte", () => {
  const three = selectAll(matches.slice(0, 3), { targetOdds: 5 });
  assert.equal(three.targetReached, true);
  assert.equal(three.floor, 0.55);
  assert.ok(Math.min(...three.legs.map((l) => l.p)) >= 0.55 - 1e-9 && three.fairOdds >= 5);
  for (const n of [2, 1]) {
    const few = selectAll(matches.slice(0, n), { targetOdds: 5 });
    assert.equal(few.targetReached, false, `${n} match(s)`);
    assert.equal(few.legs.length, n);
    // Le plus près possible de l'objectif en restant fiable : le pari le moins probable d'au moins 55 %.
    for (const l of few.legs) assert.ok(l.p >= 0.55 - 1e-9 && l.p < 0.6, `${l.label} ${l.p}`);
    assert.ok(few.fairOdds < 5 && few.fairOdds > 1);
  }
  assert.deepEqual(selectAll([], { targetOdds: 5 }), { legs: [], joint: 1, fairOdds: 1, targetReached: false }, "aucun match");
});

test("selectAll : l'objectif et le plafond de probabilité changent le choix comme attendu", () => {
  const easy = selectAll(matches.slice(0, 4), { targetOdds: 3 });
  const hard = selectAll(matches.slice(0, 4), { targetOdds: 8 });
  const avg = (r) => r.legs.reduce((a, l) => a + l.p, 0) / r.legs.length;
  assert.ok(easy.targetReached && hard.targetReached);
  assert.ok(avg(easy) > 0.72 && avg(hard) < 0.6, `${avg(easy)} / ${avg(hard)}`);
  assert.ok(easy.fairOdds >= 3 && hard.fairOdds >= 8);
  const capped = selectAll(matches, { targetOdds: 5, maxP: 0.75 });
  assert.ok(capped.legs.every((l) => l.p <= 0.75 + 1e-9));
  // Un plafond trop bas pour l'objectif : hors d'atteinte.
  assert.equal(selectAll(matches.slice(0, 2), { targetOdds: 5, maxP: 0.7 }).targetReached, false);
});

const fixtureOf = (id, kickoff, probs, extra = {}) => ({ id, leagueKey: "L", kickoff, quality: 2, probs, ...extra });
const world = (n, seed = 3) => {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => fixtureOf(`F${i}`, 1000 + i * 3600000, realProbs(0.7 + rand() * 1.9, 0.5 + rand() * 1.6), { leagueKey: `L${i % 5}` }));
};

test("selectCoupon : quatre matchs différents, un pari chacun, cote totale au moins égale à l'objectif, paris équilibrés", () => {
  const fixtures = world(30);
  const copy = JSON.stringify(fixtures);
  const r = selectCoupon(fixtures, { count: 4, targetOdds: 5 });
  assert.equal(r.targetReached, true);
  assert.equal(r.legs.length, 4);
  assert.equal(new Set(r.legs.map((l) => l.fixture.id)).size, 4);
  assert.ok(r.fairOdds >= 5 && r.fairOdds < 5.3, `cote ${r.fairOdds}`);
  assert.ok(Math.abs(r.joint - product(r.legs)) < 1e-12);
  const ps = r.legs.map((l) => l.p);
  assert.ok(Math.min(...ps) >= 0.6 - 1e-9 && Math.max(...ps) <= 0.88 + 1e-9);
  assert.ok(Math.max(...ps) - Math.min(...ps) < 0.1, ps.join(", "));
  // Chaque pari vient bien de son match ; les paris sont rendus par coup d'envoi croissant.
  for (const l of r.legs) assert.ok(l.fixture.probs.some((x) => x.label === l.label && x.p === l.p));
  const kicks = r.legs.map((l) => l.fixture.kickoff);
  assert.deepEqual(kicks, [...kicks].sort((a, b) => a - b));
  assert.equal(JSON.stringify(fixtures), copy, "l'entrée n'est pas modifiée");
});

test("selectCoupon : résultat identique quel que soit l'ordre des matchs reçus", () => {
  const fixtures = world(20, 9);
  const a = selectCoupon(fixtures, { count: 4, targetOdds: 5 });
  const b = selectCoupon([...fixtures].reverse(), { count: 4, targetOdds: 5 });
  assert.deepEqual(a.legs.map((l) => [l.fixture.id, l.label]), b.legs.map((l) => [l.fixture.id, l.label]));
});

test("selectCoupon : sur de nombreux tirages de matchs réels, l'objectif est atteint juste au-dessus de 5, avec des paris de 60 à 75 %", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const r = selectCoupon(world(24, seed), { count: 4, targetOdds: 5.2 });
    assert.equal(r.targetReached, true, `tirage ${seed}`);
    assert.ok(r.fairOdds >= 5.2 && r.fairOdds < 5.6, `tirage ${seed} : cote ${r.fairOdds}`);
    for (const l of r.legs) assert.ok(l.p >= 0.6 - 1e-9 && l.p <= 0.78, `tirage ${seed} : ${l.label} ${l.p}`);
  }
});

test("selectCoupon : à pari équivalent, les équipes bien connues du modèle et les championnats variés passent devant", () => {
  // Six matchs aux paris identiques : seuls la connaissance des équipes et le championnat les distinguent.
  const probs = legsOf([0.62, 0.66, 0.7, 0.75]);
  const same = (id, quality, leagueKey) => fixtureOf(id, 1000 + Number(id.slice(1)), probs.map((x) => ({ ...x })), { quality, leagueKey });
  const fixtures = [same("F0", 0, "A"), same("F1", 2, "A"), same("F2", 2, "B"), same("F3", 2, "C"), same("F4", 2, "D"), same("F5", 1, "E")];
  const r = selectCoupon(fixtures, { count: 4, targetOdds: 5 });
  assert.deepEqual(r.legs.map((l) => l.fixture.id).sort(), ["F1", "F2", "F3", "F4"]);
});

test("selectCoupon : peu de matchs, objectif hors d'atteinte, aucun match", () => {
  const three = selectCoupon(world(3), { count: 4, targetOdds: 5 });
  assert.equal(three.legs.length, 3, "tous les matchs disponibles");
  assert.equal(three.targetReached, true);
  assert.ok(three.fairOdds >= 5);
  const two = selectCoupon(world(2), { count: 4, targetOdds: 5 });
  assert.equal(two.targetReached, false);
  assert.equal(two.legs.length, 2);
  for (const l of two.legs) assert.ok(l.p >= 0.55 - 1e-9 && l.p < 0.6, `${l.label} ${l.p}`);
  assert.ok(two.fairOdds > 2.8 && two.fairOdds < 3.5, `cote ${two.fairOdds}`);
  const none = selectCoupon([], { count: 4, targetOdds: 5 });
  assert.deepEqual(none, { legs: [], joint: 1, fairOdds: 1, targetReached: false });
  assert.equal(selectCoupon([fixtureOf("F0", 1, [])], { count: 4, targetOdds: 5 }).legs.length, 0, "un match sans aucun pari ne compte pas");
  // Une cote visée hors de portée de paris fiables : les matchs dont le pari le moins probable (mais fiable) est le plus bas.
  const high = selectCoupon(world(10), { count: 4, targetOdds: 20 });
  assert.equal(high.targetReached, false);
  assert.equal(high.legs.length, 4);
  assert.ok(high.fairOdds > 8 && high.fairOdds < 20, `cote ${high.fairOdds}`);
  assert.ok(high.legs.every((l) => l.p >= 0.55 - 1e-9 && l.p < 0.6));
});

test("selectCoupon : le seuil d'un pari descend de 60 % à 55 % quand c'est la seule façon d'atteindre l'objectif", () => {
  const r = selectCoupon(world(3, 5), { count: 3, targetOdds: 5 });
  assert.equal(r.targetReached, true);
  assert.equal(r.floor, 0.55);
  const strict = selectCoupon(world(10, 5), { count: 4, targetOdds: 5 });
  assert.equal(strict.floor, 0.6);
});

test("selectCoupon : reste rapide avec beaucoup de matchs (seuls les plus proches et les mieux connus sont étudiés)", () => {
  const fixtures = world(400, 4);
  const t0 = Date.now();
  const r = selectCoupon(fixtures, { count: 4, targetOdds: 5 });
  assert.ok(Date.now() - t0 < 1500, `trop lent : ${Date.now() - t0} ms`);
  assert.equal(r.legs.length, 4);
  assert.ok(r.legs.every((l) => Number(l.fixture.id.slice(1)) < 40), "parmi les premiers matchs (ordre par connaissance puis coup d'envoi)");
});

test("nearestPick : le pari le plus proche de la probabilité visée ; à égalité, non remboursable puis le plus simple", () => {
  const probs = [leg("Plus de 0.5 buts", 0.94), leg("Victoire ou nul équipe 1", 0.84), leg("Plus de 1.5 buts", 0.7), leg("Match nul", 0.25)];
  assert.equal(nearestPick(probs, 0.7).label, "Plus de 1.5 buts");
  assert.equal(nearestPick(probs, 0.8).label, "Victoire ou nul équipe 1");
  assert.equal(nearestPick(probs, 1).label, "Plus de 0.5 buts", "visée 1 : le plus probable");
  assert.equal(nearestPick(probs, 0.2).label, "Match nul");
  assert.equal(nearestPick(probs, 1, { maxP: 0.9 }).label, "Victoire ou nul équipe 1");
  assert.equal(nearestPick(probs, 0.3, { minP: 0.6 }).label, "Plus de 1.5 buts");
  assert.equal(nearestPick(probs, 0.7, { minP: 0.99 }), null);
  assert.equal(nearestPick([], 0.7), null);
  const tie = [leg("Plus de 2 buts", 0.7, { push: 0.2 }), leg("Équipe 1 plus de 2.5 buts", 0.7), leg("Plus de 2.5 buts", 0.7)];
  assert.equal(nearestPick(tie, 0.7).label, "Plus de 2.5 buts");
  assert.equal(nearestPick([...tie].reverse(), 0.7).label, "Plus de 2.5 buts", "indépendant de l'ordre");
  const equidistant = [leg("Plus de 2.5 buts", 0.6), leg("Moins de 3.5 buts", 0.8)];
  assert.ok(["Plus de 2.5 buts", "Moins de 3.5 buts"].includes(nearestPick(equidistant, 0.7).label));
  assert.equal(nearestPick(probs, 0.7), probs[2], "rend un des éléments tels quels");
});

test("pickWindow : la plage des paris retenus d'après la configuration", () => {
  const w = pickWindow({ targetOdds: 5, count: 4, minLegP: 0.6, maxLegP: 0.88 });
  assert.ok(Math.abs(w.target - 0.6687) < 1e-4);
  assert.deepEqual([w.minP, w.maxP], [0.6, 0.88]);
});
