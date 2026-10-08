"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHttp, HttpError } = require("../src/http");

function res(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (headers[k.toLowerCase()] !== undefined ? headers[k.toLowerCase()] : null) },
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

// Faux fetch : renvoie les réponses dans l'ordre (ou lève l'erreur donnée).
function scripted(steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetchImpl, calls };
}

function makeHttp(steps, extra = {}) {
  const { fetchImpl, calls } = scripted(steps);
  const sleeps = [];
  const http = createHttp({ fetchImpl, sleepImpl: async (ms) => sleeps.push(ms), now: () => 1000, ...extra });
  return { http, calls, sleeps };
}

test("renvoie le JSON d'une réponse correcte", async () => {
  const { http, calls } = makeHttp([res(200, { ok: 1 })]);
  assert.deepEqual(await http.getJson("https://exemple.test/a", { headers: { "X-Test": "1" } }), { ok: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers["X-Test"], "1");
  assert.ok(calls[0].init.signal, "un délai maximal doit être posé");
});

test("reprend après une erreur serveur puis réussit", async () => {
  const { http, calls, sleeps } = makeHttp([res(503, {}), res(200, { ok: 2 })]);
  assert.deepEqual(await http.getJson("https://exemple.test/a"), { ok: 2 });
  assert.equal(calls.length, 2);
  assert.equal(sleeps.length, 1);
});

test("respecte l'en-tête Retry-After sur une limite de requêtes", async () => {
  const { http, sleeps } = makeHttp([res(429, {}, { "retry-after": "2" }), res(200, { ok: 3 })]);
  assert.deepEqual(await http.getJson("https://exemple.test/a"), { ok: 3 });
  assert.deepEqual(sleeps, [2000]);
});

test("ne répète pas une erreur définitive (404)", async () => {
  const { http, calls } = makeHttp([res(404, {})]);
  await assert.rejects(http.getJson("https://exemple.test/a"), (e) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 404);
    assert.equal(e.code, "HTTP");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("abandonne après les reprises permises et signale la limite atteinte", async () => {
  const { http, calls } = makeHttp([res(429, {})]);
  await assert.rejects(http.getJson("https://exemple.test/a", { retries: 2 }), (e) => e.code === "RATE_LIMIT" && e.status === 429);
  assert.equal(calls.length, 3);
});

test("erreur réseau : reprises puis code NETWORK", async () => {
  const { http, calls } = makeHttp([new Error("connexion refusée")]);
  await assert.rejects(http.getJson("https://exemple.test/a", { retries: 1 }), (e) => e.code === "NETWORK" && /connexion refus/.test(e.message));
  assert.equal(calls.length, 2);
});

test("délai dépassé : code TIMEOUT", async () => {
  const err = new Error("trop long");
  err.name = "TimeoutError";
  const { http } = makeHttp([err]);
  await assert.rejects(http.getJson("https://exemple.test/a", { retries: 0 }), (e) => e.code === "TIMEOUT");
});

test("JSON invalide : erreur claire, sans reprise", async () => {
  const { http, calls } = makeHttp([res(200, new SyntaxError("x"))]);
  await assert.rejects(http.getJson("https://exemple.test/a"), (e) => e.code === "BAD_JSON");
  assert.equal(calls.length, 1);
});

test("cadence minimale : les appels d'un même service sont espacés", async () => {
  const { http, sleeps } = makeHttp([res(200, {})]);
  const opts = { throttleKey: "svc", minIntervalMs: 1000 };
  await http.getJson("https://exemple.test/1", opts);
  await http.getJson("https://exemple.test/2", opts);
  await http.getJson("https://exemple.test/3", opts);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("des services différents ne se ralentissent pas entre eux", async () => {
  const { http, sleeps } = makeHttp([res(200, {})]);
  await http.getJson("https://exemple.test/1", { throttleKey: "a", minIntervalMs: 1000 });
  await http.getJson("https://exemple.test/2", { throttleKey: "b", minIntervalMs: 1000 });
  assert.deepEqual(sleeps, []);
});

test("les clés ne fuient pas dans les messages d'erreur", async () => {
  const { http } = makeHttp([res(500, {})]);
  await assert.rejects(http.getJson("https://www.thesportsdb.com/api/v1/json/MACLESECRETE/eventsseason.php?id=1", { retries: 0 }), (e) => {
    assert.ok(!e.url.includes("MACLESECRETE"), e.url);
    assert.ok(!e.message.includes("MACLESECRETE"));
    return true;
  });
});

test("POST : envoie le corps en JSON avec les bons en-têtes", async () => {
  const { http, calls } = makeHttp([res(200, { ok: 1 })]);
  assert.deepEqual(await http.postJson("https://exemple.test/p", { a: 1 }, { headers: { "x-api-key": "K" } }), { ok: 1 });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, '{"a":1}');
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(calls[0].init.headers["x-api-key"], "K");
});

test("GET : aucun corps n'est envoyé", async () => {
  const { http, calls } = makeHttp([res(200, {})]);
  await http.getJson("https://exemple.test/g");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
});

test("erreur : un extrait de la réponse est conservé, sans clé", async () => {
  const bad = {
    ok: false,
    status: 400,
    headers: { get: () => null },
    text: async () => 'thinking.type.disabled is not supported (clé sk-ant-api03-ABCDEF et key=SECRET123)',
    json: async () => ({}),
  };
  const { http } = makeHttp([bad]);
  await assert.rejects(http.postJson("https://exemple.test/p", {}, { retries: 0 }), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.detail, /thinking\.type\.disabled/);
    assert.ok(!e.detail.includes("ABCDEF") && !e.detail.includes("SECRET123"), e.detail);
    return true;
  });
});

test("erreur 429 : le délai demandé par le serveur est exposé", async () => {
  const { http } = makeHttp([res(429, {}, { "retry-after": "7" })]);
  await assert.rejects(http.postJson("https://exemple.test/p", {}, { retries: 0 }), (e) => e.code === "RATE_LIMIT" && e.retryAfterMs === 7000);
});
