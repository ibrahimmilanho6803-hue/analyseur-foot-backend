"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fitCross, crossMatrix, cholesky, cholSolve, GH_NODES, GH_WEIGHTS, DEFAULTS } = require("../src/cross");
const { scoreMatrix } = require("../src/model");
const { describeMatrix } = require("../src/markets");
const { mulberry32, poissonSample, DAY } = require("./helpers");

const NOW = Date.UTC(2026, 9, 14);
const close = (a, b, eps, label = "") => assert.ok(Math.abs(a - b) <= eps, `${label} ${a} ≠ ${b} (±${eps})`);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const total = (M) => sum(M.map(sum));

// Monde simulé : des championnats de vrai niveau connu, des clubs de force connue (a, d dans leur championnat) et un écart propre τ.
// Les buts suivent exactement le modèle de cross.js.
function makeWorld({ levels, priors, perLeague = 12, tauSd = 0.08, seed = 3, mu = 1.1, home = 1.3 }) {
  const rand = mulberry32(seed);
  const gauss = () => {
    let u = 0;
    let v = 0;
    while (!u) u = rand();
    while (!v) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const teams = new Map();
  Object.keys(levels).forEach((key) => {
    for (let k = 0; k < perLeague; k++) {
      const id = `${key}${k}`;
      teams.set(id, { id, leagueKey: key, a: Math.exp(gauss() * 0.22), d: Math.exp(gauss() * 0.22), rated: true, tau: gauss() * tauSd });
    }
  });
  const ids = [...teams.keys()];
  // exact : au lieu de tirer des buts au hasard, on donne les buts attendus eux-mêmes (données sans bruit : l'estimation idéale est la réalité)
  const simulate = (n, { spanDays = 400, exact = false } = {}) => {
    const out = [];
    for (let i = 0; out.length < n && i < n * 30; i++) {
      const h = teams.get(ids[Math.floor(rand() * ids.length)]);
      const g = teams.get(ids[Math.floor(rand() * ids.length)]);
      if (h.leagueKey === g.leagueKey) continue; // des matchs de coupe : clubs de championnats différents
      const u = levels[h.leagueKey] + h.tau - levels[g.leagueKey] - g.tau;
      const lh = Math.min(6, mu * home * h.a * g.d * Math.exp(u));
      const lg = Math.min(6, mu * g.a * h.d * Math.exp(-u));
      out.push({
        id: `m${i}`,
        h: h.id,
        g: g.id,
        hg: exact ? lh : poissonSample(lh, rand),
        ag: exact ? lg : poissonSample(lg, rand),
        kickoff: NOW - Math.floor(rand() * spanDays) * DAY,
      });
    }
    return out;
  };
  const leagues = Object.keys(levels).map((key) => ({ key, mean: priors[key] }));
  return { teams, simulate, leagues, describe: (id) => teams.get(id) || null };
}

const LEVELS = { A: 0, B: -0.2, C: -0.5 };
const PRIORS = { A: 0, B: -0.08, C: -0.2 }; // volontairement trop proches les uns des autres : les résultats doivent les écarter

// ---------- Algèbre ----------
test("cholesky et cholSolve résolvent un système symétrique défini positif", () => {
  const A = Float64Array.from([4, 2, 0.6, 2, 5, 1, 0.6, 1, 3]);
  const L = cholesky(A, 3);
  assert.ok(L, "matrice définie positive : décomposition trouvée");
  // L · Lᵀ = A
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += L[i * 3 + k] * L[j * 3 + k];
      close(s, A[i * 3 + j], 1e-12, `(${i},${j})`);
    }
  }
  const x = cholSolve(L, 3, Float64Array.from([1, -2, 0.5]));
  const back = [0, 1, 2].map((i) => sum([0, 1, 2].map((j) => A[i * 3 + j] * x[j])));
  close(back[0], 1, 1e-12);
  close(back[1], -2, 1e-12);
  close(back[2], 0.5, 1e-12);
});

test("cholesky refuse une matrice qui n'est pas définie positive au lieu de renvoyer des nombres faux", () => {
  assert.equal(cholesky(Float64Array.from([1, 2, 2, 1]), 2), null);
  assert.equal(cholesky(Float64Array.from([0, 0, 0, 0]), 2), null);
});

