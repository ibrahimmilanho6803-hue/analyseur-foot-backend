"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDataService } = require("../src/data");
const { fitLeague, expectedGoals } = require("../src/model");
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

// Même saison simulée, mais avec des identifiants de clubs propres à chaque championnat (comme dans les vraies sources : un club n'a qu'un identifiant).
const own = (key, matches) => matches.map((m) => ({ ...m, id: `${key}-${m.id}`, home: { ...m.home, id: `${key}:${m.home.id}` }, away: { ...m.away, id: `${key}:${m.away.id}` } }));

test("allTeams et status reflètent ce qui est chargé", async () => {
  const { cur, prev } = fixtureSeasons();
  const p = fakeProvider("fake", (l, year) => ({ matches: own(l.key, year === 2026 ? cur : prev), limited: false }), { keys: ["PL", "SA"] });
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

test("status : état de chaque championnat et raison d'un échec (jamais « pas chargé » sans explication)", async () => {
  const { cur, prev } = fixtureSeasons();
  const p = fakeProvider("a", (league, year) => {
    if (league.key === "PD") throw new Error("source en panne");
    return { matches: year === 2026 ? cur : prev, limited: false };
  }, { keys: ["PL", "PD", "SA"] });
  const svc = service([p]);
  const before = svc.status().championnats;
  assert.deepEqual(before.filter((c) => c.couvert).map((c) => c.etat), ["chargement", "chargement", "chargement"]);
  assert.equal(before.find((c) => c.key === "BSA").etat, "non_couvert");
  assert.equal(svc.allFailed(), false);
  await svc.ensureAll({ budgetMs: 1000 });
  const st = svc.status().championnats;
  assert.equal(st.find((c) => c.key === "PL").etat, "pret");
  const pd = st.find((c) => c.key === "PD");
  assert.equal(pd.etat, "echec");
  assert.equal(pd.charge, false);
  assert.match(pd.derniereErreur, /source en panne/);
  assert.equal(svc.allFailed(), false, "PL et SA sont prêts");
});

test("allFailed : vrai seulement quand rien n'est chargé et que tout a échoué", async () => {
  const partial = fakeProvider("a", () => ({ matches: [], limited: true, rawCount: 15 }), { keys: ["PL", "SA"] });
  const svc = service([partial]);
  assert.equal(svc.allFailed(), false, "rien n'a encore été essayé : simple chargement");
  await svc.ensureAll({ budgetMs: 1000 });
  assert.equal(svc.allFailed(), true);
  const pl = svc.status().championnats.find((c) => c.key === "PL");
  assert.equal(pl.etat, "echec");
  assert.match(pl.derniereErreur, /clé gratuite/);
});

test("les erreurs exposées (status, ensureAll) ne contiennent jamais de clé", async () => {
  const leaky = fakeProvider("a", () => {
    throw new Error("réseau : https://www.thesportsdb.com/api/v1/json/SECRET123/eventsseason.php?id=4328 a échoué");
  }, { keys: ["PL"] });
  const svc = service([leaky]);
  const r = await svc.ensureAll({ budgetMs: 1000 });
  assert.equal(r.failed.length, 1);
  assert.ok(!JSON.stringify(r.failed).includes("SECRET123"));
  assert.ok(!JSON.stringify(svc.status()).includes("SECRET123"));
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
  assert.deepEqual(svc.getModelParams(), { halfLifeDays: 300, priorMatches: 10, rhythmExponent: 0.5, levelFactor: 1 });
  assert.equal(svc.setModelParams({ halfLifeDays: 40, priorMatches: 60 }), true);
  const after = await svc.getLeagueData("PL");
  assert.notEqual(after, before);
  assert.notEqual(after.fit.teams.get("T0").a, before.fit.teams.get("T0").a);
  assert.equal(p.calls.length, calls, "les matchs déjà téléchargés sont réutilisés");
  assert.deepEqual(svc.getModelParams(), { halfLifeDays: 40, priorMatches: 60, rhythmExponent: 0.5, levelFactor: 1 });
});

test("réglages du modèle : seuls les réglages fournis et valides changent, sans changement rien n'est recalculé", async () => {
  const { cur, prev } = fixtureSeasons();
  const svc = service([fakeProvider("a", (l, year) => ({ matches: year === 2026 ? cur : prev, limited: false }))]);
  const first = await svc.getLeagueData("PL");
  assert.equal(svc.setModelParams({ halfLifeDays: 300, priorMatches: 10 }), false, "mêmes valeurs : aucun changement");
  assert.equal(svc.setModelParams({}), false);
  assert.equal(svc.setModelParams({ levelFactor: NaN, rhythmExponent: "0.5", halfLifeDays: undefined, priorMatches: null }), false, "valeurs illisibles ignorées");
  assert.equal(await svc.getLeagueData("PL"), first, "le calcul en mémoire est conservé");

  assert.equal(svc.setModelParams({ levelFactor: 1.04 }), true);
  assert.deepEqual(svc.getModelParams(), { halfLifeDays: 300, priorMatches: 10, rhythmExponent: 0.5, levelFactor: 1.04 }, "les autres réglages ne bougent pas");
  const second = await svc.getLeagueData("PL");
  assert.notEqual(second, first);
});

test("correction des totaux de buts : MODEL_CALIBRATION=off redonne exactement le modèle d'avant ; sinon rythme rapproché de la moyenne et niveau en service", async () => {
  const { cur, prev } = fixtureSeasons();
  const provider = () => fakeProvider("a", (l, year) => ({ matches: year === 2026 ? cur : prev, limited: false }));
  const on = service([provider()]);
  const off = service([provider()], { config: loadConfig({ FOOTBALL_DATA_API_KEY: "x", MODEL_CALIBRATION: "off" }) });
  assert.deepEqual(off.getModelParams(), { halfLifeDays: 300, priorMatches: 10, rhythmExponent: 1, levelFactor: 1 });

  const onData = await on.getLeagueData("PL");
  const offData = await off.getLeagueData("PL");
  const total = (fit, h, a) => {
    const { lh, la } = expectedGoals(fit, h, a);
    return lh + la;
  };
  const refit = (extra) => fitLeague(onData.finished, { now: NOW, halfLifeDays: 300, priorMatches: 10, ...extra });
  const pairs = [["T0", "T1"], ["T2", "T7"], ["T5", "T11"], ["T9", "T3"]];
  for (const [h, a] of pairs) {
    assert.ok(Math.abs(total(offData.fit, h, a) - total(refit({}), h, a)) < 1e-12, "interrupteur coupé : exactement le modèle d'avant");
    assert.ok(Math.abs(total(onData.fit, h, a) - total(refit({ rhythmExponent: 0.5 }), h, a)) < 1e-12, "correction du rythme en service");
  }
  const spread = (fit) => {
    const rhythms = [...fit.teams.values()].map((t) => t.a * t.d);
    return Math.max(...rhythms) - Math.min(...rhythms);
  };
  assert.ok(spread(onData.fit) < 0.6 * spread(offData.fit), `rythmes resserrés : ${spread(onData.fit)} contre ${spread(offData.fit)}`);

  // Le coefficient de niveau multiplie les buts attendus des deux équipes, et seulement eux.
  on.setModelParams({ levelFactor: 1.05 });
  const up = (await on.getLeagueData("PL")).fit;
  for (const [h, a] of pairs) assert.ok(Math.abs(total(up, h, a) / total(onData.fit, h, a) - 1.05) < 1e-9, `${h}-${a}`);
  assert.equal(up.home, onData.fit.home, "l'avantage du terrain ne change pas");
});

// ---- Noms alternatifs des clubs ----

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Source de test qui sait aussi lister les noms alternatifs : `names` = { idÉquipe: [noms…] }.
function providerWithNames(names, { fetchTeams, keys = ["PL"] } = {}) {
  const { cur, prev } = fixtureSeasons();
  const p = fakeProvider("fake", (l, year) => ({ matches: year === 2026 ? cur : prev, limited: false }), { keys });
  p.teamCalls = [];
  p.fetchTeams =
    fetchTeams ||
    (async (league) => {
      p.teamCalls.push(league.key);
      return Object.entries(names).map(([id, aliases]) => ({ id, name: `Equipe ${id}`, aliases }));
    });
  return p;
}

test("noms alternatifs : ils sont ajoutés aux équipes et comptés dans le status", async () => {
  const p = providerWithNames({ T0: ["Les Gunners", "GFC"], T3: ["Les Blues"], INCONNU: ["Personne"] });
  const svc = service([p]);
  const data = await svc.getLeagueData("PL");
  assert.deepEqual(data.teams.get("T0").aliases, ["Les Gunners", "GFC"]);
  assert.deepEqual(data.teams.get("T3").aliases, ["Les Blues"]);
  assert.deepEqual(data.teams.get("T1").aliases, [], "une équipe sans nom alternatif garde une liste vide");
  assert.equal(data.teams.size, 12, "un identifiant inconnu de la source de matchs n'ajoute aucune équipe");
  const pl = svc.status().championnats.find((c) => c.key === "PL");
  assert.equal(pl.equipes, 12);
  assert.equal(pl.equipesAvecNomsAlternatifs, 2);
});

test("noms alternatifs : un seul appel par championnat, même quand les forces d'équipes sont recalculées", async () => {
  const p = providerWithNames({ T0: ["Les Gunners"] });
  const svc = service([p]);
  await svc.getLeagueData("PL");
  svc.setModelParams({ halfLifeDays: 40, priorMatches: 60 });
  const again = await svc.getLeagueData("PL");
  assert.deepEqual(p.teamCalls, ["PL"]);
  assert.deepEqual(again.teams.get("T0").aliases, ["Les Gunners"], "les noms déjà reçus sont réutilisés");
});

test("noms alternatifs : une source qui n'en fournit pas, ou qui échoue, ne gêne jamais le chargement des matchs", async () => {
  const { cur, prev } = fixtureSeasons();
  const plain = fakeProvider("plain", (l, year) => ({ matches: year === 2026 ? cur : prev, limited: false }));
  const none = await service([plain]).getLeagueData("PL");
  assert.equal(none.teams.size, 12);
  assert.deepEqual(none.teams.get("T0").aliases, []);

  const failing = providerWithNames({}, {
    fetchTeams: async () => {
      throw Object.assign(new Error("HTTP 429"), { status: 429 });
    },
  });
  const svc = service([failing]);
  const data = await svc.getLeagueData("PL");
  assert.equal(data.teams.size, 12);
  assert.ok(data.fit.nMatches > 200);
  assert.equal(data.errors.length, 0, "pas d'alerte pour une information facultative");
  const pl = svc.status().championnats.find((c) => c.key === "PL");
  assert.equal(pl.etat, "pret");
  assert.equal(pl.equipesAvecNomsAlternatifs, 0);
});

test("noms alternatifs : un échec ou une réponse vide est redemandé au bout d'une heure, pas à chaque recalcul", async () => {
  const clock = { t: NOW };
  const answers = [[], [{ id: "T0", name: "Equipe T0", aliases: ["Les Gunners"] }]];
  let calls = 0;
  const p = providerWithNames({}, { fetchTeams: async () => answers[Math.min(calls++, answers.length - 1)] });
  const svc = createDataService({ config, http: null, cache: new SwrCache({ now: () => clock.t }), now: () => clock.t, log: quiet, providers: [p] });

  const first = await svc.getLeagueData("PL");
  assert.deepEqual(first.teams.get("T0").aliases, [], "réponse vide : aucun nom");
  svc.setModelParams({ halfLifeDays: 40, priorMatches: 60 });
  await svc.getLeagueData("PL");
  assert.equal(calls, 1, "pas de nouvel appel tout de suite");

  clock.t += 61 * 60000;
  svc.setModelParams({ halfLifeDays: 41, priorMatches: 60 });
  const later = await svc.getLeagueData("PL");
  assert.equal(calls, 2, "nouvel essai après une heure");
  assert.deepEqual(later.teams.get("T0").aliases, ["Les Gunners"]);
});

test("noms alternatifs : un appel trop lent ne retarde pas les matchs, les noms arrivent ensuite", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const p = providerWithNames({}, { fetchTeams: async () => (await gate, [{ id: "T0", name: "Equipe T0", aliases: ["Les Gunners"] }]) });
  const slowConfig = loadConfig({ FOOTBALL_DATA_API_KEY: "x" });
  slowConfig.cache.namesWaitMs = 30;
  const svc = createDataService({ config: slowConfig, http: null, cache: new SwrCache({ now: () => NOW }), now: () => NOW, log: quiet, providers: [p] });

  const started = Date.now();
  const data = await svc.getLeagueData("PL");
  assert.ok(Date.now() - started < 1500, "le chargement n'attend pas la liste des noms");
  assert.equal(data.teams.size, 12);
  assert.deepEqual(data.teams.get("T0").aliases, []);

  release();
  await wait(30);
  assert.deepEqual(data.teams.get("T0").aliases, ["Les Gunners"], "les noms s'ajoutent aux mêmes équipes dès qu'ils sont reçus");
  assert.equal(svc.status().championnats.find((c) => c.key === "PL").equipesAvecNomsAlternatifs, 1);
});

test("noms alternatifs : un appel qui ne répond jamais ne bloque pas non plus", async () => {
  const p = providerWithNames({}, { fetchTeams: () => new Promise(() => {}) });
  const slowConfig = loadConfig({ FOOTBALL_DATA_API_KEY: "x" });
  slowConfig.cache.namesWaitMs = 30;
  const svc = createDataService({ config: slowConfig, http: null, cache: new SwrCache({ now: () => NOW }), now: () => NOW, log: quiet, providers: [p] });
  const data = await svc.getLeagueData("PL");
  assert.equal(data.teams.size, 12);
  assert.ok(data.fit.nMatches > 200);
});

// ---- Championnats complémentaires, coupes d'Europe et annuaire des clubs ----

// Petit championnat (ou coupe) fait main : `clubs` = [{ id, name }], chacun reçoit chacun, scores variés. Tous les matchs sont joués
// dans la saison en cours (sauf `at`, date de départ choisie pour contrôler le « dernier match » de chaque club).
function mini(clubs, { at = JULY + 20 * DAY, upcoming = [] } = {}) {
  const matches = [];
  let k = 0;
  for (const h of clubs) {
    for (const g of clubs) {
      if (h === g) continue;
      matches.push({ id: `${h.id}>${g.id}`, kickoff: at + k++ * 3600000, status: "finished", hg: (k * 7) % 4, ag: (k * 5) % 3, home: { id: h.id, name: h.name }, away: { id: g.id, name: g.name } });
    }
  }
  upcoming.forEach(([h, g], i) => matches.push({ id: `${h.id}>${g.id}#a`, kickoff: NOW + (i + 1) * DAY, status: "scheduled", hg: null, ag: null, home: { id: h.id, name: h.name }, away: { id: g.id, name: g.name } }));
  return matches;
}
const club = (id, name) => ({ id, name });
// Source de test : `world[clé de championnat]` = matchs de la saison en cours (la saison précédente est vide).
const worldProvider = (world, { keys = Object.keys(world) } = {}) => fakeProvider("fake", (l, year) => ({ matches: year === 2026 ? world[l.key] || [] : [], limited: false }), { keys });
const loadedKeys = (p) => [...new Set(p.calls.map((c) => c.league))].sort();

test("lots de chargement : championnats principaux par défaut, puis coupes, complémentaires, essentiel, tout", async () => {
  const world = { PL: mini([club("a", "A"), club("b", "B"), club("c", "C")]), SA: mini([club("d", "D"), club("e", "E"), club("f", "F")]), UCL: mini([club("a", "A"), club("d", "D"), club("x", "X")]), UEL: mini([club("b", "B"), club("e", "E"), club("y", "Y")]), ELC: mini([club("g", "G"), club("h", "H"), club("i", "I")]), TSL: mini([club("j", "J"), club("k", "K"), club("l", "L")]) };
  const run = async (opts) => {
    const p = worldProvider(world);
    const svc = service([p]);
    const r = await svc.ensureAll({ budgetMs: 1000, ...opts });
    return { loaded: loadedKeys(p), ready: r.ready.map((d) => d.league.key) };
  };
  assert.deepEqual((await run({})).loaded, ["PL", "SA"], "par défaut : championnats principaux, sans les coupes");
  assert.deepEqual((await run({ scope: "core" })).loaded, ["PL", "SA"]);
  assert.deepEqual((await run({ scope: "cups" })).loaded, ["UCL", "UEL"]);
  assert.deepEqual((await run({ scope: "extras" })).loaded, ["ELC", "TSL"]);
  assert.deepEqual((await run({ scope: "essential" })).loaded, ["PL", "SA", "UCL", "UEL"]);
  assert.deepEqual((await run({ scope: "all" })).loaded, ["ELC", "PL", "SA", "TSL", "UCL", "UEL"]);
  assert.deepEqual((await run({ keys: ["TSL"] })).loaded, ["TSL"], "des championnats précis, quel que soit leur lot");
  assert.deepEqual((await run({ keys: ["UCL", "PL"], scope: "extras" })).ready, ["PL", "UCL"], "les clés précisées l'emportent sur le lot");
});

test("interrupteurs : EUROPE_ENABLED=off retire les coupes, EXTRA_LEAGUES_ENABLED=off retire les championnats complémentaires", () => {
  const keys = ["PL", "SA", "UCL", "UEL", "UECL", "ELC", "TSL", "BL2"];
  const make = (env) => service([worldProvider({}, { keys })], { config: loadConfig({ FOOTBALL_DATA_API_KEY: "x", ...env }) }).leagues.map((l) => l.key);
  assert.deepEqual(make({}), ["PL", "SA", "UCL", "UEL", "UECL", "ELC", "BL2", "TSL"]);
  assert.deepEqual(make({ EUROPE_ENABLED: "off" }), ["PL", "SA", "ELC", "BL2", "TSL"]);
  assert.deepEqual(make({ EXTRA_LEAGUES_ENABLED: "off" }), ["PL", "SA", "UCL", "UEL", "UECL"]);
  assert.deepEqual(make({ EUROPE_ENABLED: "off", EXTRA_LEAGUES_ENABLED: "off" }), ["PL", "SA"]);
  // une source qui ne couvre pas un championnat ne le rend pas disponible, interrupteur ou non
  assert.deepEqual(service([worldProvider({}, { keys: ["PL", "UCL"] })]).leagues.map((l) => l.key), ["PL", "UCL"]);
});

test("status : chaque entrée dit si c'est un championnat ou une coupe, principal ou complémentaire", async () => {
  const svc = service([worldProvider({ PL: mini([club("a", "A"), club("b", "B")]), UCL: mini([club("a", "A"), club("x", "X")]), ELC: mini([club("g", "G"), club("h", "H")]) })]);
  const rows = Object.fromEntries(svc.status().championnats.map((c) => [c.key, c]));
  assert.deepEqual([rows.PL.type, rows.PL.niveau], ["championnat", "principal"]);
  assert.deepEqual([rows.UCL.type, rows.UCL.niveau], ["coupe", "principal"]);
  assert.deepEqual([rows.ELC.type, rows.ELC.niveau], ["championnat", "complementaire"]);
  assert.equal(rows.UEL.etat, "non_couvert");
  assert.equal(svc.status().championnats.length, require("../src/leagues").LEAGUES.length);
});

test("peekLeague : rien avant le chargement, les données ensuite, et ne déclenche jamais de chargement", async () => {
  const p = worldProvider({ PL: mini([club("a", "A"), club("b", "B")]) });
  const svc = service([p]);
  assert.equal(svc.peekLeague("PL"), null);
  assert.equal(svc.peekLeague("inconnu"), null);
  assert.equal(p.calls.length, 0, "aucun appel à la source");
  const loaded = await svc.getLeagueData("PL");
  assert.equal(svc.peekLeague("PL"), loaded);
});

test("une coupe ne reçoit pas de force de championnat : ses clubs sont notés « sans force », ceux d'un championnat « avec »", async () => {
  const p = worldProvider({ PL: mini([club("a", "Arsenal"), club("b", "Chelsea")]), UCL: mini([club("a", "Arsenal"), club("x", "Slavia")]) });
  const svc = service([p]);
  const pl = await svc.getLeagueData("PL");
  const ucl = await svc.getLeagueData("UCL");
  assert.ok(pl.fit && pl.fit.teams.get("a"));
  assert.equal(ucl.fit, null);
  assert.ok([...pl.teams.values()].every((t) => t.rated === true && t.leagueKey === "PL" && t.lastSeen > 0));
  assert.ok([...ucl.teams.values()].every((t) => t.rated === false && t.leagueKey === "UCL"));
  assert.equal(ucl.league.kind, "cup");
  assert.ok(ucl.finished.length > 0);
});

test("annuaire : un club relégué ou promu est dans le championnat où il a joué en dernier, et une seule fois", async () => {
  // « Descendu » jouait en Premier League la saison précédente (matchs anciens) et joue maintenant en Championship ; « Monté » l'inverse.
  const old = JULY - 200 * DAY;
  const descendu = club("PL:descendu", "Club Descendu");
  const monte = club("ELC:monte", "Club Monté");
  const plBase = [club("PL:1", "Un"), club("PL:2", "Deux"), club("PL:3", "Trois")];
  const elcBase = [club("ELC:1", "Quatre"), club("ELC:2", "Cinq"), club("ELC:3", "Six")];
  const world = {
    PL: [...mini([...plBase, monte]), ...mini([descendu, plBase[0]], { at: old })], // « Monté » joue en PL cette saison, « Descendu » seulement avant
    ELC: [...mini([...elcBase, descendu]), ...mini([monte, elcBase[0]], { at: old })],
  };
  const svc = service([worldProvider(world)]);
  await svc.ensureAll({ budgetMs: 1000, scope: "all" });
  const teams = svc.allTeams();
  const ids = teams.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "aucun club en double");
  assert.equal(teams.find((t) => t.id === "PL:descendu").leagueKey, "ELC");
  assert.equal(teams.find((t) => t.id === "ELC:monte").leagueKey, "PL");
  assert.equal(teams.length, 8);
  assert.ok(teams.every((t) => t.rated));
});

