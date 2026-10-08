"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { buildWorld } = require("./world");

const quiet = { log() {}, warn() {}, error() {} };

async function start(worldOpts = {}) {
  const w = buildWorld(worldOpts);
  const app = createApp({ ...w, now: () => w.clock.t, log: quiet });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = "GET", body, headers = {}, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      json = null;
    }
    return { status: res.status, json, headers: res.headers };
  };
  return { w, call, close: () => new Promise((r) => server.close(r)) };
}

test("santé et informations générales", async () => {
  const s = await start();
  try {
    const h = await s.call("/health");
    assert.equal(h.status, 200);
    assert.equal(h.json.ok, true);
    assert.equal((await s.call("/")).json.etat, "/api/status");
    assert.equal(h.headers.get("x-powered-by"), null);
    assert.equal(h.headers.get("x-content-type-options"), "nosniff");
    const l = await s.call("/api/leagues");
    assert.equal(l.json.championnats.length, 10);
    assert.equal(l.json.championnats.find((c) => c.key === "PL").couvert, true);
    assert.equal(l.json.championnats.find((c) => c.key === "BSA").couvert, false);
  } finally {
    await s.close();
  }
});

test("état : sources, IA, réglages du modèle, aucun secret", async () => {
  const s = await start();
  try {
    await s.w.data.ensureAll();
    const r = await s.call("/api/status");
    assert.equal(r.status, 200);
    assert.ok(r.json.donnees.championnats.find((c) => c.key === "PL").charge);
    assert.equal(r.json.modele.reglages.halfLifeDays, 300);
    assert.equal(typeof r.json.ia.active, "boolean");
    assert.ok(!JSON.stringify(r.json).includes("test-key"));
  } finally {
    await s.close();
  }
});

test("état : « avertissements » vide seulement quand tout est chargé ; sinon la raison est donnée", async () => {
  const s = await start({ env: { FOOTBALL_DATA_API_KEY: "test-fd" } });
  try {
    const avant = (await s.call("/api/status")).json;
    assert.ok(avant.avertissements.some((a) => /Chargement en cours : 3 championnat/.test(a)), JSON.stringify(avant.avertissements));
    assert.deepEqual(avant.donnees.championnats.filter((c) => c.couvert).map((c) => c.etat), ["chargement", "chargement", "chargement"]);
    await s.w.data.ensureAll();
    const apres = (await s.call("/api/status")).json;
    assert.deepEqual(apres.avertissements, []);
    assert.deepEqual(apres.donnees.championnats.filter((c) => c.couvert).map((c) => c.etat), ["pret", "pret", "pret"]);
  } finally {
    await s.close();
  }
});

test("état : une source en panne donne l'avertissement « Chargement impossible » avec la raison (et /api/analyze l'explique)", async () => {
  const s = await start({ failing: ["PL", "PD", "SA"], aiBehaviour: "off", env: { FOOTBALL_DATA_API_KEY: "test-fd" } });
  try {
    const a = await s.call("/api/analyze", { method: "POST", body: { equipe1: "Arsenal", equipe2: "Chelsea", typePari: "Match nul" } });
    assert.equal(a.status, 200);
    assert.equal(a.json.etat, "donnees_indisponibles");
    const r = (await s.call("/api/status")).json;
    assert.equal(r.avertissements.length, 1);
    assert.match(r.avertissements[0], /^Chargement impossible \(Premier League, Liga, Serie A\) : .*source en panne/);
    const pl = r.donnees.championnats.find((c) => c.key === "PL");
    assert.equal(pl.etat, "echec");
    assert.equal(pl.charge, false);
    assert.match(pl.derniereErreur, /source en panne/);
    const top = await s.call("/api/top-matches");
    assert.equal(top.status, 503);
    assert.equal(top.json.details.length, 3);
  } finally {
    await s.close();
  }
});

