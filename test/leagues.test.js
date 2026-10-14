"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { LEAGUES, byKey, isCup, seasonStartYear, OTHER_KEY, OTHER } = require("../src/leagues");

test("catalogue des compétitions : 10 championnats principaux, 3 coupes d'Europe, 20 championnats complémentaires", () => {
  const core = LEAGUES.filter((l) => l.tier === "core" && !isCup(l));
  const cups = LEAGUES.filter(isCup);
  const extras = LEAGUES.filter((l) => l.tier === "extra");
  assert.deepEqual(core.map((l) => l.key), ["PL", "PD", "SA", "BL1", "FL1", "PPL", "DED", "BSA", "SPL", "BJL"]);
  assert.deepEqual(cups.map((l) => l.key), ["UCL", "UEL", "UECL"]);
  assert.equal(extras.length, 20);
  assert.equal(LEAGUES.length, 33);
  assert.ok(cups.every((l) => l.tier === "core"), "les coupes se chargent avec l'essentiel");
  assert.ok(extras.every((l) => l.kind === "league"));
});

test("chaque compétition a une clé, un identifiant TheSportsDB et un nom TheSportsDB uniques", () => {
  for (const field of ["key", "tsdb", "tsdbName", "name"]) {
    const values = LEAGUES.map((l) => l[field]);
    assert.ok(values.every((v) => typeof v === "string" && v.length > 0), field);
    assert.equal(new Set(values).size, values.length, `${field} en double`);
  }
  const fd = LEAGUES.map((l) => l.fd).filter(Boolean);
  assert.equal(new Set(fd).size, fd.length);
  assert.ok(LEAGUES.every((l) => ["split", "calendar"].includes(l.style)));
  assert.equal(byKey.get("UCL").tsdb, "4480");
  assert.equal(byKey.get("UCL").fd, "CL");
});

test("niveau a priori : défini pour tous les championnats, décroissant du plus fort au plus faible des grands championnats, absent des coupes", () => {
  for (const l of LEAGUES.filter((x) => !isCup(x))) {
    assert.ok(Number.isFinite(l.strength) && l.strength <= 0 && l.strength >= -1, `${l.key} : ${l.strength}`);
  }
  assert.equal(byKey.get("PL").strength, 0, "la Premier League sert de référence");
  const s = (k) => byKey.get(k).strength;
  assert.ok(s("PL") > s("PD") && s("PD") >= s("SA") && s("SA") >= s("BL1") && s("BL1") > s("FL1") && s("FL1") > s("PPL"));
  for (const [second, first] of [["ELC", "PL"], ["BL2", "BL1"], ["SD", "PD"], ["SB", "SA"], ["FL2", "FL1"]]) {
    assert.ok(s(second) < s(first), `${second} (deuxième division) est sous ${first}`);
  }
  assert.ok(LEAGUES.filter(isCup).every((l) => l.strength === undefined));
  // les clubs connus seulement par une coupe sont supposés plus faibles que tous les championnats suivis, hors extrêmes
  assert.equal(OTHER_KEY, "EUR");
  assert.ok(OTHER.strength < s("SPL") && OTHER.strength < s("BJL"));
  assert.equal(OTHER.kind, "other");
  assert.equal(byKey.get(OTHER_KEY), undefined, "le groupe des autres clubs n'est pas un championnat que l'on charge");
});

test("isCup ne reconnaît que les coupes", () => {
  assert.equal(isCup(byKey.get("UCL")), true);
  assert.equal(isCup(byKey.get("PL")), false);
  assert.equal(isCup(byKey.get("TSL")), false);
  assert.equal(isCup(null), false);
  assert.equal(isCup(undefined), false);
});

test("année de début de saison : août-mai (« split ») ou année civile (« calendar »)", () => {
  const oct = Date.UTC(2026, 9, 14);
  const mar = Date.UTC(2027, 2, 3);
  assert.equal(seasonStartYear(byKey.get("PL"), oct), 2026);
  assert.equal(seasonStartYear(byKey.get("PL"), mar), 2026);
  assert.equal(seasonStartYear(byKey.get("UCL"), oct), 2026);
  assert.equal(seasonStartYear(byKey.get("UCL"), mar), 2026);
  assert.equal(seasonStartYear(byKey.get("BSA"), mar), 2027);
  assert.equal(seasonStartYear(byKey.get("NOR"), oct), 2026);
  assert.equal(seasonStartYear(byKey.get("ARG"), mar), 2027);
});
