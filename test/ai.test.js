"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAi, buildPrompt, buildBody, parseReview, SCHEMA, API_URL } = require("../src/ai");
const { createHttp, HttpError } = require("../src/http");
const { loadConfig } = require("../src/config");

const quiet = { log() {}, warn() {}, error() {} };

const CTX = {
  home: "Arsenal FC",
  away: "Chelsea FC",
  competition: "Premier League",
  kickoff: Date.UTC(2026, 9, 12, 14),
  bet: { label: "Victoire ou nul domicile", p: 0.81 },
  lh: 1.84,
  la: 1.02,
  outcomes: { home: 0.52, draw: 0.25, away: 0.23, over25: 0.55, btts: 0.5 },
  quality: { level: 2, nHome: 30, nAway: 29 },
  stats: {
    statsEquipe1: { forme: "VVNDV" },
    statsEquipe2: { forme: "DNVDD" },
    homeAway1: { home: { played: 10, won: 7, draw: 2, lost: 1, avgGoalsFor: 2.1, avgGoalsAgainst: 0.8 } },
    homeAway2: { away: { played: 10, won: 3, draw: 3, lost: 4, avgGoalsFor: 1.1, avgGoalsAgainst: 1.6 } },
    h2h: { matches: [{ homeTeam: "Arsenal FC", score: "2-1", awayTeam: "Chelsea FC" }], bilan: { homeWins: 1, draws: 0, awayWins: 0 } },
  },
};

const GOOD = { ajustement_points: 1.5, confiance: "eleve", justification: "Arsenal est solide à domicile et Chelsea concède beaucoup en déplacement.", vigilance: "" };
const reply = (obj, extra = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  stop_reason: "end_turn",
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }],
  usage: { input_tokens: 500, output_tokens: 90 },
  ...extra,
});
const apiError = (status, detail = "", code = "HTTP") => new HttpError(`HTTP ${status}`, { status, code, detail, url: API_URL });

