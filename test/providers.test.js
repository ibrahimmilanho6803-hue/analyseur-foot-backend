"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFootballData, normalizeFootballData } = require("../src/providers/footballdata");
const { createTheSportsDb, normalizeTheSportsDb } = require("../src/providers/thesportsdb");
const { byKey } = require("../src/leagues");

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const team = (id, name, shortName = "", tla = "") => ({ id, name, shortName, tla });

function fakeHttp(payloads) {
  const calls = [];
  return {
    calls,
    getJson: async (url, opts) => {
      calls.push({ url, opts });
      const next = payloads[Math.min(calls.length - 1, payloads.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("football-data : un match terminé est normalisé", () => {
  const m = normalizeFootballData({
    id: 11,
    utcDate: "2026-09-12T14:00:00Z",
    status: "FINISHED",
    homeTeam: team(57, "Arsenal FC", "Arsenal", "ARS"),
    awayTeam: team(61, "Chelsea FC", "Chelsea", "CHE"),
    score: { fullTime: { home: 2, away: 1 } },
  });
  assert.deepEqual(m, {
    id: "fd:11",
    kickoff: Date.UTC(2026, 8, 12, 14),
    status: "finished",
    hg: 2,
    ag: 1,
    home: { id: "fd:57", name: "Arsenal FC", shortName: "Arsenal" },
    away: { id: "fd:61", name: "Chelsea FC", shortName: "Chelsea" },
  });
});

test("football-data : à venir, reporté, sans score ou illisible", () => {
  const base = { utcDate: "2026-10-12T14:00:00Z", homeTeam: team(1, "A"), awayTeam: team(2, "B") };
  const upcoming = normalizeFootballData({ ...base, id: 1, status: "TIMED", score: { fullTime: { home: null, away: null } } });
  assert.equal(upcoming.status, "scheduled");
  assert.equal(upcoming.hg, null);
  assert.equal(normalizeFootballData({ ...base, id: 2, status: "POSTPONED", score: { fullTime: {} } }).status, "other");
  assert.equal(normalizeFootballData({ ...base, id: 3, status: "FINISHED", score: { fullTime: { home: null, away: null } } }).status, "other");
  assert.equal(normalizeFootballData({ ...base, id: 4, utcDate: "n'importe quoi", status: "TIMED" }), null);
  assert.equal(normalizeFootballData({ ...base, id: 5, homeTeam: { id: null, name: "X" }, status: "TIMED" }), null);
  assert.equal(normalizeFootballData(null), null);
});

test("football-data : appel de la bonne adresse avec la clé en en-tête", async () => {
  const http = fakeHttp([
    {
      matches: [
        { id: 1, utcDate: "2026-09-12T14:00:00Z", status: "FINISHED", homeTeam: team(1, "A"), awayTeam: team(2, "B"), score: { fullTime: { home: 0, away: 0 } } },
        { id: 2, utcDate: "pas une date", status: "FINISHED", homeTeam: team(1, "A"), awayTeam: team(2, "B"), score: { fullTime: { home: 1, away: 0 } } },
      ],
    },
  ]);
  const p = createFootballData({ http, key: "CLE-TEST" });
  const out = await p.fetchSeason(byKey.get("PL"), 2026);
  assert.equal(http.calls[0].url, "https://api.football-data.org/v4/competitions/PL/matches?season=2026");
  assert.equal(http.calls[0].opts.headers["X-Auth-Token"], "CLE-TEST");
  assert.equal(http.calls[0].opts.throttleKey, "footballdata");
  assert.equal(out.matches.length, 1, "le match illisible est ignoré");
  assert.equal(out.limited, false);
});

test("football-data : ne couvre que les championnats de l'offre et seulement avec une clé", () => {
  const http = fakeHttp([{}]);
  assert.equal(createFootballData({ http, key: "" }).supports(byKey.get("PL")), false);
  assert.equal(createFootballData({ http, key: "k" }).supports(byKey.get("PL")), true);
  assert.equal(createFootballData({ http, key: "k" }).supports(byKey.get("SPL")), false);
  assert.equal(createFootballData({ http, key: "k" }).supports(byKey.get("BJL")), false);
});

test("TheSportsDB : un match joué et un match à venir", () => {
  const played = normalizeTheSportsDb(
    { idEvent: "9", strTimestamp: "2026-09-12T14:00:00", idHomeTeam: "133604", idAwayTeam: "133610", strHomeTeam: "Arsenal", strAwayTeam: "Chelsea", intHomeScore: "2", intAwayScore: "1" },
    NOW
  );
  assert.equal(played.status, "finished");
  assert.equal(played.kickoff, Date.UTC(2026, 8, 12, 14), "sans fuseau indiqué : heure UTC");
  assert.equal(played.hg, 2);
  assert.equal(played.home.id, "ts:133604");

  const later = normalizeTheSportsDb(
    { idEvent: "10", dateEvent: "2026-10-20", strTime: "19:45:00", idHomeTeam: "1", idAwayTeam: "2", strHomeTeam: "A", strAwayTeam: "B", intHomeScore: null, intAwayScore: null },
    NOW
  );
  assert.equal(later.status, "scheduled");
  assert.equal(later.kickoff, Date.UTC(2026, 9, 20, 19, 45));
  assert.equal(later.hg, null);
});

test("TheSportsDB : un match reporté ou un score incohérent n'est jamais compté comme joué", () => {
  const ev = { idEvent: "1", strTimestamp: "2026-09-12T14:00:00", idHomeTeam: "1", idAwayTeam: "2", strHomeTeam: "A", strAwayTeam: "B" };
  assert.equal(normalizeTheSportsDb({ ...ev, intHomeScore: "1", intAwayScore: "0", strPostponed: "yes" }, NOW).status, "other");
  assert.equal(normalizeTheSportsDb({ ...ev, intHomeScore: "1", intAwayScore: null }, NOW).status, "other");
  assert.equal(normalizeTheSportsDb({ ...ev, intHomeScore: "-3", intAwayScore: "0" }, NOW).status, "other");
  // Un score annoncé pour un match censé se jouer dans le futur est ignoré.
  assert.equal(normalizeTheSportsDb({ ...ev, strTimestamp: "2026-12-01T14:00:00", intHomeScore: "1", intAwayScore: "0" }, NOW).status, "other");
  assert.equal(normalizeTheSportsDb({ idEvent: "1", strTimestamp: "2026-09-12T14:00:00" }, NOW), null, "sans équipes : ignoré");
});

test("TheSportsDB : détecte la clé gratuite (15 matchs seulement) et la saison complète", async () => {
  const mk = (n) =>
    Array.from({ length: n }, (_, i) => ({
      idEvent: String(i),
      strTimestamp: "2026-09-12T14:00:00",
      idHomeTeam: String(1 + (i % 20)),
      idAwayTeam: String(21 + (i % 20)),
      strHomeTeam: "A",
      strAwayTeam: "B",
      intHomeScore: "1",
      intAwayScore: "1",
    }));
  const free = createTheSportsDb({ http: fakeHttp([{ events: mk(15) }]), key: "123", now: () => NOW });
  const a = await free.fetchSeason(byKey.get("PL"), 2026);
  assert.equal(a.limited, true);
  assert.equal(a.rawCount, 15);

  const full = createTheSportsDb({ http: fakeHttp([{ events: mk(380) }]), key: "KEY", now: () => NOW });
  const b = await full.fetchSeason(byKey.get("PL"), 2026);
  assert.equal(b.limited, false);
  assert.equal(b.matches.length, 380);
});

test("TheSportsDB : adresse, nom de saison et repli pour les championnats sur l'année civile", async () => {
  const split = fakeHttp([{ events: null }]);
  await createTheSportsDb({ http: split, key: "KEY", now: () => NOW }).fetchSeason(byKey.get("PL"), 2026);
  assert.equal(split.calls.length, 1);
  assert.equal(split.calls[0].url, "https://www.thesportsdb.com/api/v1/json/KEY/eventsseason.php?id=4328&s=2026-2027");

  const cal = fakeHttp([{ events: null }, { events: [] }]);
  const out = await createTheSportsDb({ http: cal, key: "KEY", now: () => NOW }).fetchSeason(byKey.get("BSA"), 2026);
  assert.deepEqual(
    cal.calls.map((c) => c.url.split("&s=")[1]),
    ["2026", "2026-2027"]
  );
  assert.deepEqual(out, { matches: [], limited: false, rawCount: 0 });
});

test("TheSportsDB : couvre seulement les championnats connus et avec une clé", () => {
  const http = fakeHttp([{}]);
  assert.equal(createTheSportsDb({ http, key: "" }).supports(byKey.get("PL")), false);
  assert.equal(createTheSportsDb({ http, key: "k" }).supports(byKey.get("SPL")), true);
});
