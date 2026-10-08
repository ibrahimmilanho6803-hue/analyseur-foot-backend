"use strict";

// Cache en mémoire avec trois protections :
//  - une seule requête réelle à la fois par clé (les autres attendent le même résultat) ;
//  - « périmé mais utilisable » : après l'expiration, on répond tout de suite avec
//    l'ancienne valeur et on rafraîchit en arrière-plan ;
//  - si la source tombe en panne, on garde l'ancienne valeur au lieu de tout casser.
class SwrCache {
  constructor({ max = 300, now = Date.now } = {}) {
    this.map = new Map();
    this.inflight = new Map();
    this.max = max;
    this.now = now;
  }

  peek(key) {
    const e = this.map.get(key);
    if (!e || e.value === undefined) return null;
    return { value: e.value, ageMs: this.now() - e.at, lastError: e.error || null };
  }

  // Dernière erreur d'une clé qui n'a jamais pu être chargée (null si rien n'a échoué, ou si une valeur existe).
  peekError(key) {
    const e = this.map.get(key);
    if (!e || e.value !== undefined || !e.error) return null;
    return { message: e.error.message || "erreur", at: e.at };
  }

  async get(key, { ttlMs, staleMs = 0, errorTtlMs = 30000, loader }) {
    const e = this.map.get(key);
    const t = this.now();
    if (e && e.value !== undefined) {
      if (e.retryNotBefore && t < e.retryNotBefore) return e.value;
      const age = t - e.at;
      if (age < ttlMs) return e.value;
      if (age < ttlMs + staleMs) {
        this.#start(key, { errorTtlMs, loader }).catch(() => {});
        return e.value;
      }
    } else if (e && e.error && t < e.errorUntil) {
      throw e.error;
    }
    return this.#start(key, { errorTtlMs, loader });
  }

  #start(key, { errorTtlMs, loader }) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const value = await loader();
        this.map.delete(key);
        this.map.set(key, { value, at: this.now() });
        this.#trim();
        return value;
      } catch (err) {
        const prev = this.map.get(key);
        if (prev && prev.value !== undefined) {
          prev.error = { message: err.message, at: this.now() };
          prev.retryNotBefore = this.now() + errorTtlMs;
          return prev.value;
        }
        this.map.set(key, { error: err, errorUntil: this.now() + errorTtlMs, at: this.now() });
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  #trim() {
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  // Oublie les entrées dont la clé commence par `prefix` (les calculs en cours se terminent normalement).
  invalidate(prefix) {
    for (const key of [...this.map.keys()]) if (key.startsWith(prefix)) this.map.delete(key);
  }

  clear() {
    this.map.clear();
    this.inflight.clear();
  }
}

module.exports = { SwrCache };