test("quadrature de Gauss-Hermite : poids de somme 1, moyenne 0, variance 1, moment d'ordre 4 égal à 3", () => {
  assert.equal(GH_NODES.length, 5);
  assert.equal(GH_WEIGHTS.length, 5);
  close(sum(GH_WEIGHTS), 1, 1e-12);
  close(sum(GH_NODES.map((x, i) => GH_WEIGHTS[i] * x)), 0, 1e-12);
  close(sum(GH_NODES.map((x, i) => GH_WEIGHTS[i] * x ** 2)), 1, 1e-9);
  close(sum(GH_NODES.map((x, i) => GH_WEIGHTS[i] * x ** 4)), 3, 1e-9);
  // E[exp(s·X)] = exp(s²/2) pour une loi normale centrée réduite : la quadrature s'en approche pour un écart modéré
  close(sum(GH_NODES.map((x, i) => GH_WEIGHTS[i] * Math.exp(0.3 * x))), Math.exp(0.045), 1e-4);
});

// ---------- Ajustement ----------
test("un réglage non renseigné (undefined) garde sa valeur par défaut au lieu de tout rendre illisible", () => {
  const w = makeWorld({ levels: LEVELS, priors: PRIORS });
  const matches = w.simulate(150);
  const base = fitCross({ matches, describe: w.describe, leagues: w.leagues, now: NOW });
  const withUndefined = fitCross({ matches, describe: w.describe, leagues: w.leagues, now: NOW, halfLifeDays: undefined, leagueSd: undefined });
  assert.ok(Number.isFinite(withUndefined.mu) && Number.isFinite(withUndefined.home));
  for (const l of w.leagues) {
    assert.ok(Number.isFinite(withUndefined.league(l.key).value), l.key);
    assert.equal(withUndefined.league(l.key).value, base.league(l.key).value, "même résultat qu'avec les réglages par défaut");
  }
  const dh = w.describe("A0");
  const dg = w.describe("B0");
  assert.deepEqual(withUndefined.predict(dh, dg), base.predict(dh, dg));
});

test("sans aucun match de coupe, le modèle reste sur les niveaux a priori et le dit", () => {
  const w = makeWorld({ levels: LEVELS, priors: PRIORS });
  const fit = fitCross({ matches: [], describe: w.describe, leagues: w.leagues, now: NOW });
  assert.equal(fit.nMatches, 0);
  for (const l of w.leagues) {
    const info = fit.league(l.key);
    assert.equal(info.value, l.mean);
    assert.equal(info.weight, 0);
    assert.equal(info.calibrated, false);
  }
  close(fit.mu, DEFAULTS.mu0, 1e-12);
  close(fit.home, DEFAULTS.home0, 1e-12);
  const p = fit.predict(w.teams.get("A0"), w.teams.get("C0"));
  close(p.delta, PRIORS.A - PRIORS.C, 1e-12);
  assert.ok(p.sd > 0.2, `incertitude ${p.sd}`);
  assert.equal(fit.league("inconnu"), null);
  assert.equal(fit.team("A0"), null);
});

test("les matchs de coupe rapprochent les niveaux des championnats de la réalité (écarts entre championnats mieux estimés qu'a priori)", () => {
  const w = makeWorld({ levels: LEVELS, priors: PRIORS });
  const fit = fitCross({ matches: w.simulate(500), describe: w.describe, leagues: w.leagues, now: NOW });
  const gap = (x, y) => fit.league(x).value - fit.league(y).value;
  const truth = (x, y) => LEVELS[x] - LEVELS[y];
  const prior = (x, y) => PRIORS[x] - PRIORS[y];
  for (const [x, y] of [["A", "C"], ["A", "B"], ["B", "C"]]) {
    assert.ok(Math.abs(gap(x, y) - truth(x, y)) < Math.abs(prior(x, y) - truth(x, y)), `${x}−${y} : ${gap(x, y).toFixed(3)}, vrai ${truth(x, y)}, a priori ${prior(x, y)}`);
  }
  close(gap("A", "C"), truth("A", "C"), 0.1, "A−C");
  assert.ok(fit.league("A").value > fit.league("B").value && fit.league("B").value > fit.league("C").value, "ordre des championnats retrouvé");
  assert.ok(fit.league("A").calibrated && fit.league("C").calibrated);
  assert.ok(fit.league("A").weight > 50);
  close(fit.mu, 1.1, 0.12, "buts à l'extérieur");
  close(fit.home, 1.3, 0.15, "avantage du terrain");
});

