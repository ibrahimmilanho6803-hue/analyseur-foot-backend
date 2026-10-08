"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDataService } = require("../src/data");
const { SwrCache } = require("../src/cache");
const { loadConfig } = require("../src/config");
const { simulateLeague, DAY } = require("./helpers");

const NOW = Date.UTC(2026, 9, 8);
const quiet = { log() {}, warn() {}, error() {} };
const config = loadConfig({ FOOTBALL_DATA_API_KEY: "x" });
const JULY = Date.UTC(2026, 6, 1);

// Saison simulée, découpée comme le ferait une vraie source : saison en cours / précédente.
function fixtureSeasons() {
  const sim = simulateLeague({ teams: 12, seasons: 3, seed: 5, now: NOW });
  const toMatch = (m) => ({ ...m, hg: m.hg, ag: m.ag });
  const cur = sim.matches.filter((m) => m.kickoff >= JULY).map(toMatch);
  const prev = sim.matches.filter((m) => m.kickoff < JULY).map(toMatch);
  const upcoming = [1, 2, 3, 4, 5, 6].map((i) => ({
    id: `F${i}`,
    kickoff: NOW + i * DAY,
    status: "scheduled",
    hg: null,
    ag: null,
    home: { id: `T${i - 1}`, name: `Equipe T${i - 1}` },
    away: { id: `T${i + 5}`, name: `Equipe T${i + 5}` },
  }));
  return { cur: [...cur, ...upcoming], prev, sim };
}

function fakeProvider(name, handler, { keys = null } = {}) {
  const calls = [];
  return {
    name,
    label: `Source ${name}`,
    calls,
    supports: (l) => (keys ? keys.includes(l.key) : true),
    fetchSeason: async (league, year) => {
      calls.push({ league: league.key, year });
      return handler(league, year);
    },
  };
}

function service(providers, extra = {}) {
  return createDataService({ config, http: null, cache: new SwrCache({ now: () => NOW }), now: () => NOW, log: quiet, providers, ...extra });
}

test("construit les équipes, les matchs joués et les matchs à venir d'un championnat", async () => {
  const { cur, prev } = fixtureSeasons();
  const p = fakeProvider("fake", (l, year) => ({ matches: year === 2026 ? cur : prev, limited: false }));
  const data = await service([p]).getLeagueData("PL");
  assert.equal(data.provider, "fake");
  assert.equal(data.teams.size, 12);
  assert.equal(data.fixtures.length, 6);
  assert.ok(data.fixtures.every((m) => m.kickoff > NOW - 3600000));
  assert.ok(data.finished.every((m) => m.status === "finished" && m.kickoff <= NOW));
  assert.equal(data.finished.length, cur.filter((m) => m.status === "finished").length + prev.length);
  assert.ok(data.fit.nMatches > 200);
  assert.deepEqual(
    data.finished.map((m) => m.kickoff),
    [...data.finished.map((m) => m.kickoff)].sort((a, b) => a - b),
    "matchs joués classés par date"
  );
  assert.equal([...data.teams.values()][0].leagueKey, "PL");
});

test("la saison en cours et la précédente sont demandées, une seule fois chacune", async () => {
  const { cur, prev } = fixtureSeasons();
  const p = fakeProvider("fake", (l, year) => ({ matches: year === 2026 ? cur : prev, limited: false }));
  const svc = service([p]);
  await Promise.all([svc.getLeagueData("PL"), svc.getLeagueData("PL"), svc.getLeagueData("PL")]);
  assert.deepEqual(
    p.calls.map((c) => c.year).sort(),
    [2025, 2026]
  );
});

test("bascule sur la source suivante quand la première est refusée", async () => {
  const { cur, prev } = fixtureSeasons();
  const denied = fakeProvider("a", () => {
    throw Object.assign(new Error("HTTP 403"), { status: 403 });
  });
  const ok = fakeProvider("b", (l, year) => ({ matches: year === 2026 ? cur : prev, limited: false }));
  const data = await service([denied, ok]).getLeagueData("PL");
  assert.equal(data.provider, "b");
  assert.equal(data.errors.length, 1);
  assert.match(data.errors[0], /accès refusé/);
});

test("ignore une source qui ne renvoie que des données partielles (clé gratuite)", async () => {
  const { cur, prev } = fixtureSeasons();
  const partial = fakeProvider("a", () => ({ matches: cur.slice(0, 15), limited: true, rawCount: 15 }));
  const full = fakeProvider("b", (l, year) => ({ matches: year === 2026 ? cur : prev, limited: false }));
  const data = await service([partial, full]).getLeagueData("PL");
  assert.equal(data.provider, "b");
  assert.match(data.errors[0], /incomplètes/);
});

test("échec clair quand aucune source n'a de données", async () => {
  const empty = fakeProvider("a", () => ({ matches: [], limited: false }));
  const broken = fakeProvider("b", () => {
    throw new Error("réseau coupé");
  });
  await assert.rejects(service([empty, broken]).getLeagueData("PL"), (e) => {
    assert.equal(e.code, "NO_DATA");
    assert.equal(e.details.length, 2);
    return true;
  });
});

