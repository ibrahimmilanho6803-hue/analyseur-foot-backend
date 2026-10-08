"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SwrCache } = require("../src/cache");

function setup(extra = {}) {
  const clock = { t: 0 };
  const cache = new SwrCache({ now: () => clock.t, ...extra });
  return { clock, cache };
}

const tick = () => new Promise((r) => setImmediate(r));

test("garde la valeur pendant sa durée de validité", async () => {
  const { clock, cache } = setup();
  let n = 0;
  const loader = async () => ++n;
  assert.equal(await cache.get("k", { ttlMs: 1000, loader }), 1);
  clock.t = 999;
  assert.equal(await cache.get("k", { ttlMs: 1000, loader }), 1);
  assert.equal(n, 1);
});

test("une seule requête réelle pour des demandes simultanées", async () => {
  const { cache } = setup();
  let n = 0;
  const loader = async () => {
    n++;
    await tick();
    return "v";
  };
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => cache.get("k", { ttlMs: 1000, loader })));
  assert.deepEqual(results, ["v", "v", "v", "v", "v"]);
  assert.equal(n, 1);
});

test("périmé mais utilisable : répond tout de suite et rafraîchit en arrière-plan", async () => {
  const { clock, cache } = setup();
  let n = 0;
  const loader = async () => ++n;
  await cache.get("k", { ttlMs: 1000, staleMs: 5000, loader });
  clock.t = 2000;
  assert.equal(await cache.get("k", { ttlMs: 1000, staleMs: 5000, loader }), 1, "ancienne valeur renvoyée sans attendre");
  await tick();
  assert.equal(n, 2, "rafraîchissement lancé");
  assert.equal(await cache.get("k", { ttlMs: 1000, staleMs: 5000, loader }), 2, "valeur rafraîchie ensuite");
});

test("après la période de grâce, on attend la nouvelle valeur", async () => {
  const { clock, cache } = setup();
  let n = 0;
  const loader = async () => ++n;
  await cache.get("k", { ttlMs: 1000, staleMs: 1000, loader });
  clock.t = 5000;
  assert.equal(await cache.get("k", { ttlMs: 1000, staleMs: 1000, loader }), 2);
});

test("si la source tombe en panne, l'ancienne valeur est conservée", async () => {
  const { clock, cache } = setup();
  let n = 0;
  let fail = false;
  const loader = async () => {
    n++;
    if (fail) throw new Error("source en panne");
    return "bonne valeur";
  };
  await cache.get("k", { ttlMs: 1000, staleMs: 0, errorTtlMs: 30000, loader });
  fail = true;
  clock.t = 2000;
  assert.equal(await cache.get("k", { ttlMs: 1000, staleMs: 0, errorTtlMs: 30000, loader }), "bonne valeur");
  assert.equal(n, 2);
  assert.match(cache.peek("k").lastError.message, /panne/);
  // Pas de nouvel essai pendant la pause d'erreur.
  clock.t = 10000;
  assert.equal(await cache.get("k", { ttlMs: 1000, staleMs: 0, errorTtlMs: 30000, loader }), "bonne valeur");
  assert.equal(n, 2);
  // Après la pause, on réessaie et on se rétablit.
  fail = false;
  clock.t = 40000;
  assert.equal(await cache.get("k", { ttlMs: 1000, staleMs: 0, errorTtlMs: 30000, loader }), "bonne valeur");
  assert.equal(n, 3);
  assert.equal(cache.peek("k").lastError, null);
});

test("un échec sans ancienne valeur est mémorisé brièvement", async () => {
  const { clock, cache } = setup();
  let n = 0;
  const loader = async () => {
    n++;
    throw new Error("hors service");
  };
  const opts = { ttlMs: 1000, errorTtlMs: 5000, loader };
  await assert.rejects(cache.get("k", opts), /hors service/);
  await assert.rejects(cache.get("k", opts), /hors service/);
  assert.equal(n, 1, "pas de tempête de requêtes vers une source en panne");
  clock.t = 6000;
  await assert.rejects(cache.get("k", opts), /hors service/);
  assert.equal(n, 2);
});

test("peek renvoie null pour une clé inconnue et l'âge pour une clé connue", async () => {
  const { clock, cache } = setup();
  assert.equal(cache.peek("absent"), null);
  await cache.get("k", { ttlMs: 1000, loader: async () => 42 });
  clock.t = 300;
  const hit = cache.peek("k");
  assert.equal(hit.value, 42);
  assert.equal(hit.ageMs, 300);
});

test("peekError : raison du dernier échec d'une clé jamais chargée, effacée dès qu'une valeur existe", async () => {
  const { clock, cache } = setup();
  assert.equal(cache.peekError("k"), null);
  const broken = async () => {
    throw new Error("source en panne");
  };
  await assert.rejects(cache.get("k", { ttlMs: 1000, loader: broken }), /source en panne/);
  assert.equal(cache.peek("k"), null);
  assert.equal(cache.peekError("k").message, "source en panne");
  clock.t = 10 * 60000; // le délai de mémorisation de l'échec est passé : la raison reste visible jusqu'au prochain succès
  assert.equal(cache.peekError("k").message, "source en panne");
  assert.equal(await cache.get("k", { ttlMs: 1000, loader: async () => 1 }), 1);
  assert.equal(cache.peekError("k"), null);
});

test("la taille est bornée", async () => {
  const { cache } = setup({ max: 3 });
  for (let i = 0; i < 6; i++) await cache.get(`k${i}`, { ttlMs: 1000, loader: async () => i });
  assert.equal(cache.map.size, 3);
  assert.equal(cache.peek("k0"), null);
  assert.equal(cache.peek("k5").value, 5);
});
