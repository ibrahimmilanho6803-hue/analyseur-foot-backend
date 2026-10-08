"use strict";

// Limiteur de débit en mémoire (fenêtre fixe, par adresse IP). Suffisant pour un seul serveur.
function createLimiter({ limit, windowMs = 60000, now = Date.now, maxEntries = 10000 }) {
  const hits = new Map();

  function purge(t) {
    for (const [ip, e] of hits) if (t >= e.resetAt) hits.delete(ip);
    while (hits.size > maxEntries) hits.delete(hits.keys().next().value);
  }

  function consume(ip, cost = 1) {
    const t = now();
    if (hits.size >= maxEntries) purge(t);
    let e = hits.get(ip);
    if (!e || t >= e.resetAt) {
      e = { count: 0, resetAt: t + windowMs };
      hits.set(ip, e);
    }
    if (e.count + cost > limit) {
      return { ok: false, limit, remaining: Math.max(0, limit - e.count), retryAfterSec: Math.max(1, Math.ceil((e.resetAt - t) / 1000)) };
    }
    e.count += cost;
    return { ok: true, limit, remaining: limit - e.count, retryAfterSec: 0 };
  }

  return { consume, size: () => hits.size };
}

module.exports = { createLimiter };
