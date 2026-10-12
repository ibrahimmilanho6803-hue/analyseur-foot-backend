"use strict";

const { sleep, redact } = require("./util");

class HttpError extends Error {
  constructor(message, { status = 0, code = "HTTP", url = "", detail = "", retryAfterMs = 0 } = {}) {
    super(redact(message));
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.url = redact(url);
    this.detail = redact(detail);
    this.retryAfterMs = retryAfterMs;
  }
}

// Durée maximale d'une pause après « trop de requêtes » (429) : au-delà, mieux vaut échouer et laisser le cache reprendre plus tard.
const MAX_COOL_MS = 90000;

// Client HTTP JSON : délai maximal, reprises sur erreurs temporaires, cadence
// minimale par service (pour respecter les limites des offres gratuites) et pause générale d'un service
// qui répond « trop de requêtes » (429) : tant qu'elle dure, aucun appel vers ce service ne part.
function createHttp({ fetchImpl = globalThis.fetch, sleepImpl = sleep, now = Date.now } = {}) {
  const nextSlot = new Map();
  const coolUntil = new Map();

  async function throttle(key, gapMs) {
    if (!key) return;
    // Un appel qui attendait son tour pendant qu'un autre se heurtait à la limite se replace derrière la pause :
    // sans cela, tous les appels déjà planifiés partiraient pendant le blocage et le prolongeraient.
    for (let i = 0; i < 5; i++) {
      const t = now();
      const start = Math.max(t, nextSlot.get(key) || 0, coolUntil.get(key) || 0);
      nextSlot.set(key, start + (gapMs || 0));
      if (start > t) await sleepImpl(start - t);
      if ((coolUntil.get(key) || 0) <= now()) return;
    }
  }

  // Un service qui répond 429 est laissé tranquille : Retry-After s'il l'indique, sinon la durée habituelle de son blocage.
  function coolDown(key, header, defaultMs) {
    const ms = Math.min(MAX_COOL_MS, Math.max(1000, header > 0 ? header * 1000 : defaultMs));
    coolUntil.set(key, Math.max(coolUntil.get(key) || 0, now() + ms));
  }

  // Pauses en cours (millisecondes restantes par service), pour le diagnostic.
  function cooldowns() {
    const out = {};
    for (const [key, until] of coolUntil) if (until > now()) out[key] = until - now();
    return out;
  }

  function retryDelay(res, attempt) {
    const header = Number(res && res.headers && res.headers.get && res.headers.get("retry-after"));
    if (Number.isFinite(header) && header > 0) return Math.min(header, 20) * 1000;
    return 600 * 2 ** attempt + Math.floor(Math.random() * 250);
  }

  async function requestJson(url, opts = {}) {
    const { method = "GET", headers = {}, body, timeoutMs = 15000, retries = 2, throttleKey, minIntervalMs = 0, rateLimitCoolMs = 0 } = opts;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await throttle(throttleKey, minIntervalMs);
      let res;
      try {
        res = await fetchImpl(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
        lastErr = new HttpError(timedOut ? "délai dépassé" : `réseau : ${e.message}`, {
          code: timedOut ? "TIMEOUT" : "NETWORK",
          url,
        });
        if (attempt < retries) await sleepImpl(retryDelay(null, attempt));
        continue;
      }
      if (res.ok) {
        try {
          return await res.json();
        } catch (e) {
          throw new HttpError("réponse illisible (JSON invalide)", { status: res.status, code: "BAD_JSON", url });
        }
      }
      const retryable = res.status === 429 || res.status >= 500;
      let detail = "";
      try {
        if (typeof res.text === "function") detail = String(await res.text()).slice(0, 600);
      } catch (e) {
        detail = "";
      }
      const header = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
      lastErr = new HttpError(`HTTP ${res.status}`, {
        status: res.status,
        code: res.status === 429 ? "RATE_LIMIT" : "HTTP",
        url,
        detail,
        retryAfterMs: Number.isFinite(header) && header > 0 ? header * 1000 : 0,
      });
      // Le service dit « trop de requêtes » : on le laisse respirer pour tous les appels, y compris cette reprise,
      // qui attend la fin de la pause dans throttle() au lieu de retomber aussitôt sur la même réponse.
      const pause = res.status === 429 && throttleKey && rateLimitCoolMs > 0;
      if (pause) coolDown(throttleKey, header, rateLimitCoolMs);
      if (!retryable || attempt === retries) break;
      if (!pause) await sleepImpl(retryDelay(res, attempt));
    }
    throw lastErr;
  }

  const getJson = (url, opts = {}) => requestJson(url, { ...opts, method: "GET", body: undefined });
  const postJson = (url, body, opts = {}) =>
    requestJson(url, { ...opts, method: "POST", body, headers: { "content-type": "application/json", ...(opts.headers || {}) } });

  return { getJson, postJson, requestJson, cooldowns };
}

module.exports = { createHttp, HttpError };
