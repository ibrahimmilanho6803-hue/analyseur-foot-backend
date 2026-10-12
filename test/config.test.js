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
