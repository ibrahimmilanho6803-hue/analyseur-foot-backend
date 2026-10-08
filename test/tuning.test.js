"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTuner, pickCalibration } = require("../src/tuning");
const { buildWorld, NOW } = require("./world");
const { mulberry32, poissonSample, DAY } = require("./helpers");

const quiet = { log() {}, warn() {}, error() {} };
const paris = (matchs, predit, observe) => ({ matchs, probabiliteMoyennePredite: predit, tauxDeReussiteReel: observe, ecart: Math.round((observe - predit) * 1000) / 1000 });

test("correction des paris automatiques : seulement vers le bas et seulement si l'écart est net", () => {
  assert.equal(pickCalibration(null).shift, 0);
  assert.equal(pickCalibration(paris(120, 0.83, 0.7)).shift, 0, "trop peu de matchs pour conclure");
  assert.equal(pickCalibration(paris(600, 0.83, 0.84)).shift, 0, "mieux que prévu : pas de relèvement");
  assert.equal(pickCalibration(paris(600, 0.83, 0.82)).shift, 0, "écart dans la marge d'erreur");
  const down = pickCalibration(paris(600, 0.83, 0.77));
  assert.equal(down.info.applique, true);
  assert.ok(Math.abs(down.shift + 0.06) < 1e-9);
  assert.equal(pickCalibration(paris(900, 0.85, 0.55)).shift, -0.1, "correction plafonnée à 10 points");
});

function bigWorld() {
  const w = buildWorld({ aiBehaviour: "off" });
  w.config.model.tuneGrid = { halfLifeDays: [300], priorMatches: [10] };
  return w;
}

test("réglage automatique et contrôle : sur des données bien décrites par le modèle, aucune correction notable", async () => {
  const w = bigWorld();
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet });
  const r = await tuner.run();
  assert.ok(r.calibrage, "le contrôle des paris automatiques a été fait");
  assert.ok(Math.abs(w.analysis.calibration.pickShift) <= 0.06, `décalage ${w.analysis.calibration.pickShift}`);
  assert.deepEqual(tuner.status().retenu, w.data.getModelParams());
});

test("résultats récents sans lien avec la force des équipes : les probabilités des paris automatiques sont abaissées", async () => {
  const w = bigWorld();
  const rand = mulberry32(5);
  const cut = NOW - 150 * DAY;
  for (const key of Object.keys(w.store)) {
    for (const season of ["cur", "prev"]) {
      w.store[key][season] = w.store[key][season].map((m) => (m.status === "finished" && m.kickoff >= cut ? { ...m, hg: poissonSample(1.45, rand), ag: poissonSample(1.15, rand) } : m));
    }
  }
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet });
  const before = await w.coupons.topMatches();
  assert.equal(before.topMatches[0].ajustementCalibrage, undefined);
  const r = await tuner.run();
  assert.equal(r.calibrage.applique, true, JSON.stringify(r.calibrage));
  assert.ok(w.analysis.calibration.pickShift < -0.02);
  w.clock.t += 20 * 60000;
  const after = await w.coupons.topMatches();
  for (const m of after.topMatches) {
    assert.ok(m.ajustementCalibrage < 0);
    assert.ok(m.probabilite < m.probabiliteModele, `${m.probabilite} devrait être sous ${m.probabiliteModele}`);
  }
  assert.ok(Number(after.coteTotale) > 0);
});

test("auto-coupon : la correction s'applique aussi aux paris choisis automatiquement", async () => {
  const w = bigWorld();
  w.analysis.setPickShift(-0.05, { applique: true });
  const r = await w.coupons.autoCoupon([{ equipe1: "Arsenal", equipe2: "Chelsea" }]);
  assert.equal(r.resultats[0].ajustementCalibrage, -5);
  assert.ok(Math.abs(r.resultats[0].probabilite - (r.resultats[0].probabiliteModele - 5)) < 0.2);
  // Une sélection choisie par l'utilisateur n'est pas corrigée.
  const [own] = await w.analysis.analyzeLegs([{ equipe1: "Arsenal", equipe2: "Chelsea", typePari: "Plus de 1.5 buts" }]);
  assert.equal(own.ajustementCalibrage, undefined);
});

test("la correction ne peut jamais relever une probabilité", () => {
  const w = bigWorld();
  w.analysis.setPickShift(0.2, {});
  assert.equal(w.analysis.calibration.pickShift, 0);
});

test("réglage automatique désactivé : le contrôle des paris reste actif", async () => {
  const w = bigWorld();
  w.config.model.autoTune = false;
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet });
  const r = await tuner.run();
  assert.equal(r.changed, false);
  assert.match(r.raison, /désactivé/);
  assert.ok(r.calibrage);
});

test("un seul réglage à la fois, et une panne de données ne casse rien", async () => {
  const w = buildWorld({ failing: ["PL", "PD", "SA"], aiBehaviour: "off" });
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet });
  const [a, b] = await Promise.all([tuner.run(), tuner.run()]);
  assert.equal(b, null, "le second appel simultané n'ouvre pas un second calcul");
  assert.equal(a.changed, false);
  assert.equal(a.calibrage.applique, false);
  assert.equal(w.analysis.calibration.pickShift, 0);
});