test("annuaire : à dernier match égal, le championnat listé en premier garde le club", async () => {
  const shared = club("same", "Club Commun");
  const world = { PL: mini([club("PL:1", "Un"), club("PL:2", "Deux"), shared]), ELC: mini([club("ELC:1", "Trois"), club("ELC:2", "Quatre"), shared]) };
  const teams = (await (async () => {
    const svc = service([worldProvider(world)]);
    await svc.ensureAll({ budgetMs: 1000, scope: "all" });
    return svc.allTeams();
  })());
  assert.equal(teams.filter((t) => t.id === "same").length, 1);
  assert.equal(teams.find((t) => t.id === "same").leagueKey, "PL");
});

test("annuaire : le club d'une coupe qui est aussi dans un championnat suivi n'est compté qu'une fois ; les autres forment le groupe « européen »", async () => {
  const world = {
    PL: mini([club("PL:ars", "Arsenal FC"), club("PL:che", "Chelsea FC"), club("PL:liv", "Liverpool FC")]),
    UCL: mini([club("c-ars", "Arsenal"), club("c-che", "Chelsea FC"), club("c-sla", "Slavia Praha"), club("c-red", "Red Star Belgrade")]),
  };
  const svc = service([worldProvider(world)]);
  await svc.ensureAll({ budgetMs: 1000, scope: "essential" });
  const teams = svc.allTeams();
  assert.equal(teams.length, 5, "3 clubs de championnat + 2 clubs de coupe seulement");
  const lonely = teams.filter((t) => !t.rated);
  assert.deepEqual(lonely.map((t) => t.name).sort(), ["Red Star Belgrade", "Slavia Praha"]);
  assert.ok(lonely.every((t) => t.leagueKey === "EUR" && t.aliases.length === 0));
  const alias = svc.teamAliasMap();
  assert.equal(alias.get("c-ars"), "PL:ars");
  assert.equal(alias.get("c-che"), "PL:che");
  assert.equal(alias.has("c-sla"), false);
  assert.equal(alias.size, 2);
  // sans la coupe chargée, rien n'est ajouté
  const noCup = service([worldProvider(world)]);
  await noCup.ensureAll({ budgetMs: 1000 });
  assert.equal(noCup.allTeams().length, 3);
  assert.equal(noCup.teamAliasMap().size, 0);
});

