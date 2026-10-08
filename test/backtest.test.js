"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runBacktest, runBacktestAsync, tuneModel } = require("../src/backtest");
const { simulateLeague, mulberry32, poissonSample, DAY } = require("./helpers");

const sims = [1, 2, 3, 4, 5].map((seed) => simulateLeague({ teams: 18, seasons: 4, seed }));
const leagues = sims.map((s, i) => ({ key: `SIM${i}`, finished: s.matches }));
const NOW = sims[0].now;
const OPTS = { now: NOW, evalDays: 300, stepDays: 14 };

test("le modèle fait mieux que la référence sur des matchs rejoués pas à pas", () => {
  const r = runBacktest(leagues, OPTS);
  assert.ok(r.matchsEvalues > 800, `${r.matchsEvalues} matchs`);
  assert.ok(r.resultat1N2.gainPct > 1.5, `gain ${r.resultat1N2.gainPct} %`);
  assert.ok(r.resultat1N2.brierModele < r.resultat1N2.brierReference);
  // Au moins la moitié des marchés suivis s'améliorent.
  const better = r.marches.filter((m) => m.brierModele < m.brierReference).length;
  assert.ok(better >= 5, `${better} marchés meilleurs que la référence sur ${r.marches.length}`);
  assert.match(r.lecture, /fait mieux/);
});

test("les paris choisis automatiquement se réalisent à peu près aussi souvent qu'annoncé", () => {
  const r = runBacktest(leagues, OPTS);
  assert.ok(r.paris.matchs > 800);
  assert.ok(Math.abs(r.paris.ecart) < 0.04, `écart ${r.paris.ecart}`);
});

test("calibration : les tranches bien fournies restent proches de la réalité", () => {
  const r = runBacktest(leagues, OPTS);
  for (const b of r.calibration.filter((x) => x.matchs >= 200)) {
    assert.ok(Math.abs(b.probabilitePredite - b.frequenceObservee) < 0.06, `${b.tranche} : prédit ${b.probabilitePredite}, observé ${b.frequenceObservee}`);
  }
});

test("aucune fuite d'information : si les résultats récents n'ont aucun lien avec la force des équipes, le modèle ne « gagne » pas", () => {
  const rand = mulberry32(99);
  const cut = NOW - OPTS.evalDays * DAY;
  const noisy = leagues.map((l) => ({
    key: l.key,
    finished: l.finished.map((m) => (m.kickoff >= cut ? { ...m, hg: poissonSample(1.45, rand), ag: poissonSample(1.15, rand) } : m)),
  }));
  const r = runBacktest(noisy, OPTS);
  assert.ok(r.resultat1N2.gainPct < 0.8, `gain suspect : ${r.resultat1N2.gainPct} %`);
});

test("version asynchrone : même résultat, et le serveur garde la main entre deux championnats", async () => {
  let yields = 0;
  const a = await runBacktestAsync(leagues.slice(0, 2), OPTS, async () => {
    yields++;
  });
  const b = runBacktest(leagues.slice(0, 2), OPTS);
  assert.equal(yields, 2);
  assert.deepEqual(a, b);
});

test("pas assez de matchs : message clair plutôt qu'un chiffre trompeur", () => {
  const few = [{ key: "X", finished: sims[0].matches.slice(0, 50) }];
  const r = runBacktest(few, OPTS);
  assert.equal(r.matchsEvalues, 0);
  assert.equal(r.resultat1N2, null);
  assert.match(r.lecture, /Pas assez/);
});

test("réglage automatique : compare plusieurs réglages et ne change que pour un gain net", async () => {
  const grid = { halfLifeDays: [100, 300, 500], priorMatches: [4, 10] };
  const t = await tuneModel(leagues.slice(0, 3), { now: NOW, current: { halfLifeDays: 300, priorMatches: 10 }, grid, evalDays: 300, stepDays: 14 });
  assert.equal(t.candidats.length, 6);
  assert.ok(t.candidats.every((c) => Number.isFinite(c.brier1N2)));
  assert.ok(t.retenu.halfLifeDays >= 300, "les forces sont stables dans la simulation : un historique court ne doit pas gagner");
  // Si le réglage actuel est déjà le meilleur, rien ne change.
  const same = await tuneModel(leagues.slice(0, 3), { now: NOW, current: t.retenu, grid, evalDays: 300, stepDays: 14 });
  assert.equal(same.changed, false);
  assert.deepEqual(same.retenu, t.retenu);
});

test("réglage automatique : exige un gain minimal avant de changer", async () => {
  const grid = { halfLifeDays: [300, 500], priorMatches: [10] };
  const t = await tuneModel(leagues.slice(0, 2), { now: NOW, current: { halfLifeDays: 300, priorMatches: 10 }, grid, evalDays: 300, stepDays: 14, minGain: 0.5 });
  assert.equal(t.changed, false);
  assert.deepEqual(t.retenu, { halfLifeDays: 300, priorMatches: 10 });
});

test("réglage automatique : sans données suffisantes, le réglage actuel est conservé", async () => {
  const t = await tuneModel([{ key: "X", finished: [] }], { now: NOW, current: { halfLifeDays: 300, priorMatches: 10 }, grid: { halfLifeDays: [300], priorMatches: [10] } });
  assert.equal(t.changed, false);
  assert.deepEqual(t.retenu, { halfLifeDays: 300, priorMatches: 10 });
  assert.deepEqual(t.candidats, []);
});
