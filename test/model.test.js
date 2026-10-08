"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fitLeague, expectedGoals, scoreMatrix, dataQuality } = require("../src/model");
const { MARKETS, resolveMarket, evaluate, evaluateAll, baseRate } = require("../src/markets");
const { simulateLeague, correlation } = require("./helpers");

test("avec beaucoup de données, les buts attendus sont proches des vraies valeurs simulées", () => {
  const sim = simulateLeague({ teams: 12, seasons: 12, seed: 11 });
  const fit = fitLeague(sim.matches, { now: sim.now, halfLifeDays: 1e9 });
  const ids = [...sim.truth.keys()];
  let err = 0;
  let n = 0;
  for (const i of ids) {
    for (const j of ids) {
      if (i === j) continue;
      const th = sim.truth.get(i);
      const ta = sim.truth.get(j);
      const got = expectedGoals(fit, i, j);
      err += Math.abs(got.lh - sim.base * sim.home * th.a * ta.d) / (sim.base * sim.home * th.a * ta.d);
      err += Math.abs(got.la - sim.base * ta.a * th.d) / (sim.base * ta.a * th.d);
      n += 2;
    }
  }
  assert.ok(err / n < 0.08, `erreur relative moyenne : ${err / n}`);
  assert.ok(Math.abs(fit.home - sim.home) < 0.1, `avantage du terrain : ${fit.home}`);
});

test("dans des conditions réalistes (3 saisons, matchs récents favorisés), les forces restent bien classées", () => {
  let cA = 0;
  let cD = 0;
  const seeds = [1, 2, 3, 4, 5, 6];
  for (const seed of seeds) {
    const sim = simulateLeague({ teams: 12, seasons: 3, seed });
    const fit = fitLeague(sim.matches, { now: sim.now });
    const ids = [...sim.truth.keys()];
    cA += correlation(ids.map((i) => sim.truth.get(i).a), ids.map((i) => fit.teams.get(i).a));
    cD += correlation(ids.map((i) => sim.truth.get(i).d), ids.map((i) => fit.teams.get(i).d));
  }
  assert.ok(cA / seeds.length > 0.7, `corrélation attaque moyenne : ${cA / seeds.length}`);
  assert.ok(cD / seeds.length > 0.6, `corrélation défense moyenne : ${cD / seeds.length}`);
});

test("sans aucun match, le modèle reste utilisable (valeurs neutres)", () => {
  const fit = fitLeague([], { now: Date.now() });
  const { lh, la } = expectedGoals(fit, "A", "B");
  assert.ok(lh > 0.5 && lh < 3 && la > 0.5 && la < 3);
});

test("une équipe sans historique est ramenée vers la moyenne, un promu vers le bas", () => {
  const sim = simulateLeague({ teams: 8, seasons: 2, seed: 3 });
  const neutral = fitLeague(sim.matches, { now: sim.now });
  const first = sim.matches[0].home.id;
  const weak = fitLeague(sim.matches, { now: sim.now, priorFor: (id) => (id === first ? { a0: 0.7, d0: 1.3 } : { a0: 1, d0: 1 }) });
  assert.ok(weak.teams.get(first).a < neutral.teams.get(first).a);
  assert.ok(weak.teams.get(first).d > neutral.teams.get(first).d);
});

test("la matrice des scores est une loi de probabilité cohérente", () => {
  const M = scoreMatrix(1.6, 1.1);
  const total = M.flat().reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  const sym = scoreMatrix(1.3, 1.3);
  const home = evaluate(sym, resolveMarket("Victoire domicile")).p;
  const away = evaluate(sym, resolveMarket("Victoire extérieur")).p;
  assert.ok(Math.abs(home - away) < 1e-9);
});

test("les probabilités des types de paris sont cohérentes entre elles", () => {
  const M = scoreMatrix(1.7, 1.2);
  const p = (name) => evaluate(M, resolveMarket(name)).p;
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(p("Victoire domicile") + p("Match nul") + p("Victoire extérieur"), 1));
  assert.ok(near(p("Plus de 2.5 buts") + p("Moins de 2.5 buts"), 1));
  assert.ok(near(p("Les deux équipes marquent") + p("Les deux équipes ne marquent pas"), 1));
  assert.ok(near(p("Victoire ou nul domicile"), p("Victoire domicile") + p("Match nul")));
  assert.ok(p("Plus de 1.5 buts") > p("Plus de 2.5 buts") && p("Plus de 2.5 buts") > p("Plus de 3.5 buts"));
  assert.ok(p("Victoire domicile + 2.5 buts plus") < p("Victoire domicile"));
  assert.ok(p("Victoire domicile + 2.5 buts plus") < p("Plus de 2.5 buts"));
  assert.ok(p("Equipe domicile 0.5 buts plus") > p("Equipe domicile 1.5 buts plus"));
});

test("les anciens noms de paris et les variantes sans accents sont reconnus", () => {
  const same = (a, b) => assert.equal(resolveMarket(a), resolveMarket(b), `${a} / ${b}`);
  same("Victoire equipe 1", "Victoire domicile");
  same("Victoire exterieur", "Victoire extérieur");
  same("Les deux equipes marquent - Oui", "Les deux équipes marquent");
  same("Total buts 1.5 plus", "Plus de 1.5 buts");
  same("1X et plus de 1.5 buts", "Victoire/nul domicile + 1.5 buts plus");
  same("V2 et plus de 2.5 buts", "Victoire extérieur + 2.5 buts plus");
  assert.equal(resolveMarket("Autre"), null);
  assert.equal(resolveMarket(42), null);
});

test("« Score exact » renvoie le score le plus probable", () => {
  const out = evaluate(scoreMatrix(1.1, 0.9), resolveMarket("Score exact"));
  assert.match(out.detail, /^\d-\d$/);
  assert.ok(out.p > 0.05 && out.p < 0.2);
});

test("chaque type de paris a une probabilité entre 0 et 1 et un taux moyen", () => {
  const all = evaluateAll(scoreMatrix(1.4, 1.0));
  assert.equal(all.length, MARKETS.length);
  for (const m of all) assert.ok(m.p >= 0 && m.p <= 1, m.label);
  assert.ok(baseRate(resolveMarket("Match nul")) > 0.2);
});

test("la qualité des données reflète le nombre de matchs disponibles", () => {
  const sim = simulateLeague({ teams: 8, seasons: 2, seed: 5 });
  const fit = fitLeague(sim.matches, { now: sim.now });
  const known = dataQuality(fit, "T0", "T1");
  const unknown = dataQuality(fit, "T0", "INCONNU");
  assert.ok(known.level >= 1);
  assert.equal(unknown.level, 0);
});
