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

// Horloge virtuelle : les attentes (sleep) avancent un temps simulé, dans l'ordre, sans rien attendre pour de vrai.
function virtualClock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    sleep: (ms) => new Promise((resolve) => timers.push({ at: t + ms, resolve })),
    async run(promise) {
      let done = false;
      const finished = promise.then(
        () => (done = true),
        () => (done = true)
      );
      for (let guard = 0; !done; guard++) {
        assert.ok(guard < 5000, "le scénario ne se termine pas");
        await new Promise((r) => setImmediate(r));
        if (done || !timers.length) continue;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        t = Math.max(t, next.at);
        next.resolve();
      }
      await finished;
      return promise;
    },
  };
}

// Faux fetch qui note l'instant de chaque appel ; `answers(n)` donne la réponse du n-ième appel.
function timedFetch(clock, answers) {
  const log = [];
  const fetchImpl = async () => {
    log.push(clock.now());
    return answers(log.length);
  };
  return { fetchImpl, log };
}

test("429 : le service est mis en pause, la reprise attend la fin de la pause au lieu de retomber aussitôt sur la limite", async () => {
  const clock = virtualClock();
  const { fetchImpl, log } = timedFetch(clock, (n) => (n === 1 ? res(429, {}) : res(200, { ok: n })));
  const http = createHttp({ fetchImpl, sleepImpl: clock.sleep, now: clock.now });
  const out = await clock.run(http.getJson("https://exemple.test/a", { throttleKey: "svc", minIntervalMs: 1000, rateLimitCoolMs: 60000 }));
  assert.deepEqual(out, { ok: 2 });
  assert.deepEqual(log, [0, 60000]);
});

test("429 : sans durée de pause demandée, le comportement d'origine est conservé (courte attente puis reprise)", async () => {
  const clock = virtualClock();
  const { fetchImpl, log } = timedFetch(clock, (n) => (n === 1 ? res(429, {}) : res(200, {})));
  const http = createHttp({ fetchImpl, sleepImpl: clock.sleep, now: clock.now });
  await clock.run(http.getJson("https://exemple.test/a", { throttleKey: "svc", minIntervalMs: 1000 }));
  assert.equal(log.length, 2);
  assert.ok(log[1] < 5000, `reprise tardive : ${log[1]}`);
});

test("429 : les appels déjà planifiés se replacent derrière la pause, espacés, sans repartir pendant le blocage", async () => {
  const clock = virtualClock();
  const { fetchImpl, log } = timedFetch(clock, (n) => (n === 1 ? res(429, {}) : res(200, { n })));
  const http = createHttp({ fetchImpl, sleepImpl: clock.sleep, now: clock.now });
  const opts = { throttleKey: "svc", minIntervalMs: 1000, rateLimitCoolMs: 60000 };
  const all = Promise.all([http.getJson("https://exemple.test/a", opts), http.getJson("https://exemple.test/b", opts), http.getJson("https://exemple.test/c", opts)]);
  const out = await clock.run(all);
  assert.equal(out.length, 3);
  assert.equal(log[0], 0);
  // Aucun appel entre le premier refus et la fin de la pause, puis les trois repartent espacés d'une seconde.
  assert.deepEqual(log.slice(1), [60000, 61000, 62000]);
});

test("429 : un appel qui arrive pendant la pause attend sa fin", async () => {
  const clock = virtualClock();
  const { fetchImpl, log } = timedFetch(clock, (n) => (n === 1 ? res(429, {}) : res(200, {})));
  const http = createHttp({ fetchImpl, sleepImpl: clock.sleep, now: clock.now });
  const opts = { throttleKey: "svc", minIntervalMs: 1000, rateLimitCoolMs: 60000 };
  const first = http.getJson("https://exemple.test/a", opts);
  await new Promise((r) => setImmediate(r)); // le premier appel a reçu son 429
  const second = http.getJson("https://exemple.test/b", opts);
  await clock.run(Promise.all([first, second]));
  assert.equal(log[0], 0);
  assert.ok(log.slice(1).every((t) => t >= 60000), `appel parti pendant la pause : ${log}`);
  assert.equal(log.length, 3);
});

test("429 : la pause est aussi posée quand il ne reste plus de reprise, et les services voisins ne sont pas touchés", async () => {
  const clock = virtualClock();
  const { fetchImpl, log } = timedFetch(clock, (n) => (n === 1 ? res(429, {}) : res(200, {})));
  const http = createHttp({ fetchImpl, sleepImpl: clock.sleep, now: clock.now });
  await assert.rejects(clock.run(http.getJson("https://exemple.test/a", { throttleKey: "svc", rateLimitCoolMs: 60000, retries: 0 })), (e) => e.code === "RATE_LIMIT");
  assert.deepEqual(http.cooldowns(), { svc: 60000 });
  // Un autre service n'attend pas ; le service en pause, si.
  await clock.run(http.getJson("https://exemple.test/b", { throttleKey: "autre", rateLimitCoolMs: 60000 }));
  assert.equal(log[1], 0);
  await clock.run(http.getJson("https://exemple.test/c", { throttleKey: "svc", rateLimitCoolMs: 60000 }));
  assert.equal(log[2], 60000);
  assert.deepEqual(http.cooldowns(), {}, "la pause est terminée");
});

test("429 : Retry-After prime sur la durée habituelle, avec un plafond", async () => {
  for (const [header, attendu] of [["5", 5000], ["3600", 90000]]) {
    const clock = virtualClock();
    const { fetchImpl, log } = timedFetch(clock, (n) => (n === 1 ? res(429, {}, { "retry-after": header }) : res(200, {})));
    const http = createHttp({ fetchImpl, sleepImpl: clock.sleep, now: clock.now });
    await clock.run(http.getJson("https://exemple.test/a", { throttleKey: "svc", rateLimitCoolMs: 60000 }));
    assert.deepEqual(log, [0, attendu], `Retry-After ${header}`);
  }
});

test("429 sans clé de service : pas de pause générale (appel isolé)", async () => {
  const clock = virtualClock();
  const { fetchImpl } = timedFetch(clock, (n) => (n === 1 ? res(429, {}) : res(200, {})));
  const http = createHttp({ fetchImpl, sleepImpl: clock.sleep, now: clock.now });
  await clock.run(http.getJson("https://exemple.test/a", { rateLimitCoolMs: 60000 }));
  assert.deepEqual(http.cooldowns(), {});
});
