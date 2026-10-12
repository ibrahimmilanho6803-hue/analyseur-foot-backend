"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateStatus, controle, parseArgs, DEFAULT_URL } = require("../scripts/controle-sante");

// État tel que le renvoie /api/status quand tout va bien (extrait réduit d'une vraie réponse de production).
const league = (key, nom, extra = {}) => ({ key, nom, pays: "X", couvert: true, etat: "pret", charge: true, equipes: 20, matchsJoues: 400, ageMinutes: 7, alertes: [], derniereErreur: null, ...extra });
const healthy = () => ({
  heure: "2026-10-12T08:11:59.421Z",
  ia: { active: true, modele: "claude-sonnet-5-5", appelsAujourdhui: 4, budgetJournalier: 400, pauseJusquA: null, derniereErreur: null, dernierSucces: "2026-10-12T08:02:00.048Z" },
  donnees: { sources: ["TheSportsDB"], championnats: [league("PL", "Premier League"), league("PD", "Liga"), { key: "XX", nom: "Hors offre", couvert: false, etat: "non_couvert" }] },
  avertissements: [],
});

test("état sain : aucun problème, aucune remarque", () => {
  const r = evaluateStatus(healthy());
  assert.deepEqual(r, { problems: [], notes: [] });
});

test("réponse illisible ou vide : un problème clair", () => {
  for (const bad of [null, undefined, "texte", [], 42]) assert.equal(evaluateStatus(bad).problems.length, 1);
});

test("les avertissements du serveur sont des problèmes, repris tels quels", () => {
  const st = healthy();
  st.avertissements = ["Chargement impossible (Liga) : HTTP 429", "Chargement en cours : 2 championnat(s) pas encore prêt(s)."];
  const { problems } = evaluateStatus(st);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /Liga.*HTTP 429/);
});