test("annuaire : un nom de coupe qui conviendrait à deux clubs de championnat n'est rattaché à aucun des deux", async () => {
  const world = {
    PL: mini([club("PL:dyn", "Dynamo FC"), club("PL:two", "Deux"), club("PL:tre", "Trois")]),
    SA: mini([club("SA:dyn", "Dynamo"), club("SA:qua", "Quatre"), club("SA:cin", "Cinq")]),
    UCL: mini([club("c-dyn", "Dynamo"), club("c-x", "Autre Club"), club("PL:two", "Deux")]),
  };
  const svc = service([worldProvider(world)]);
  await svc.ensureAll({ budgetMs: 1000, scope: "all" });
  assert.equal(svc.teamAliasMap().has("c-dyn"), false, "ambigu : pas de rattachement au hasard");
  const lonely = svc.allTeams().filter((t) => !t.rated).map((t) => t.name).sort();
  assert.deepEqual(lonely, ["Autre Club", "Dynamo"]);
  // un identifiant déjà connu comme club de championnat reste ce club, sans doublon
  assert.equal(svc.allTeams().filter((t) => t.id === "PL:two").length, 1);
});

test("annuaire : mémorisé tant que les données ne changent pas, recalculé quand un championnat est rechargé", async () => {
  const p = worldProvider({ PL: mini([club("a", "A"), club("b", "B")]), SA: mini([club("c", "C"), club("d", "D")]) });
  const svc = service([p]);
  await svc.ensureAll({ budgetMs: 1000 });
  const first = svc.allTeams();
  assert.equal(svc.allTeams(), first);
  svc.setModelParams({ halfLifeDays: 77, priorMatches: 11 }); // invalide les championnats en mémoire
  await svc.ensureAll({ budgetMs: 1000 });
  const second = svc.allTeams();
  assert.notEqual(second, first);
  assert.equal(second.length, first.length);
});

