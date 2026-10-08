"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { recent, summarize, formString, teamStats, headToHead, matchStats } = require("../src/stats");
const { DAY } = require("./helpers");

const club = (id) => ({ id, name: `Club ${id}` });
let n = 0;
const game = (day, h, a, hg, ag) => ({ id: `m${++n}`, kickoff: Date.UTC(2026, 0, 1) + day * DAY, home: club(h), away: club(a), hg, ag, status: "finished" });

// Du plus ancien au plus récent, comme le fournit le service de données.
const FINISHED = [
  game(1, "A", "B", 2, 0),
  game(2, "C", "A", 1, 1),
  game(3, "B", "A", 0, 3),
  game(4, "A", "C", 1, 2),
  game(5, "A", "B", 0, 0),
  game(6, "C", "B", 2, 0),
];

test("forme : du plus récent au plus ancien", () => {
  assert.equal(formString(recent(FINISHED, "A", 5), "A"), "NDVNV");
  assert.equal(formString(recent(FINISHED, "B", 5), "B"), "DNDD"); // défaite contre C, nul contre A, puis deux défaites contre A
});

test("bilan à domicile et à l'extérieur", () => {
  const home = summarize(recent(FINISHED, "A", 10, "home"), "A");
  assert.deepEqual(home, { played: 3, won: 1, draw: 1, lost: 1, goalsFor: 3, goalsAgainst: 2, avgGoalsFor: 1, avgGoalsAgainst: 0.67 });
  const away = summarize(recent(FINISHED, "A", 10, "away"), "A");
  assert.deepEqual(away, { played: 2, won: 1, draw: 1, lost: 0, goalsFor: 4, goalsAgainst: 1, avgGoalsFor: 2, avgGoalsAgainst: 0.5 });
});

test("la limite de matchs est respectée et une équipe inconnue n'a pas de statistiques", () => {
  assert.equal(recent(FINISHED, "A", 2).length, 2);
  assert.equal(recent(FINISHED, "Z", 5).length, 0);
  assert.deepEqual(summarize([], "Z"), { played: 0, won: 0, draw: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, avgGoalsFor: 0, avgGoalsAgainst: 0 });
});

test("vue d'ensemble d'une équipe", () => {
  const s = teamStats(FINISHED, "A", "home");
  assert.equal(s.forme, "NDVNV");
  assert.equal(s.matchsAnalyses, 5);
  assert.equal(s.victoires, 2);
  assert.equal(s.butsMarquesParMatch, 1.4);
  assert.ok(s.domicile && !s.exterieur);
  assert.equal(teamStats(FINISHED, "A", "away").exterieur.played, 2);
});

test("confrontations directes vues depuis l'équipe qui reçoit", () => {
  const h = headToHead(FINISHED, "A", "B");
  assert.deepEqual(h.bilan, { homeWins: 2, draws: 1, awayWins: 0 });
  assert.deepEqual(
    h.matches.map((m) => `${m.homeTeam} ${m.score} ${m.awayTeam}`),
    ["Club A 0-0 Club B", "Club B 0-3 Club A", "Club A 2-0 Club B"]
  );
  assert.match(h.matches[0].date, /^2026-01-06$/);
  assert.deepEqual(headToHead(FINISHED, "B", "A").bilan, { homeWins: 0, draws: 1, awayWins: 2 });
  assert.equal(headToHead(FINISHED, "A", "Z"), null);
  assert.equal(headToHead(FINISHED, "A", "B", 2).matches.length, 2);
});

test("bloc complet attendu par l'application", () => {
  const s = matchStats(FINISHED, "A", "C");
  assert.ok(s.statsEquipe1 && s.statsEquipe2);
  const { won, draw, lost, goalsFor, goalsAgainst, avgGoalsFor } = s.homeAway1.home;
  for (const v of [won, draw, lost, goalsFor, goalsAgainst, avgGoalsFor]) assert.equal(typeof v, "number");
  assert.equal(typeof s.homeAway2.away.avgGoalsFor, "number");
  assert.equal(s.h2h.matches.length, 2);
});