test("peu de matchs de coupe : le niveau bouge peu (l'a priori pèse), beaucoup de matchs : il rejoint les résultats", () => {
  // données sans bruit : l'écart idéal entre A et C est exactement 0,5 (a priori : 0,2) ; plus il y a de matchs, plus on s'en approche
  const w = makeWorld({ levels: LEVELS, priors: PRIORS, tauSd: 0 });
  const sims = w.simulate(900, { exact: true });
  const gapOf = (n) => {
    const fit = fitCross({ matches: sims.slice(0, n), describe: w.describe, leagues: w.leagues, now: NOW });
    return { fit, gap: fit.league("A").value - fit.league("C").value };
  };
  const [none, few, some, many] = [0, 12, 60, 900].map(gapOf);
  close(none.gap, 0.2, 1e-12, "sans match");
  assert.ok(few.gap > none.gap && few.gap < some.gap && some.gap < many.gap, [none.gap, few.gap, some.gap, many.gap].join(" < "));
  assert.ok(few.gap < 0.4, `12 matchs : ${few.gap}`);
  close(many.gap, 0.5, 0.06, "900 matchs");
  assert.equal(few.fit.league("A").calibrated, false, "12 matchs ne suffisent pas à dire qu'un championnat est mesuré");
  assert.equal(many.fit.league("A").calibrated, true);
});

test("l'incertitude de la prévision diminue quand il y a plus de matchs de coupe, et ne tombe jamais à zéro", () => {
  const w = makeWorld({ levels: LEVELS, priors: PRIORS });
  const sims = w.simulate(900);
  const sd = (n) => fitCross({ matches: sims.slice(0, n), describe: w.describe, leagues: w.leagues, now: NOW }).predict(w.teams.get("A0"), w.teams.get("C0"));
  const none = sd(0);
  const some = sd(150);
  const lots = sd(900);
  assert.ok(none.sd > some.sd && some.sd > lots.sd, `${none.sd} > ${some.sd} > ${lots.sd}`);
  assert.ok(lots.sd >= DEFAULTS.structuralSd, "l'incertitude de structure n'est jamais effacée par les données");
  close(lots.variance, lots.fittedSd ** 2 + DEFAULTS.structuralSd ** 2, 1e-12);
});

test("deux clubs du même championnat : le niveau du championnat s'annule", () => {
  const w = makeWorld({ levels: LEVELS, priors: PRIORS });
  const sims = w.simulate(300);
  const base = fitCross({ matches: sims, describe: w.describe, leagues: w.leagues, now: NOW });
  const p = base.predict(w.teams.get("B0"), w.teams.get("B1"));
  // seul l'écart propre aux deux clubs reste
  const t = (id) => (base.team(id) ? base.team(id).tau : 0);
  close(p.delta, t("B0") - t("B1"), 1e-12);
  // et décaler le niveau a priori du championnat ne change rien à cette prévision
  const shifted = fitCross({ matches: [], describe: w.describe, leagues: w.leagues.map((l) => (l.key === "B" ? { ...l, mean: l.mean + 0.5 } : l)), now: NOW });
  const q = shifted.predict(w.teams.get("B0"), w.teams.get("B1"));
  assert.equal(q.delta, 0);
  const q0 = fitCross({ matches: [], describe: w.describe, leagues: w.leagues, now: NOW }).predict(w.teams.get("B0"), w.teams.get("B1"));
  assert.equal(q.lh, q0.lh);
  assert.equal(q.sd, q0.sd);
  // incertitude : celle des deux écarts propres seulement (le niveau du championnat n'y entre pas)
  close(q.fittedSd, Math.hypot(DEFAULTS.teamSdRated, DEFAULTS.teamSdRated), 1e-9);
});

test("même championnat contre championnats différents : plus d'incertitude entre championnats, à données égales", () => {
  const w = makeWorld({ levels: LEVELS, priors: PRIORS });
  const fit = fitCross({ matches: [], describe: w.describe, leagues: w.leagues, now: NOW });
  const same = fit.predict(w.teams.get("A0"), w.teams.get("A1"));
  const cross = fit.predict(w.teams.get("A0"), w.teams.get("C1"));
  assert.ok(cross.sd > same.sd, `${cross.sd} > ${same.sd}`);
});