test("allFailed ne tient compte que des championnats essentiels : les complémentaires peuvent manquer sans que le service soit « en panne »", async () => {
  const handler = (down) => (l) => {
    if (down.includes(l.key)) throw new Error("source en panne");
    return { matches: mini([club(`${l.key}:1`, "Un"), club(`${l.key}:2`, "Deux"), club(`${l.key}:3`, "Trois")]), limited: false };
  };
  const keys = ["PL", "SA", "UCL", "ELC", "TSL"];
  const extrasDown = service([fakeProvider("a", handler(["ELC", "TSL"]), { keys })]);
  await extrasDown.ensureAll({ budgetMs: 1000, scope: "all" });
  assert.equal(extrasDown.allFailed(), false);
  assert.deepEqual(extrasDown.unloadedLeagues(), [
    { key: "ELC", nom: "Championship", lot: "extra", etat: "echec" },
    { key: "TSL", nom: "Süper Lig", lot: "extra", etat: "echec" },
  ]);
  const coreDown = service([fakeProvider("a", handler(["PL", "SA", "UCL"]), { keys })]);
  await coreDown.ensureAll({ budgetMs: 1000, scope: "all" });
  assert.equal(coreDown.allFailed(), true, "plus aucun championnat essentiel, même si des complémentaires sont chargés");
  assert.deepEqual(coreDown.unloadedLeagues().map((l) => [l.key, l.lot]), [["PL", "core"], ["SA", "core"], ["UCL", "core"]]);
});