test("POST /api/analyze : une sélection", async () => {
  const s = await start();
  try {
    const r = await s.call("/api/analyze", { method: "POST", body: { equipe1: "Arsenal", equipe2: "Chelsea", typePari: "Plus de 1.5 buts" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.etat, "ok");
    assert.equal(typeof r.json.probabilite, "number");
    assert.equal(r.json.equipesTrouvees1, true);
  } finally {
    await s.close();
  }
});

test("POST /api/analyze : plusieurs sélections, dont une équipe inconnue", async () => {
  const s = await start({ aiBehaviour: "off" });
  try {
    const r = await s.call("/api/analyze", {
      method: "POST",
      body: { legs: [{ equipe1: "Arsenal", equipe2: "Chelsea", typePari: "Match nul" }, { equipe1: "Truc", equipe2: "Chelsea", typePari: "Match nul" }] },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.legs.map((x) => x.etat), ["ok", "equipe_inconnue"]);
    assert.equal(r.json.legs[1].probabilite, null);
  } finally {
    await s.close();
  }
});

test("POST /api/analyze : entrées invalides refusées proprement", async () => {
  const s = await start();
  try {
    const post = (body, raw) => s.call("/api/analyze", { method: "POST", body, raw });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ equipe1: "Arsenal" })).status, 400);
    assert.equal((await post({ equipe1: 12, equipe2: ["x"] })).status, 400);
    assert.equal((await post({ legs: [] })).status, 400);
    assert.equal((await post({ legs: "oui" })).status, 400);
    assert.equal((await post({ legs: Array.from({ length: 13 }, () => ({ equipe1: "A", equipe2: "B" })) })).status, 400);
    assert.equal((await post({ legs: [{ equipe1: "A", equipe2: "B" }, null] })).status, 400);
    const bad = await post(undefined, "{pas du json");
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /JSON/);
    const huge = await post({ equipe1: "A", equipe2: "B", typePari: "x".repeat(30000) });
    assert.equal(huge.status, 413);
    assert.equal(s.w.ai.calls.length, 0, "aucune demande invalide n'atteint l'IA");
  } finally {
    await s.close();
  }
});

test("les noms trop longs ou contenant des caractères de contrôle sont assainis", async () => {
  const s = await start({ aiBehaviour: "off" });
  try {
    const r = await s.call("/api/analyze", { method: "POST", body: { equipe1: "Arsenal\u0000\n".repeat(30), equipe2: "Chelsea", typePari: "Match nul" } });
    assert.equal(r.status, 200);
    assert.ok(["ok", "equipe_inconnue", "ambigu"].includes(r.json.etat));
  } finally {
    await s.close();
  }
});

test("GET /api/top-matches : trois matchs au format de l'application", async () => {
  const s = await start();
  try {
    const r = await s.call("/api/top-matches");
    assert.equal(r.status, 200);
    assert.equal(r.json.topMatches.length, 3);
    assert.ok(r.json.topMatches[0].homeTeam && r.json.topMatches[0].meilleurPari);
    assert.ok(r.json.coteTotale);
  } finally {
    await s.close();
  }
});

test("GET /api/top-matches : 503 explicite quand aucune donnée n'est disponible", async () => {
  const s = await start({ failing: ["PL", "PD", "SA"] });
  try {
    const r = await s.call("/api/top-matches");
    assert.equal(r.status, 503);
    assert.match(r.json.error, /Aucune source/);
  } finally {
    await s.close();
  }
});

test("POST /api/auto-coupon", async () => {
  const s = await start({ aiBehaviour: "off" });
  try {
    const ok = await s.call("/api/auto-coupon", { method: "POST", body: { matches: [{ equipe1: "Arsenal", equipe2: "Chelsea" }, { equipe1: "Real Madrid", equipe2: "Barcelona" }] } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.analyses, 2);
    assert.equal(ok.json.resultats.length, 2);
    for (const bad of [{}, { matches: [] }, { matches: "x" }, { matches: [{ equipe1: "A" }] }]) {
      assert.equal((await s.call("/api/auto-coupon", { method: "POST", body: bad })).status, 400);
    }
  } finally {
    await s.close();
  }
});

test("l'ancienne route /api/analyze-simple est fermée et n'appelle jamais l'IA", async () => {
  const s = await start();
  try {
    const body = { model: "claude-sonnet-5", max_tokens: 4000, messages: [{ role: "user", content: "écris-moi un roman" }] };
    const r = await s.call("/api/analyze-simple", { method: "POST", body });
    assert.equal(r.status, 410);
    assert.match(r.json.error, /supprimée/);
    assert.equal((await s.call("/api/analyze-simple")).status, 410);
    assert.equal(s.w.ai.calls.length, 0);
  } finally {
    await s.close();
  }
});

test("CORS : site officiel, aperçus Vercel, application mobile et poste de développement autorisés", async () => {
  const s = await start();
  try {
    const allowed = [
      "https://analyseur-foot-web.vercel.app",
      "https://analyseur-foot-web-git-amelioration-fiabilite-ibrahim.vercel.app",
      "http://localhost:3000",
      "https://localhost",
      "capacitor://localhost",
    ];
    for (const origin of allowed) {
      const r = await s.call("/api/leagues", { headers: { origin } });
      assert.equal(r.status, 200, origin);
      assert.equal(r.headers.get("access-control-allow-origin"), origin);
    }
  } finally {
    await s.close();
  }
});

test("CORS : les autres sites sont refusés, y compris les adresses qui y ressemblent", async () => {
  const s = await start();
  try {
    for (const origin of ["https://evil.example", "https://analyseur-foot-web.vercel.app.evil.com", "https://evil-analyseur-foot-web.vercel.app", "http://analyseur-foot-web.vercel.app", "null"]) {
      const r = await s.call("/api/leagues", { headers: { origin } });
      assert.equal(r.status, 403, origin);
      assert.equal(r.headers.get("access-control-allow-origin"), null);
    }
    assert.equal((await s.call("/health", { headers: { origin: "https://evil.example" } })).status, 200, "la sonde de santé reste accessible");
  } finally {
    await s.close();
  }
});

test("CORS : requête préliminaire (preflight) d'un POST depuis le site officiel", async () => {
  const s = await start();
  try {
    const r = await s.call("/api/analyze", {
      method: "OPTIONS",
      headers: { origin: "https://analyseur-foot-web.vercel.app", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "https://analyseur-foot-web.vercel.app");
    assert.match(r.headers.get("access-control-allow-methods"), /POST/);
  } finally {
    await s.close();
  }
});

test("origines supplémentaires ajoutables par ALLOWED_ORIGINS, sans retirer celles du site officiel", async () => {
  const s = await start({ env: { ALLOWED_ORIGINS: "https://mon-site.example, https://autre.example" } });
  try {
    assert.equal((await s.call("/api/leagues", { headers: { origin: "https://mon-site.example" } })).status, 200);
    assert.equal((await s.call("/api/leagues", { headers: { origin: "https://autre.example" } })).status, 200);
    assert.equal((await s.call("/api/leagues", { headers: { origin: "https://analyseur-foot-web.vercel.app" } })).status, 200);
    assert.equal((await s.call("/api/leagues", { headers: { origin: "https://pas-dans-la-liste.example" } })).status, 403);
  } finally {
    await s.close();
  }
});

test("limite générale de requêtes par minute", async () => {
  const s = await start({ env: { RATE_LIMIT_PER_MIN: "5" } });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await s.call("/api/leagues")).status, 200);
    const blocked = await s.call("/api/leagues");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    assert.match(blocked.json.error, /Trop de demandes/);
    assert.equal((await s.call("/health")).status, 200, "la sonde de santé n'est pas limitée");
    s.w.clock.t += 61000;
    assert.equal((await s.call("/api/leagues")).status, 200);
  } finally {
    await s.close();
  }
});

