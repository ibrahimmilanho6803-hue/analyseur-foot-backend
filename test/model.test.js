"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fitLeague, calibrateFit, expectedGoals, scoreMatrix, dataQuality } = require("../src/model");
const { MARKETS, resolveMarket, evaluate, evaluateAll, baseRate } = require("../src/markets");
const { simulateLeague, correlation, mulberry32, poissonSample, DAY } = require("./helpers");

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

// ---------- Réglages de calibrage du niveau de buts et des forces ----------

const sim = simulateLeague({ teams: 14, seasons: 3, seed: 21 });
const OPTS = { now: sim.now, halfLifeDays: 500, priorMatches: 4 };
const totalGoals = (fit, ids) => {
  let s = 0;
  for (const i of ids) for (const j of ids) if (i !== j) s += expectedGoals(fit, i, j).lh + expectedGoals(fit, i, j).la;
  return s;
};

test("calibrage : des réglages neutres ne changent rien", () => {
  const plain = fitLeague(sim.matches, OPTS);
  const neutral = fitLeague(sim.matches, { ...OPTS, strengthExponent: 1, levelHalfLifeDays: 0, levelFactor: 1 });
  assert.equal(neutral.base, plain.base);
  assert.equal(neutral.home, plain.home);
  assert.equal(calibrateFit(plain, {}), plain);
  for (const [id, t] of plain.teams) assert.deepEqual(neutral.teams.get(id), t);
});

test("calibrage : le coefficient de niveau multiplie les buts attendus des deux équipes", () => {
  const plain = fitLeague(sim.matches, OPTS);
  const up = fitLeague(sim.matches, { ...OPTS, levelFactor: 1.1 });
  const a = expectedGoals(plain, "T0", "T1");
  const b = expectedGoals(up, "T0", "T1");
  assert.ok(Math.abs(b.lh / a.lh - 1.1) < 1e-9);
  assert.ok(Math.abs(b.la / a.la - 1.1) < 1e-9);
});

test("calibrage : un exposant inférieur à 1 rapproche les forces de la moyenne sans changer le niveau de buts", () => {
  const plain = fitLeague(sim.matches, OPTS);
  const soft = fitLeague(sim.matches, { ...OPTS, strengthExponent: 0.6 });
  const spread = (fit) => {
    const logs = [...fit.teams.values()].map((t) => Math.log(t.a));
    const m = logs.reduce((x, y) => x + y, 0) / logs.length;
    return logs.reduce((x, y) => x + (y - m) ** 2, 0) / logs.length;
  };
  assert.ok(spread(soft) < 0.6 * spread(plain), `${spread(soft)} contre ${spread(plain)}`);
  const mean = (fit, key) => [...fit.teams.values()].reduce((x, t) => x + t[key], 0) / fit.teams.size;
  assert.ok(Math.abs(mean(soft, "a") - 1) < 1e-9 && Math.abs(mean(soft, "d") - 1) < 1e-9);
  // Sur les matchs ajustés, le total de buts attendu reste égal au total observé.
  let expected = 0;
  let observed = 0;
  for (const r of soft.rows) {
    const th = soft.teams.get(r.h);
    const ta = soft.teams.get(r.a);
    expected += r.w * (soft.base * soft.home * th.a * ta.d + soft.base * ta.a * th.d);
    observed += r.w * (r.hg + r.ag);
  }
  assert.ok(Math.abs(expected / observed - 1) < 1e-6, `${expected} contre ${observed}`);
  // Le classement des équipes ne change pas.
  const order = (fit) => [...fit.teams.entries()].sort((x, y) => y[1].a - x[1].a).map(([id]) => id).join();
  assert.equal(order(soft), order(plain));
});

test("calibrage : le niveau de buts à mémoire courte suit une hausse récente, avec un a priori il reste prudent", () => {
  const rand = mulberry32(5);
  const cut = sim.now - 90 * DAY;
  const hotter = sim.matches.map((m) => {
    if (m.kickoff < cut) return m;
    const h = sim.truth.get(m.home.id);
    const a = sim.truth.get(m.away.id);
    return { ...m, hg: poissonSample(1.35 * sim.base * sim.home * h.a * a.d, rand), ag: poissonSample(1.35 * sim.base * a.a * h.d, rand) };
  });
  const ids = [...sim.truth.keys()];
  const plain = fitLeague(hotter, OPTS);
  const quick = fitLeague(hotter, { ...OPTS, levelHalfLifeDays: 45, levelPriorMatches: 10 });
  const careful = fitLeague(hotter, { ...OPTS, levelHalfLifeDays: 45, levelPriorMatches: 1e6 });
  const g0 = totalGoals(plain, ids);
  assert.ok(totalGoals(quick, ids) > 1.08 * g0, `${totalGoals(quick, ids)} contre ${g0}`);
  assert.ok(Math.abs(totalGoals(careful, ids) / g0 - 1) < 0.01, "un a priori très fort garde le niveau de long terme");
  // Les forces relatives des équipes ne sont pas touchées.
  for (const [id, t] of plain.teams) assert.equal(quick.teams.get(id).a, t.a);
});

test("calibrage : sans match, rien à calibrer (valeurs neutres conservées)", () => {
  const fit = fitLeague([], { now: Date.now(), levelFactor: 1.2, strengthExponent: 0.8, levelHalfLifeDays: 60 });
  assert.equal(fit.nMatches, 0);
  const { lh, la } = expectedGoals(fit, "A", "B");
  assert.ok(lh > 0.5 && lh < 3 && la > 0.5 && la < 3);
});