test("démarrage par étapes : l'essentiel (championnats principaux et coupes) est prêt avant les championnats complémentaires", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const world = { PL: mini([club("a", "A"), club("b", "B")]), UCL: mini([club("a", "A"), club("x", "X")]), ELC: mini([club("g", "G"), club("h", "H")]) };
  const order = [];
  const p = fakeProvider("fake", async (l, year) => {
    if (l.tier === "extra") await gate; // les championnats complémentaires sont lents
    order.push(l.key);
    return { matches: year === 2026 ? world[l.key] : [], limited: false };
  }, { keys: ["PL", "UCL", "ELC"] });
  const quietLog = { log() {}, warn() {}, error() {} };
  const svc = service([p], { log: quietLog });
  const { ready, extras, timer } = svc.warmUp();
  try {
    const r = await ready;
    assert.deepEqual(r.ready.map((d) => d.league.key).sort(), ["PL", "UCL"]);
    assert.equal(svc.peekLeague("ELC"), null, "les championnats complémentaires ne sont pas encore là");
    assert.equal(svc.allFailed(), false);
    assert.deepEqual(svc.unloadedLeagues().map((l) => [l.key, l.etat]), [["ELC", "chargement"]]);
    release();
    const e = await extras;
    assert.deepEqual(e.ready.map((d) => d.league.key), ["ELC"]);
    assert.ok(svc.peekLeague("ELC"));
    assert.deepEqual(svc.unloadedLeagues(), []);
    assert.ok(order.indexOf("ELC") > order.indexOf("PL"));
  } finally {
    clearInterval(timer);
    release();
  }
});

test("démarrage : sans championnat complémentaire (interrupteur coupé), l'étape en arrière-plan est vide et ne gêne pas", async () => {
  const p = worldProvider({ PL: mini([club("a", "A"), club("b", "B")]), ELC: mini([club("g", "G"), club("h", "H")]) });
  const svc = service([p], { config: loadConfig({ FOOTBALL_DATA_API_KEY: "x", EXTRA_LEAGUES_ENABLED: "off" }), log: quiet });
  const { ready, extras, timer } = svc.warmUp();
  try {
    assert.deepEqual((await ready).ready.map((d) => d.league.key), ["PL"]);
    assert.equal(await extras, null);
    assert.deepEqual(loadedKeys(p), ["PL"]);
  } finally {
    clearInterval(timer);
  }
});