test("IA inactive ou en pause : signalé avec la cause", () => {
  const off = healthy();
  off.ia.active = false;
  assert.match(evaluateStatus(off).problems[0], /IA est inactive/);
  const paused = healthy();
  paused.ia.pauseJusquA = "2026-10-12T08:21:59.000Z";
  paused.ia.derniereErreur = { code: "UNAVAILABLE", message: "L'IA est momentanément indisponible.", le: "2026-10-12T08:11:00.000Z" };
  const p = evaluateStatus(paused).problems;
  assert.equal(p.length, 1);
  assert.match(p[0], /en pause jusqu'à 2026-10-12T08:21:59.000Z.*UNAVAILABLE/);
});

test("clé refusée, crédit épuisé ou modèle introuvable : signalé tant qu'aucun appel n'a réussi depuis", () => {
  for (const [code, indice] of [["AUTH", /ANTHROPIC_API_KEY/], ["BILLING", /crédit/], ["MODEL", /ANTHROPIC_MODEL/]]) {
    const st = healthy();
    st.ia.derniereErreur = { code, message: "m", le: "2026-10-12T08:05:00.000Z" };
    st.ia.dernierSucces = "2026-10-12T07:00:00.000Z"; // avant l'erreur
    const { problems } = evaluateStatus(st);
    assert.equal(problems.length, 1, code);
    assert.match(problems[0], indice);
    // Un succès plus récent que l'erreur : réparé, plus de problème.
    st.ia.dernierSucces = "2026-10-12T08:06:00.000Z";
    assert.deepEqual(evaluateStatus(st).problems, [], `${code} résolu`);
  }
  // Une erreur passagère (délai dépassé…) ne déclenche rien par elle-même.
  const passager = healthy();
  passager.ia.derniereErreur = { code: "TIMEOUT", message: "m", le: "2026-10-12T08:11:00.000Z" };
  assert.deepEqual(evaluateStatus(passager).problems, []);
});

test("budget IA : remarque à 80 %, problème une fois épuisé, ignoré s'il n'y a pas de plafond", () => {
  const st = healthy();
  st.ia.appelsAujourdhui = 330;
  assert.deepEqual(evaluateStatus(st), { problems: [], notes: ["Budget d'appels à l'IA consommé à 83 % (330/400)."] });
  st.ia.appelsAujourdhui = 400;
  assert.match(evaluateStatus(st).problems[0], /Budget quotidien.*400\/400/);
  st.ia.budgetJournalier = 0;
  assert.deepEqual(evaluateStatus(st), { problems: [], notes: [] });
});

test("données : aucun championnat, aucun prêt, ou données qui ne se rafraîchissent plus", () => {
  const none = healthy();
  none.donnees.championnats = [];
  assert.match(evaluateStatus(none).problems[0], /Aucun championnat suivi/);
  const notReady = healthy();
  notReady.donnees.championnats = [league("PL", "Premier League", { etat: "chargement", charge: false, ageMinutes: null })];
  assert.match(evaluateStatus(notReady).problems[0], /Aucun championnat n'est chargé/);
  const old = healthy();
  old.donnees.championnats[1] = league("PD", "Liga", { ageMinutes: 600 });
  const p = evaluateStatus(old).problems;
  assert.equal(p.length, 1);
  assert.match(p[0], /Liga : données vieilles de 10 h/);
});

// ---- Exécution complète contre un faux serveur ----
function fakeServer(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = url.replace("https://api.test", "");
    calls.push({ path, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null, signal: init.signal });
    const handler = routes[path];
    if (!handler) return { status: 404, json: async () => ({}) };
    const out = typeof handler === "function" ? handler(calls.length, init) : handler;
    if (out instanceof Error) throw out;
    return { status: out.status || 200, json: async () => out.body };
  };
  return { fetchImpl, calls };
}

const TEAMS = {
  complet: true,
  championnats: [{ key: "PL", charge: true }, { key: "PD", charge: true }],
  equipes: [
    { nom: "Arsenal FC", championnat: "PL", noms: [] },
    { nom: "Aston Villa FC", championnat: "PL", noms: [] },
    { nom: "Real Madrid CF", championnat: "PD", noms: [] },
  ],
};
const okRoutes = () => ({
  "/health": { body: { ok: true } },
  "/api/status": { body: healthy() },
  "/api/teams": { body: TEAMS },
  "/api/analyze": { body: { etat: "ok", probabilite: 11.2, ia: { statut: "non_applicable" } } },
});
const noSleep = async () => {};

test("contrôle complet réussi : une analyse d'essai sans IA est faite sur deux clubs du même championnat", async () => {
  const s = fakeServer(okRoutes());
  const r = await controle({ base: "https://api.test/", fetchImpl: s.fetchImpl, sleepImpl: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.essais, 1);
  const analyze = s.calls.find((c) => c.path === "/api/analyze");
  assert.deepEqual(analyze.body, { equipe1: "Arsenal FC", equipe2: "Aston Villa FC", typePari: "Score exact", ia: false });
  assert.equal(analyze.method, "POST");
  assert.ok(analyze.signal, "un délai maximal est posé sur chaque requête");
});

test("--sans-test : aucune analyse d'essai", async () => {
  const s = fakeServer(okRoutes());
  const r = await controle({ base: "https://api.test", fetchImpl: s.fetchImpl, sleepImpl: noSleep, smoke: false });
  assert.equal(r.ok, true);
  assert.deepEqual(s.calls.map((c) => c.path), ["/health", "/api/status"]);
});

test("serveur injoignable : trois essais espacés, puis un problème clair (sans autre requête)", async () => {
  const s = fakeServer({ "/health": () => new Error("fetch failed") });
  const sleeps = [];
  const logs = [];
  const r = await controle({ base: "https://api.test", fetchImpl: s.fetchImpl, sleepImpl: async (ms) => sleeps.push(ms), delayMs: 60000, log: (m) => logs.push(m) });
  assert.equal(r.ok, false);
  assert.equal(r.essais, 3);
  assert.deepEqual(sleeps, [60000, 60000]);
  assert.match(r.problems[0], /ne répond pas \(fetch failed\)/);
  assert.equal(s.calls.length, 3, "seul /health est essayé tant que le serveur ne répond pas");
  assert.equal(logs.length, 2);
});

test("redémarrage du serveur : un chargement en cours au premier essai n'est pas une alerte s'il est réglé au suivant", async () => {
  const loading = healthy();
  loading.avertissements = ["Chargement en cours : 4 championnat(s) pas encore prêt(s)."];
  const s = fakeServer({ ...okRoutes(), "/api/status": (n) => ({ body: n <= 3 ? loading : healthy() }) });
  const sleeps = [];
  const r = await controle({ base: "https://api.test", fetchImpl: s.fetchImpl, sleepImpl: async (ms) => sleeps.push(ms) });
  assert.equal(r.ok, true);
  assert.equal(r.essais, 2);
  assert.equal(sleeps.length, 1);
});

test("HTTP 500 sur /health ou /api/status : problème signalé", async () => {
  const a = await controle({ base: "https://api.test", fetchImpl: fakeServer({ "/health": { status: 502, body: {} } }).fetchImpl, sleepImpl: noSleep, attempts: 1 });
  assert.match(a.problems[0], /\/health : HTTP 502/);
  const b = await controle({ base: "https://api.test", fetchImpl: fakeServer({ ...okRoutes(), "/api/status": { status: 500, body: {} } }).fetchImpl, sleepImpl: noSleep, attempts: 1, smoke: false });
  assert.match(b.problems[0], /\/api\/status répond HTTP 500/);
});

test("l'analyse d'essai échoue : club non reconnu, erreur serveur ou liste de clubs vide", async () => {
  const unknown = await controle({ base: "https://api.test", fetchImpl: fakeServer({ ...okRoutes(), "/api/analyze": { body: { etat: "equipe_inconnue", probabilite: null } } }).fetchImpl, sleepImpl: noSleep, attempts: 1 });
  assert.match(unknown.problems[0], /Arsenal FC – Aston Villa FC.*equipe_inconnue/);
  const error = await controle({ base: "https://api.test", fetchImpl: fakeServer({ ...okRoutes(), "/api/analyze": { status: 500, body: { error: "x" } } }).fetchImpl, sleepImpl: noSleep, attempts: 1 });
  assert.match(error.problems[0], /répond HTTP 500/);
  const noTeams = await controle({ base: "https://api.test", fetchImpl: fakeServer({ ...okRoutes(), "/api/teams": { body: { complet: false, championnats: [], equipes: [] } } }).fetchImpl, sleepImpl: noSleep, attempts: 1 });
  assert.match(noTeams.problems[0], /Aucune paire de clubs/);
});

test("les remarques (budget presque épuisé) sont renvoyées même quand tout va bien", async () => {
  const st = healthy();
  st.ia.appelsAujourdhui = 350;
  const r = await controle({ base: "https://api.test", fetchImpl: fakeServer({ ...okRoutes(), "/api/status": { body: st } }).fetchImpl, sleepImpl: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.notes.length, 1);
});

test("arguments de la ligne de commande", () => {
  assert.deepEqual(parseArgs([], {}), { base: DEFAULT_URL, smoke: true, attempts: 3, delayMs: 60000 });
  assert.equal(parseArgs([], { API_URL: "https://autre.test" }).base, "https://autre.test");
  const o = parseArgs(["https://x.test", "--sans-test", "--essais=5", "--attente=10"], {});
  assert.deepEqual(o, { base: "https://x.test", smoke: false, attempts: 5, delayMs: 10000 });
  assert.equal(parseArgs(["--essais=99"], {}).attempts, 10, "borné");
  assert.equal(parseArgs(["--essais=0"], {}).attempts, 1, "au moins un essai");
  assert.equal(parseArgs(["--attente=9999"], {}).delayMs, 600000, "borné");
});