test("limite des appels coûteux (IA) : chaque sélection compte", async () => {
  const s = await start({ env: { RATE_LIMIT_AI_PER_MIN: "5" }, aiBehaviour: "off" });
  try {
    const leg = { equipe1: "Arsenal", equipe2: "Chelsea", typePari: "Match nul" };
    assert.equal((await s.call("/api/analyze", { method: "POST", body: { legs: [leg, leg, leg, leg] } })).status, 200);
    assert.equal((await s.call("/api/analyze", { method: "POST", body: { legs: [leg, leg] } })).status, 429);
    assert.equal((await s.call("/api/analyze", { method: "POST", body: leg })).status, 200);
    s.w.clock.t += 61000;
    assert.equal((await s.call("/api/analyze", { method: "POST", body: { legs: [leg, leg] } })).status, 200);
  } finally {
    await s.close();
  }
});

test("GET /api/backtest : rapport de fiabilité, paramètres bornés, championnat inconnu", async () => {
  const s = await start({ aiBehaviour: "off" });
  try {
    const r = await s.call("/api/backtest");
    assert.equal(r.status, 200);
    assert.ok(r.json.matchsEvalues > 50, `${r.json.matchsEvalues} matchs`);
    assert.ok(r.json.resultat1N2.brierModele > 0);
    assert.ok(Array.isArray(r.json.calibration));
    assert.equal(r.json.parametres.jours, 120);
    const one = await s.call("/api/backtest?championnat=pl&jours=9999");
    assert.equal(one.status, 200);
    assert.equal(one.json.parametres.jours, 365);
    assert.deepEqual(one.json.parChampionnat.map((c) => c.championnat), ["PL"]);
    assert.equal((await s.call("/api/backtest?championnat=XYZ")).status, 404);
  } finally {
    await s.close();
  }
});

test("GET /api/backtest : limité à quelques appels par minute", async () => {
  const s = await start({ aiBehaviour: "off" });
  try {
    for (let i = 0; i < 6; i++) assert.equal((await s.call("/api/backtest")).status, 200);
    assert.equal((await s.call("/api/backtest")).status, 429);
  } finally {
    await s.close();
  }
});

test("erreurs internes : message générique, jamais de détail technique", async () => {
  const s = await start();
  try {
    s.w.analysis.analyzeLegs = async () => {
      throw new Error("secret interne : /home/app/clé");
    };
    const r = await s.call("/api/analyze", { method: "POST", body: { equipe1: "A", equipe2: "B" } });
    assert.equal(r.status, 500);
    assert.equal(r.json.error, "Erreur interne du serveur.");
    assert.ok(!JSON.stringify(r.json).includes("secret"));
    const nf = await s.call("/api/inexistante");
    assert.equal(nf.status, 404);
  } finally {
    await s.close();
  }
});