test("un championnat que personne ne couvre est refusé tout de suite", async () => {
  const p = fakeProvider("a", () => ({ matches: [], limited: false }), { keys: ["PL"] });
  const svc = service([p]);
  assert.deepEqual(
    svc.leagues.map((l) => l.key),
    ["PL"]
  );
  await assert.rejects(svc.getLeagueData("SA"), (e) => e.code === "UNSUPPORTED");
  await assert.rejects(svc.getLeagueData("XYZ"), (e) => e.code === "UNSUPPORTED");
});

test("si la saison précédente est introuvable, le championnat reste utilisable", async () => {
  const { cur } = fixtureSeasons();
  const p = fakeProvider("a", (l, year) => {
    if (year === 2026) return { matches: cur, limited: false };
    throw new Error("saison précédente indisponible");
  });
  const data = await service([p]).getLeagueData("PL");
  assert.equal(data.hasPrevious, false);
  assert.equal(data.teams.size, 12);
  assert.match(data.errors[0], /saison précédente/);
});

test("ensureAll : prêts, en attente (trop lents) et en échec", async () => {
  const { cur, prev } = fixtureSeasons();
  const p = fakeProvider("a", (league, year) => {
    if (league.key === "SA") return new Promise(() => {}); // ne répond jamais
    if (league.key === "PD") throw new Error("source en panne");
    return { matches: year === 2026 ? cur : prev, limited: false };
  }, { keys: ["PL", "PD", "SA"] });
  const svc = service([p]);
  const r = await svc.ensureAll({ budgetMs: 60 });
  assert.deepEqual(r.ready.map((d) => d.league.key), ["PL"]);
  assert.deepEqual(r.pending, ["SA"]);
  assert.deepEqual(r.failed.map((f) => f.key), ["PD"]);
});

test("allTeams et status reflètent ce qui est chargé", async () => {
  const { cur, prev } = fixtureSeasons();
  const p = fakeProvider("fake", (l, year) => ({ matches: year === 2026 ? cur : prev, limited: false }), { keys: ["PL", "SA"] });
  const svc = service([p]);
  assert.equal(svc.allTeams().length, 0);
  assert.equal(svc.status().championnats.find((c) => c.key === "PL").charge, false);
  await svc.ensureAll({ budgetMs: 1000 });
  assert.equal(svc.allTeams().length, 24);
  assert.ok(svc.allTeams().some((t) => t.leagueKey === "SA"));
  const st = svc.status();
  const pl = st.championnats.find((c) => c.key === "PL");
  assert.equal(pl.charge, true);
  assert.equal(pl.matchsAVenir, 6);
  assert.equal(pl.source, "fake");
  assert.equal(st.championnats.find((c) => c.key === "BSA").couvert, false);
  assert.deepEqual(st.sources, ["Source fake"]);
});

test("un club absent de la saison précédente (promu) reçoit un a priori plus prudent", async () => {
  const { cur, prev } = fixtureSeasons();
  const veryOld = Date.UTC(2006, 0, 1); // trop ancien pour compter dans le calcul, mais prouve la présence
  const old = (id, h, a) => ({ id, kickoff: veryOld, status: "finished", hg: 1, ag: 1, home: { id: h, name: `Equipe ${h}` }, away: { id: a, name: `Equipe ${a}` } });
  const mk = (previous) => fakeProvider("a", (l, year) => ({ matches: year === 2026 ? cur : previous, limited: false }));
  const known = await service([mk([old("o1", "T0", "T1"), old("o2", "T0", "T11")])]).getLeagueData("PL");
  const promoted = await service([mk([old("o1", "T0", "T1")])]).getLeagueData("PL");
  const a = known.fit.teams.get("T11");
  const b = promoted.fit.teams.get("T11");
  assert.ok(b.a < a.a, `attaque ${b.a} devrait être inférieure à ${a.a}`);
  assert.ok(b.d > a.d, `défense ${b.d} devrait être supérieure (plus faible) à ${a.d}`);
  assert.equal(known.fit.nMatches, promoted.fit.nMatches, "mêmes données utiles : seul l'a priori change");
});

test("changer les réglages du modèle recalcule les forces d'équipes sans re-télécharger les matchs", async () => {
  const { cur, prev } = fixtureSeasons();
  const p = fakeProvider("a", (l, year) => ({ matches: year === 2026 ? cur : prev, limited: false }));
  const svc = service([p]);
  const before = await svc.getLeagueData("PL");
  const calls = p.calls.length;
  assert.deepEqual(svc.getModelParams(), { halfLifeDays: 300, priorMatches: 10 });
  svc.setModelParams({ halfLifeDays: 40, priorMatches: 60 });
  const after = await svc.getLeagueData("PL");
  assert.notEqual(after, before);
  assert.notEqual(after.fit.teams.get("T0").a, before.fit.teams.get("T0").a);
  assert.equal(p.calls.length, calls, "les matchs déjà téléchargés sont réutilisés");
  assert.deepEqual(svc.getModelParams(), { halfLifeDays: 40, priorMatches: 60 });
});
