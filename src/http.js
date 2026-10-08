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

// Client HTTP JSON : délai maximal, reprises sur erreurs temporaires, cadence
// minimale par service (pour respecter les limites des offres gratuites).
function createHttp({ fetchImpl = globalThis.fetch, sleepImpl = sleep, now = Date.now } = {}) {
  const nextSlot = new Map();

  async function throttle(key, gapMs) {
    if (!key || !gapMs) return;
    const t = now();
    const start = Math.max(t, nextSlot.get(key) || 0);
    nextSlot.set(key, start + gapMs);
    if (start > t) await sleepImpl(start - t);
  }

  function retryDelay(res, attempt) {
    const header = Number(res && res.headers && res.headers.get && res.headers.get("retry-after"));
    if (Number.isFinite(header) && header > 0) return Math.min(header, 20) * 1000;
    return 600 * 2 ** attempt + Math.floor(Math.random() * 250);
  }

  async function requestJson(url, opts = {}) {
    const { method = "GET", headers = {}, body, timeoutMs = 15000, retries = 2, throttleKey, minIntervalMs = 0 } = opts;
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
      if (!retryable || attempt === retries) break;
      await sleepImpl(retryDelay(res, attempt));
    }
    throw lastErr;
  }

  const getJson = (url, opts = {}) => requestJson(url, { ...opts, method: "GET", body: undefined });
  const postJson = (url, body, opts = {}) =>
    requestJson(url, { ...opts, method: "POST", body, headers: { "content-type": "application/json", ...(opts.headers || {}) } });

  return { getJson, postJson, requestJson };
}

module.exports = { createHttp, HttpError };