test("un club connu seulement par les coupes (sans force de championnat) est plus incertain qu'un club suivi, et reste neutre (a = d = 1)", () => {
  const teams = new Map([
    ["R1", { id: "R1", leagueKey: "A", a: 1.1, d: 0.9, rated: true }],
    ["R2", { id: "R2", leagueKey: "A", a: 1, d: 1, rated: true }],
    ["U1", { id: "U1", leagueKey: "EUR", a: 1, d: 1, rated: false }],
    ["U2", { id: "U2", leagueKey: "EUR", a: 1, d: 1, rated: false }],
  ]);
  const leagues = [{ key: "A", mean: 0 }, { key: "EUR", mean: -0.85 }];
  const fit = fitCross({ matches: [], describe: (id) => teams.get(id), leagues, now: NOW });
  const rated = fit.predict(teams.get("R2"), teams.get("R1"));
  const mixed = fit.predict(teams.get("R2"), teams.get("U1"));
  assert.ok(mixed.fittedSd > rated.fittedSd);
  close(mixed.delta, 0.85, 1e-12, "niveau a priori des « autres clubs européens »");
  // sans match de coupe, un club connu seulement par elles pèse DEFAULTS.teamSdUnrated, un club suivi DEFAULTS.teamSdRated
  const two = fit.predict(teams.get("U2"), teams.get("U1"));
  close(two.fittedSd, Math.SQRT2 * DEFAULTS.teamSdUnrated, 1e-9);
});

test("un club sans championnat suivi retrouve sa force grâce à ses matchs de coupe", () => {
  const rand = mulberry32(21);
  const teams = new Map();
  for (let k = 0; k < 10; k++) teams.set(`R${k}`, { id: `R${k}`, leagueKey: "A", a: 1, d: 1, rated: true });
  teams.set("STAR", { id: "STAR", leagueKey: "EUR", a: 1, d: 1, rated: false });
  teams.set("WEAK", { id: "WEAK", leagueKey: "EUR", a: 1, d: 1, rated: false });
  const level = { STAR: 0.2, WEAK: -0.8 }; // vrai niveau (échelle du championnat A à 0)
  const matches = [];
  let i = 0;
  for (const who of ["STAR", "WEAK"]) {
    for (let k = 0; k < 24; k++) {
      const opp = teams.get(`R${k % 10}`);
      const home = k % 2 === 0;
      const u = level[who];
      const lw = (home ? 1.3 : 1) * 1.1 * Math.exp(u);
      const lo = (home ? 1 : 1.3) * 1.1 * Math.exp(-u);
      const [hg, ag] = home ? [poissonSample(lw, rand), poissonSample(lo, rand)] : [poissonSample(lo, rand), poissonSample(lw, rand)];
      matches.push({ id: `m${i++}`, h: home ? who : opp.id, g: home ? opp.id : who, hg, ag, kickoff: NOW - (k + 1) * 9 * DAY });
    }
  }
  const leagues = [{ key: "A", mean: 0 }, { key: "EUR", mean: -0.4 }];
  const fit = fitCross({ matches, describe: (id) => teams.get(id), leagues, now: NOW });
  const star = fit.team("STAR");
  const weak = fit.team("WEAK");
  assert.equal(star.n, 24);
  assert.ok(star.w > 10 && star.w <= 24);
  assert.ok(star.tau > weak.tau + 0.4, `STAR ${star.tau.toFixed(2)} vs WEAK ${weak.tau.toFixed(2)}`);
  const p = fit.predict(teams.get("STAR"), teams.get("WEAK"));
  assert.ok(p.lh > p.la * 1.5, `${p.lh} vs ${p.la}`);
});