// Faux client HTTP : chaque appel consomme une étape (réponse ou erreur).
function fakeHttp(steps) {
  const calls = [];
  return {
    calls,
    postJson: async (url, body, opts) => {
      calls.push({ url, body, opts });
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      const out = typeof step === "function" ? step(body, calls.length) : step;
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

function makeAi(steps, env = {}, clock = { t: Date.UTC(2026, 9, 8, 12) }) {
  const config = loadConfig({ ANTHROPIC_API_KEY: "sk-ant-test-key", ...env });
  const http = fakeHttp(steps);
  const ai = createAi({ config, http, now: () => clock.t, log: quiet });
  return { ai, http, clock };
}

test("le texte envoyé à l'IA contient les chiffres utiles et seulement eux", () => {
  const p = buildPrompt(CTX);
  for (const needle of ["Arsenal FC (domicile) contre Chelsea FC (extérieur)", "Premier League", "2026-10-12", "Victoire ou nul domicile", "81 %", "1.84", "VVNDV", "Confrontations directes", "Quantité de données : bonne"]) {
    assert.ok(p.includes(needle), `manque : ${needle}\n${p}`);
  }
  // Données absentes : pas de ligne vide ni « undefined ».
  const minimal = buildPrompt({ home: "A", away: "B", bet: { label: "Match nul", p: 0.3 }, lh: 1, la: 1 });
  assert.ok(!/undefined|NaN|null/.test(minimal), minimal);
});

test("forme de requête principale : Sonnet 5.5, sortie structurée, réflexion minimale, aucun paramètre refusé", () => {
  const b = buildBody(0, { model: "claude-sonnet-5-5", effort: "medium", maxTokens: 700, user: "x" });
  assert.equal(b.model, "claude-sonnet-5-5");
  assert.deepEqual(b.thinking, { type: "between_tools" });
  assert.equal(b.output_config.effort, "medium");
  assert.equal(b.output_config.format.type, "json_schema");
  assert.equal(b.output_config.format.schema, SCHEMA);
  for (const forbidden of ["temperature", "top_p", "top_k", "tool_choice", "output_format"]) assert.ok(!(forbidden in b), forbidden);
  assert.notEqual(b.thinking.type, "disabled");
  assert.equal(b.messages[b.messages.length - 1].role, "user", "pas de préremplissage de la réponse");
});

test("le schéma respecte les limites des sorties structurées", () => {
  const walk = (node) => {
    if (node && typeof node === "object") {
      if (node.type === "object") assert.equal(node.additionalProperties, false);
      for (const bad of ["minimum", "maximum", "minLength", "maxLength", "pattern"]) assert.ok(!(bad in node), `mot-clé non pris en charge : ${bad}`);
      Object.values(node).forEach(walk);
    }
  };
  walk(SCHEMA);
  assert.deepEqual([...SCHEMA.required].sort(), Object.keys(SCHEMA.properties).sort());
});

test("formes de repli : sans réflexion imposée, puis sans sortie structurée", () => {
  const a = buildBody(1, { model: "m", effort: "medium", maxTokens: 700, user: "x" });
  assert.ok(!a.thinking && a.output_config.format && !a.output_config.effort);
  assert.equal(a.max_tokens, 2100);
  const b = buildBody(2, { model: "m", effort: "medium", maxTokens: 700, user: "x" });
  assert.ok(!b.thinking && !b.output_config);
  assert.match(b.messages[0].content, /objet JSON/);
});

test("parseReview : bornes, formats tolérés et rejet des réponses inutilisables", () => {
  assert.equal(parseReview(JSON.stringify({ ...GOOD, ajustement_points: 9 }), 4).adjustment, 4);
  assert.equal(parseReview(JSON.stringify({ ...GOOD, ajustement_points: -7.2 }), 4).adjustment, -4);
  assert.equal(parseReview(JSON.stringify({ ...GOOD, ajustement_points: "2,5" }), 4).adjustment, 2.5);
  assert.equal(parseReview(JSON.stringify({ ...GOOD, ajustement_points: "beaucoup" }), 4).adjustment, 0);
  assert.equal(parseReview(JSON.stringify({ ...GOOD, confiance: "Élevé" }), 4).confiance, "eleve");
  assert.equal(parseReview(JSON.stringify({ ...GOOD, confiance: "certain" }), 4).confiance, null);
  assert.equal(parseReview("Voici : " + JSON.stringify(GOOD) + " fin", 4).justification, GOOD.justification);
  assert.equal(parseReview("```json\n" + JSON.stringify(GOOD) + "\n```", 4).adjustment, 1.5);
  assert.equal(parseReview(JSON.stringify({ ...GOOD, justification: "  " }), 4), null);
  assert.equal(parseReview("pas du json", 4), null);
  assert.equal(parseReview("[1,2]", 4), null);
  assert.equal(parseReview(JSON.stringify({ ...GOOD, justification: "x".repeat(900) }), 4).justification.length, 400);
});

test("succès : lit le bloc texte même précédé d'un bloc de réflexion", async () => {
  const { ai, http } = makeAi([
    reply(GOOD, { content: [{ type: "thinking", thinking: "", signature: "abc" }, { type: "text", text: JSON.stringify(GOOD) }] }),
  ]);
  const r = await ai.review(CTX);
  assert.equal(r.ok, true);
  assert.equal(r.adjustment, 1.5);
  assert.equal(r.confiance, "eleve");
  assert.equal(r.variant, 0);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, API_URL);
  assert.equal(http.calls[0].opts.headers["x-api-key"], "sk-ant-test-key");
  assert.equal(http.calls[0].opts.headers["anthropic-version"], "2023-06-01");
  assert.equal(http.calls[0].body.model, "claude-sonnet-5-5");
  assert.equal(ai.status().modele, "claude-sonnet-5-5");
});

test("le modèle peut être changé par variable d'environnement (retour arrière possible)", async () => {
  const { ai, http } = makeAi([reply(GOOD)], { ANTHROPIC_MODEL: "claude-sonnet-5" });
  await ai.review(CTX);
  assert.equal(http.calls[0].body.model, "claude-sonnet-5");
});

test("400 : bascule vers une forme plus simple puis mémorise celle qui marche", async () => {
  const { ai, http } = makeAi([
    (body) => (body.thinking ? apiError(400, "thinking: not supported") : reply(GOOD)),
  ]);
  const first = await ai.review(CTX);
  assert.equal(first.ok, true);
  assert.equal(first.variant, 1);
  assert.equal(http.calls.length, 2);
  await ai.review(CTX);
  assert.equal(http.calls.length, 3, "l'appel suivant part directement de la forme qui fonctionne");
  assert.ok(!http.calls[2].body.thinking);
  assert.equal(ai.status().formeDeRequete, 1);
});

test("400 sur les deux premières formes : dernière forme sans sortie structurée", async () => {
  const { ai, http } = makeAi([(body) => (body.output_config ? apiError(400, "output_config not supported") : reply(GOOD))]);
  const r = await ai.review(CTX);
  assert.equal(r.ok, true);
  assert.equal(r.variant, 2);
  assert.equal(http.calls.length, 3);
});

test("400 partout : échec clair, sans boucle", async () => {
  const { ai, http } = makeAi([apiError(400, "invalid_request_error")]);
  const r = await ai.review(CTX);
  assert.equal(r.ok, false);
  assert.equal(r.code, "REQUEST");
  assert.equal(http.calls.length, 3);
});

test("crédit épuisé et modèle introuvable sont signalés précisément", async () => {
  const billing = makeAi([apiError(400, "Your credit balance is too low to access the Anthropic API")]);
  assert.equal((await billing.ai.review(CTX)).code, "BILLING");
  assert.equal(billing.http.calls.length, 1, "inutile d'essayer d'autres formes");
  const missing = makeAi([apiError(404, "model: claude-introuvable")]);
  assert.equal((await missing.ai.review(CTX)).code, "MODEL");
});

test("clé refusée : arrêt immédiat, puis pause avant de réessayer", async () => {
  const { ai, http, clock } = makeAi([apiError(401, "invalid x-api-key"), reply(GOOD)]);
  assert.equal((await ai.review(CTX)).code, "AUTH");
  assert.equal(http.calls.length, 1);
  const paused = await ai.review(CTX);
  assert.equal(paused.ok, false);
  assert.equal(http.calls.length, 1, "aucun appel pendant la pause");
  assert.ok(ai.status().pauseJusquA);
  clock.t += 11 * 60000;
  assert.equal((await ai.review(CTX)).ok, true);
  assert.equal(http.calls.length, 2);
  assert.equal(ai.status().pauseJusquA, null);
});

test("pannes répétées : l'IA se met en pause une minute au lieu de ralentir chaque demande", async () => {
  const { ai, http, clock } = makeAi([apiError(529, "overloaded"), apiError(529, "overloaded"), apiError(529, "overloaded"), apiError(529, "overloaded"), reply(GOOD)]);
  for (let i = 0; i < 4; i++) assert.equal((await ai.review(CTX)).code, "UNAVAILABLE");
  assert.equal(http.calls.length, 4);
  assert.equal((await ai.review(CTX)).ok, false);
  assert.equal(http.calls.length, 4, "en pause");
  clock.t += 61000;
  assert.equal((await ai.review(CTX)).ok, true);
});

test("limite de requêtes et délai dépassé : codes distincts", async () => {
  assert.equal((await makeAi([apiError(429, "", "RATE_LIMIT")]).ai.review(CTX)).code, "RATE_LIMIT");
  assert.equal((await makeAi([apiError(0, "", "TIMEOUT")]).ai.review(CTX)).code, "TIMEOUT");
});

test("refus de l'IA : pas de nouvel essai", async () => {
  const { ai, http } = makeAi([reply("", { stop_reason: "refusal", content: [] })]);
  assert.equal((await ai.review(CTX)).code, "REFUSAL");
  assert.equal(http.calls.length, 1);
});

test("réponse tronquée : un nouvel essai avec plus de place", async () => {
  const { ai, http } = makeAi([(b, n) => (n === 1 ? reply('{"ajustement_points": 1, "conf', { stop_reason: "max_tokens" }) : reply(GOOD))]);
  const r = await ai.review(CTX);
  assert.equal(r.ok, true);
  assert.equal(http.calls[1].body.max_tokens, http.calls[0].body.max_tokens * 2);
});

test("réponse inexploitable : un second essai, puis échec", async () => {
  const bad = makeAi([reply("désolé, je ne sais pas")]);
  assert.equal((await bad.ai.review(CTX)).code, "INVALID_OUTPUT");
  assert.equal(bad.http.calls.length, 2);
  const recovers = makeAi([(b, n) => (n === 1 ? reply("???") : reply(GOOD))]);
  assert.equal((await recovers.ai.review(CTX)).ok, true);
});

test("IA désactivée : aucun appel", async () => {
  const off = createAi({ config: loadConfig({}), http: fakeHttp([reply(GOOD)]), log: quiet });
  assert.equal((await off.review(CTX)).code, "DISABLED");
  const disabled = makeAi([reply(GOOD)], { AI_ENABLED: "false" });
  assert.equal((await disabled.ai.review(CTX)).code, "DISABLED");
  assert.equal(disabled.http.calls.length, 0);
});

test("budget quotidien : plafond puis remise à zéro le lendemain", async () => {
  const { ai, http, clock } = makeAi([reply(GOOD)], { AI_DAILY_BUDGET_CALLS: "3" });
  for (let i = 0; i < 3; i++) assert.equal((await ai.review(CTX)).ok, true);
  assert.equal((await ai.review(CTX)).code, "BUDGET");
  assert.equal(http.calls.length, 3);
  clock.t += 24 * 3600000;
  assert.equal((await ai.review(CTX)).ok, true);
});

test("au plus quatre appels simultanés", async () => {
  let running = 0;
  let peak = 0;
  const http = {
    postJson: async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 15));
      running--;
      return reply(GOOD);
    },
  };
  const ai = createAi({ config: loadConfig({ ANTHROPIC_API_KEY: "k" }), http, log: quiet });
  const results = await Promise.all(Array.from({ length: 10 }, () => ai.review(CTX)));
  assert.ok(results.every((r) => r.ok));
  assert.ok(peak <= 4 && peak >= 2, `pic = ${peak}`);
});

test("avec le vrai client HTTP : adresse, en-têtes et corps JSON conformes", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => reply(GOOD) };
  };
  const http = createHttp({ fetchImpl, sleepImpl: async () => {} });
  const ai = createAi({ config: loadConfig({ ANTHROPIC_API_KEY: "sk-ant-test-key" }), http, log: quiet });
  const r = await ai.review(CTX);
  assert.equal(r.ok, true);
  assert.equal(seen[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers["x-api-key"], "sk-ant-test-key");
  assert.equal(seen[0].init.headers["anthropic-version"], "2023-06-01");
  assert.equal(seen[0].init.headers["content-type"], "application/json");
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal(body.thinking.type, "between_tools");
  assert.equal(body.output_config.format.type, "json_schema");
});

test("la clé n'apparaît jamais dans l'état exposé ni dans les erreurs", async () => {
  const { ai } = makeAi([apiError(401, "invalid x-api-key sk-ant-test-key-SECRET")]);
  const r = await ai.review(CTX);
  const dump = JSON.stringify([r, ai.status()]);
  assert.ok(!dump.includes("sk-ant-test-key"), dump);
});
