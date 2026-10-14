"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../src/config");

test("correction des totaux de buts : active par défaut, rythme ramené à 0,5", () => {
  const { model } = loadConfig({});
  assert.equal(model.calibration, true);
  assert.equal(model.rhythmExponent, 0.5);
});

test("MODEL_CALIBRATION : seules les valeurs d'arrêt (off, false, 0, non, no) coupent la correction, majuscules et espaces ignorés", () => {
  for (const off of ["off", "OFF", "Off", "false", "FALSE", "0", "non", "no", " off "]) {
    assert.equal(loadConfig({ MODEL_CALIBRATION: off }).model.calibration, false, JSON.stringify(off));
  }
  for (const on of [undefined, "", "on", "true", "1", "oui", "yes", "n'importe quoi"]) {
    assert.equal(loadConfig({ MODEL_CALIBRATION: on }).model.calibration, true, JSON.stringify(on));
  }
});

test("MODEL_RHYTHM_EXPONENT : borné entre 0,2 et 1 (1 = pas de correction), valeur illisible ignorée", () => {
  assert.equal(loadConfig({ MODEL_RHYTHM_EXPONENT: "0.7" }).model.rhythmExponent, 0.7);
  assert.equal(loadConfig({ MODEL_RHYTHM_EXPONENT: "1" }).model.rhythmExponent, 1);
  assert.equal(loadConfig({ MODEL_RHYTHM_EXPONENT: "5" }).model.rhythmExponent, 1, "au-delà de 1 le rythme serait amplifié : plafonné");
  assert.equal(loadConfig({ MODEL_RHYTHM_EXPONENT: "0.01" }).model.rhythmExponent, 0.2);
  assert.equal(loadConfig({ MODEL_RHYTHM_EXPONENT: "abc" }).model.rhythmExponent, 0.5);
  assert.equal(loadConfig({ MODEL_RHYTHM_EXPONENT: "" }).model.rhythmExponent, 0.5);
});

test("ouverture à tous les matchs : tout est activé par défaut, mémoire des coupes d'un an", () => {
  const { europe } = loadConfig({});
  assert.deepEqual(europe, { enabled: true, extraLeagues: true, topCups: true, halfLifeDays: 365 });
});

test("EUROPE_ENABLED, EXTRA_LEAGUES_ENABLED, TOP_CUPS : seules les valeurs d'arrêt coupent, chaque interrupteur est indépendant", () => {
  for (const [name, field] of [["EUROPE_ENABLED", "enabled"], ["EXTRA_LEAGUES_ENABLED", "extraLeagues"], ["TOP_CUPS", "topCups"]]) {
    for (const off of ["off", "OFF", "false", "0", "non", "no", " off "]) {
      assert.equal(loadConfig({ [name]: off }).europe[field], false, `${name}=${JSON.stringify(off)}`);
    }
    for (const on of [undefined, "", "on", "true", "1", "oui", "n'importe quoi"]) {
      assert.equal(loadConfig({ [name]: on }).europe[field], true, `${name}=${JSON.stringify(on)}`);
    }
  }
  const only = loadConfig({ TOP_CUPS: "off" }).europe;
  assert.deepEqual([only.enabled, only.extraLeagues, only.topCups], [true, true, false]);
});

test("EUROPE_HALF_LIFE_DAYS : borné entre 60 et 1500 jours, valeur illisible ignorée", () => {
  assert.equal(loadConfig({ EUROPE_HALF_LIFE_DAYS: "200" }).europe.halfLifeDays, 200);
  assert.equal(loadConfig({ EUROPE_HALF_LIFE_DAYS: "5" }).europe.halfLifeDays, 60);
  assert.equal(loadConfig({ EUROPE_HALF_LIFE_DAYS: "99999" }).europe.halfLifeDays, 1500);
  assert.equal(loadConfig({ EUROPE_HALF_LIFE_DAYS: "abc" }).europe.halfLifeDays, 365);
  assert.equal(loadConfig({ EUROPE_HALF_LIFE_DAYS: "" }).europe.halfLifeDays, 365);
});

test("Top Matchs : plus d'objectif de cote ni de plage de probabilité (l'ancienne variable TOP_TARGET_ODDS est ignorée)", () => {
  const { top } = loadConfig({ TOP_TARGET_ODDS: "3.5" });
  assert.equal(top.targetOdds, undefined);
  assert.equal(top.minLegP, undefined);
  assert.equal(top.maxLegP, undefined);
  assert.equal(top.count, 3);
  assert.equal(top.windowHours, 72);
  assert.equal(top.maxWindowHours, 168);
});