test("les résultats récents comptent plus que les anciens", () => {
  const teams = new Map([
    ["X", { id: "X", leagueKey: "A", a: 1, d: 1, rated: true }],
    ["Y", { id: "Y", leagueKey: "B", a: 1, d: 1, rated: true }],
  ]);
  const leagues = [{ key: "A", mean: 0 }, { key: "B", mean: 0 }];
  const wins = (age, n, label) => Array.from({ length: n }, (_, k) => ({ id: `${label}${k}`, h: "X", g: "Y", hg: 4, ag: 0, kickoff: NOW - (age + k) * DAY }));
  const losses = (age, n, label) => Array.from({ length: n }, (_, k) => ({ id: `${label}${k}`, h: "X", g: "Y", hg: 0, ag: 3, kickoff: NOW - (age + k) * DAY }));
  const recentWins = fitCross({ matches: [...wins(5, 8, "w"), ...losses(900, 8, "l")], describe: (id) => teams.get(id), leagues, now: NOW });
  const oldWins = fitCross({ matches: [...wins(900, 8, "w"), ...losses(5, 8, "l")], describe: (id) => teams.get(id), leagues, now: NOW });
  const gapOf = (fit) => fit.league("A").value - fit.league("B").value + fit.team("X").tau - fit.team("Y").tau;
  assert.ok(gapOf(recentWins) > gapOf(oldWins) + 0.3, `${gapOf(recentWins)} vs ${gapOf(oldWins)}`);
  assert.ok(recentWins.wTotal > 0 && recentWins.wTotal < 16);
});

test("les matchs inutilisables sont écartés : doublons, scores manquants, club inconnu, même club des deux côtés, trop anciens", () => {
  const w = makeWorld({ levels: LEVELS, priors: PRIORS });
  const [m] = w.simulate(1);
  const base = fitCross({ matches: [m], describe: w.describe, leagues: w.leagues, now: NOW });
  assert.equal(base.nMatches, 1);
  const noisy = [
    m,
    { ...m }, // même match saisi deux fois
    { ...m, id: "x1", hg: null },
    { ...m, id: "x2", ag: NaN },
    { ...m, id: "x3", h: "Inconnu" },
    { ...m, id: "x4", g: m.h },
    { ...m, id: "x5", kickoff: NOW - 40 * 365 * DAY },
    null,
  ];
  const fit = fitCross({ matches: noisy, describe: w.describe, leagues: w.leagues, now: NOW });
  assert.equal(fit.nMatches, 1);
  assert.deepEqual([fit.mu, fit.home, fit.league("A").value], [base.mu, base.home, base.league("A").value]);
});

test("l'ajustement est déterministe et rapide, même avec beaucoup de matchs", () => {
  const w = makeWorld({ levels: { A: 0, B: -0.2, C: -0.5, D: -0.7, E: -0.9 }, priors: { A: 0, B: -0.1, C: -0.3, D: -0.5, E: -0.5 }, perLeague: 25 });
  const sims = w.simulate(4000, { spanDays: 700 });
  const t0 = Date.now();
  const one = fitCross({ matches: sims, describe: w.describe, leagues: w.leagues, now: NOW });
  const p1 = one.predict(w.teams.get("A3"), w.teams.get("E7"));
  const elapsed = Date.now() - t0;
  const two = fitCross({ matches: sims, describe: w.describe, leagues: w.leagues, now: NOW });
  const p2 = two.predict(w.teams.get("A3"), w.teams.get("E7"));
  assert.deepEqual([p1.lh, p1.la, p1.sd], [p2.lh, p2.la, p2.sd]);
  assert.ok(elapsed < 5000, `${elapsed} ms`);
  for (const v of [p1.lh, p1.la, p1.sd]) assert.ok(Number.isFinite(v));
});

test("des résultats extrêmes ne font pas diverger le modèle (buts attendus bornés, valeurs finies)", () => {
  const teams = new Map([
    ["X", { id: "X", leagueKey: "A", a: 1, d: 1, rated: true }],
    ["Y", { id: "Y", leagueKey: "B", a: 1, d: 1, rated: true }],
  ]);
  const matches = Array.from({ length: 40 }, (_, k) => ({ id: `m${k}`, h: "X", g: "Y", hg: 9, ag: 0, kickoff: NOW - k * DAY }));
  const fit = fitCross({ matches, describe: (id) => teams.get(id), leagues: [{ key: "A", mean: 0 }, { key: "B", mean: -0.3 }], now: NOW });
  const p = fit.predict(teams.get("X"), teams.get("Y"));
  for (const v of [fit.mu, fit.home, p.delta, p.sd]) assert.ok(Number.isFinite(v), String(v));
  assert.ok(p.lh <= 4.5 && p.la >= 0.2);
  const back = fit.predict(teams.get("Y"), teams.get("X"));
  assert.ok(back.lh >= 0.2 && back.la <= 4.5);
});

