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

test("« Top Matchs » et « Auto » : quatre matchs, cote totale visée de 5, paris entre 60 % et 88 %", () => {
  const { top } = loadConfig({});
  assert.deepEqual(top, { count: 4, windowHours: 72, maxWindowHours: 168, targetOdds: 5, minLegP: 0.6, maxLegP: 0.88, budgetMs: 25000 });
});

test("TOP_TARGET_ODDS : cote totale visée, écrite avec un point ou une virgule, bornée entre 1,5 et 50, valeur illisible = 5", () => {
  const target = (v) => loadConfig({ TOP_TARGET_ODDS: v }).top.targetOdds;
  assert.equal(target("3"), 3);
  assert.equal(target("2.5"), 2.5);
  assert.equal(target("7,5"), 7.5);
  assert.equal(target(" 4 "), 4);
  assert.equal(target("1"), 1.5, "une cote visée sous 1,5 ne laisserait aucun choix : bornée");
  assert.equal(target("0.2"), 1.5);
  assert.equal(target("500"), 50);
  for (const v of [undefined, "", "abc", "NaN"]) assert.equal(target(v), 5, JSON.stringify(v));
  assert.equal(loadConfig({}).top.targetOdds, 5);
});

test("PICK_MAX_PROBABILITY : plafond facultatif, écrit en 0.95, 95 ou « 95 % », borné entre 50 % et 100 %, valeur illisible = 88 %", () => {
  const cap = (v) => loadConfig({ PICK_MAX_PROBABILITY: v }).top.maxLegP;
  for (const v of ["0.95", "95", "95 %", "95%", " 95 ", "0,95"]) assert.ok(Math.abs(cap(v) - 0.95) < 1e-12, JSON.stringify(v));
  assert.equal(cap("0.9"), 0.9);
  assert.equal(cap("0.5"), 0.5);
  assert.equal(cap("30"), 0.5, "un plafond trop bas laisserait trop peu de paris : borné à 50 %");
  assert.equal(cap("0.2"), 0.5);
  assert.equal(cap("100"), 1);
  assert.equal(cap("1"), 1);
  assert.equal(cap("250"), 1);
  for (const v of [undefined, "", "abc", "0", "-5", "NaN", "Infinity"]) assert.equal(cap(v), 0.88, JSON.stringify(v));
});
