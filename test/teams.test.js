"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { findTeam } = require("../src/teams");

const TEAMS = [
  { id: 1, name: "Paris Saint-Germain FC", shortName: "PSG", leagueKey: "FL1" },
  { id: 2, name: "Olympique de Marseille", shortName: "Marseille", leagueKey: "FL1" },
  { id: 3, name: "Manchester City FC", shortName: "Man City", leagueKey: "PL" },
  { id: 4, name: "Manchester United FC", shortName: "Man United", leagueKey: "PL" },
  { id: 5, name: "Real Madrid CF", shortName: "Real Madrid", leagueKey: "PD" },
  { id: 6, name: "Real Sociedad de Fútbol", shortName: "Real Sociedad", leagueKey: "PD" },
  { id: 7, name: "Club Atlético de Madrid", shortName: "Atleti", leagueKey: "PD" },
  { id: 8, name: "FC Internazionale Milano", shortName: "Inter", leagueKey: "SA" },
  { id: 9, name: "AC Milan", shortName: "Milan", leagueKey: "SA" },
  { id: 10, name: "FC Bayern München", shortName: "Bayern", leagueKey: "BL1" },
  { id: 11, name: "Borussia Dortmund", shortName: "Dortmund", leagueKey: "BL1" },
  { id: 12, name: "Borussia Mönchengladbach", shortName: "M'gladbach", leagueKey: "BL1" },
];
const id = (q) => findTeam(q, TEAMS).team?.id;

test("noms exacts, avec accents et casse différents", () => {
  assert.equal(id("Paris Saint-Germain FC"), 1);
  assert.equal(id("paris saint germain"), 1);
  assert.equal(id("BAYERN MUNCHEN"), 10);
  assert.equal(id("atletico madrid"), 7);
});

test("surnoms courants", () => {
  assert.equal(id("PSG"), 1);
  assert.equal(id("Man City"), 3);
  assert.equal(id("man utd"), 4);
  assert.equal(id("Inter"), 8);
  assert.equal(id("Milan"), 9);
  assert.equal(id("Bayern"), 10);
  assert.equal(id("Gladbach"), 12);
});

test("noms partiels et petites fautes de frappe", () => {
  assert.equal(id("Marseille"), 2);
  assert.equal(id("Dortmund"), 11);
  assert.equal(id("Manchester Citty"), 3);
  assert.equal(id("Real Madrd"), 5);
});

test("un nom ambigu n'est pas deviné : on propose des choix", () => {
  const r = findTeam("Real", TEAMS);
  assert.equal(r.team, null);
  assert.equal(r.ambiguous, true);
  assert.ok(r.alternatives.length >= 2);
  const m = findTeam("Manchester", TEAMS);
  assert.equal(m.team, null);
});

test("équipe inconnue ou saisie vide", () => {
  assert.equal(findTeam("Équipe Imaginaire XYZ", TEAMS).team, null);
  assert.equal(findTeam("", TEAMS).team, null);
  assert.equal(findTeam(undefined, TEAMS).team, null);
});

test("on peut restreindre la recherche à un championnat", () => {
  assert.equal(findTeam("Real Madrid", TEAMS, { leagueKey: "FL1" }).team, null);
  assert.equal(findTeam("Real Madrid", TEAMS, { leagueKey: "PD" }).team.id, 5);
});