// ---------- Matrice des scores ----------
const PRED = { lh: 1.9, la: 0.9, delta: 0.3, fittedSd: 0.3, sd: 0.32, variance: 0.1 };
const OPTS = { rho: -0.08, maxGoals: 9 };

test("crossMatrix : somme 1, probabilités positives, 10×10", () => {
  const M = crossMatrix(PRED, OPTS);
  assert.equal(M.length, 10);
  assert.ok(M.every((row) => row.length === 10 && row.every((p) => p >= 0)));
  close(total(M), 1, 1e-9);
});

test("crossMatrix sans incertitude = matrice d'un seul match (celle de model.js)", () => {
  const exact = { ...PRED, sd: 0, variance: 0 };
  const M = crossMatrix(exact, OPTS);
  const R = scoreMatrix(exact.lh, exact.la, OPTS);
  for (let h = 0; h < 10; h++) for (let a = 0; a < 10; a++) close(M[h][a], R[h][a], 1e-12);
});

test("crossMatrix garde le nombre de buts attendu de chaque équipe (pas de biais dû au mélange)", () => {
  const M = crossMatrix(PRED, OPTS);
  const mean = (side) => sum(M.map((row, h) => sum(row.map((p, a) => p * (side === "h" ? h : a)))));
  const R = scoreMatrix(PRED.lh, PRED.la, OPTS);
  const meanR = (side) => sum(R.map((row, h) => sum(row.map((p, a) => p * (side === "h" ? h : a)))));
  close(mean("h"), meanR("h"), 0.06, "buts du domicile");
  close(mean("a"), meanR("a"), 0.04, "buts de l'extérieur");
  close(mean("h") + mean("a"), meanR("h") + meanR("a"), 0.08, "total de buts");
});

test("crossMatrix est moins tranchée que le calcul sans incertitude : le favori gagne moins souvent, le nul et l'outsider davantage", () => {
  const sharp = describeMatrix(crossMatrix({ ...PRED, sd: 0, variance: 0 }, OPTS)).outcomes;
  const wide = describeMatrix(crossMatrix({ ...PRED, sd: 0.5, variance: 0.25 }, OPTS)).outcomes;
  assert.ok(wide.home < sharp.home, `${wide.home} < ${sharp.home}`);
  assert.ok(wide.away > sharp.away, `${wide.away} > ${sharp.away}`);
  assert.ok(Math.abs(wide.home + wide.draw + wide.away - 1) < 1e-9);
  // les totaux de buts, eux, ne bougent presque pas
  close(wide.over25, sharp.over25, 0.04, "plus de 2,5 buts");
});

test("crossMatrix : plus l'incertitude est grande, plus la probabilité du favori recule", () => {
  const p = (sd) => describeMatrix(crossMatrix({ ...PRED, sd, variance: sd * sd }, OPTS)).outcomes.home;
  assert.ok(p(0) > p(0.2) && p(0.2) > p(0.4) && p(0.4) > p(0.6), [p(0), p(0.2), p(0.4), p(0.6)].join(" > "));
});

test("crossMatrix reste valide aux extrêmes (valeurs bornées, jamais de NaN)", () => {
  for (const pred of [
    { lh: 4.5, la: 0.2, sd: 0.8, variance: 0.64 },
    { lh: 0.2, la: 4.5, sd: 0.8, variance: 0.64 },
    { lh: 1.2, la: 1.2, sd: 0, variance: 0 },
  ]) {
    const M = crossMatrix(pred, OPTS);
    close(total(M), 1, 1e-9);
    assert.ok(M.every((row) => row.every((p) => Number.isFinite(p) && p >= 0)));
  }
});

test("crossMatrix est symétrique : échanger les deux clubs échange les probabilités de victoire", () => {
  const a = describeMatrix(crossMatrix(PRED, { rho: 0, maxGoals: 9 })).outcomes;
  const b = describeMatrix(crossMatrix({ ...PRED, lh: PRED.la, la: PRED.lh }, { rho: 0, maxGoals: 9 })).outcomes;
  close(a.home, b.away, 1e-9);
  close(a.away, b.home, 1e-9);
  close(a.draw, b.draw, 1e-9);
});
