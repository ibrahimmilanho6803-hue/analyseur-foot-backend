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
    assert.equal(l.json.championnats.length, require("../src/leagues").LEAGUES.length);
    assert.equal(l.json.championnats.find((c) => c.key === "PL").couvert, true);
    assert.equal(l.json.championnats.find((c) => c.key === "BSA").couvert, false);
    // Les coupes d'Europe et les championnats complémentaires sont listés, avec leur type et leur niveau (non couverts dans ce petit monde de test).
    const ucl = l.json.championnats.find((c) => c.key === "UCL");
    assert.deepEqual([ucl.nom, ucl.type, ucl.niveau, ucl.couvert], ["Ligue des champions", "coupe", "principal", false]);
    const tsl = l.json.championnats.find((c) => c.key === "TSL");
    assert.deepEqual([tsl.type, tsl.niveau], ["championnat", "complementaire"]);
  } finally {
    await s.close();
  }
});

test("GET /api/teams : clubs des championnats chargés avec leurs écritures courantes", async () => {
  const s = await start({ aliases: { "PL:0": ["Les Gunners", "The Gunners"], "PL:3": ["Citizens"] } });
  try {
    const avant = await s.call("/api/teams");
    assert.equal(avant.status, 200);
    assert.equal(avant.json.complet, false, "aucun championnat n'est encore chargé");
    assert.deepEqual(avant.json.equipes, []);
    assert.equal(avant.headers.get("cache-control"), "public, max-age=300");
    await s.w.data.ensureAll();
    const r = await s.call("/api/teams");
    assert.equal(r.json.complet, true);
    assert.deepEqual(r.json.championnats.map((c) => [c.key, c.charge]), [["PL", true], ["PD", true], ["SA", true]]);
    assert.equal(r.json.equipes.length, 36);
    const names = r.json.equipes.map((e) => e.nom);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "fr")));
    const city = r.json.equipes.find((e) => e.nom === "Manchester City FC");
    assert.equal(city.championnat, "PL");
    assert.ok(city.noms.includes("Man City") && city.noms.includes("Citizens"), JSON.stringify(city));
    assert.ok(!city.noms.includes("Manchester City FC"));
    assert.ok(r.json.equipes.find((e) => e.nom === "Arsenal FC").noms.includes("Les Gunners"));
    assert.ok(!JSON.stringify(r.json).includes("test-key"));
  } finally {
    await s.close();
  }
});

test("GET /api/teams : un championnat en panne n'empêche pas les autres, et la liste est marquée incomplète", async () => {
  const s = await start({ failing: ["SA"] });
  try {
    await s.w.data.ensureAll();
    const r = await s.call("/api/teams");
    assert.equal(r.json.complet, false);
    assert.deepEqual(r.json.championnats.map((c) => [c.key, c.charge]), [["PL", true], ["PD", true], ["SA", false]]);
    assert.equal(r.json.equipes.length, 24);
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

test("état : la correction des totaux de buts est visible, et l'interrupteur MODEL_CALIBRATION=off aussi", async () => {
  const on = await start();
  try {
    const m = (await on.call("/api/status")).json.modele;
    assert.deepEqual(m.correctionDesButs, { active: true, exposantRythme: 0.5, coefficientDeNiveau: 1 });
    assert.equal(m.reglages.rhythmExponent, 0.5);
    assert.equal(m.reglages.levelFactor, 1);
    on.w.data.setModelParams({ levelFactor: 1.04 });
    assert.equal((await on.call("/api/status")).json.modele.correctionDesButs.coefficientDeNiveau, 1.04);
  } finally {
    await on.close();
  }
  const off = await start({ env: { MODEL_CALIBRATION: "off", MODEL_RHYTHM_EXPONENT: "0.7" } });
  try {
    const m = (await off.call("/api/status")).json.modele;
    assert.deepEqual(m.correctionDesButs, { active: false, exposantRythme: 1, coefficientDeNiveau: 1 });
  } finally {
    await off.close();
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

test("POST /api/analyze avec ia:false : modèle seul, aucun appel à l'IA, quota IA intact", async () => {
  const s = await start({ env: { RATE_LIMIT_AI_PER_MIN: "3" } });
  try {
    const leg = { equipe1: "Arsenal", equipe2: "Chelsea", typePari: "Plus de 1.5 buts" };
    const rapide = await s.call("/api/analyze", { method: "POST", body: { legs: [leg, leg, leg, leg, leg, leg], ia: false } });
    assert.equal(rapide.status, 200, "six sélections sans IA ne comptent pas dans la limite de 3 appels IA par minute");
    assert.equal(s.w.ai.calls.length, 0);
    for (const l of rapide.json.legs) {
      assert.equal(l.etat, "ok");
      assert.equal(l.ia.statut, "non_demandee");
      assert.equal(l.ajustementIA, 0);
      assert.equal(l.probabilite, l.probabiliteModele);
      assert.ok(l.justification.length > 20, "une explication du modèle reste fournie");
    }
    // Une sélection seule fonctionne aussi, et la même demande avec l'IA donne la même base chiffrée.
    const seule = await s.call("/api/analyze", { method: "POST", body: { ...leg, ia: false } });
    assert.equal(seule.json.ia.statut, "non_demandee");
    const complet = await s.call("/api/analyze", { method: "POST", body: leg });
    assert.equal(complet.status, 200);
    assert.equal(complet.json.ia.statut, "ok");
    assert.equal(complet.json.probabiliteModele, seule.json.probabiliteModele);
    assert.equal(s.w.ai.calls.length, 1);
    // Le quota IA n'a servi que pour cette dernière demande (1 sur 3) : deux autres passent, la quatrième est refusée.
    assert.equal((await s.call("/api/analyze", { method: "POST", body: { legs: [leg, leg] } })).status, 200);
    assert.equal((await s.call("/api/analyze", { method: "POST", body: leg })).status, 429);
    // Seul `false` désactive l'IA : une valeur quelconque n'a pas cet effet.
    s.w.clock.t += 61000;
    const autre = await s.call("/api/analyze", { method: "POST", body: { ...leg, ia: "non" } });
    assert.equal(autre.json.ia.statut, "ok");
  } finally {
    await s.close();
  }
});

test("POST /api/analyze avec ia:false : IA désactivée sur le serveur = « desactivee », pas « non_demandee »", async () => {
  const s = await start({ aiBehaviour: "off" });
  try {
    const r = await s.call("/api/analyze", { method: "POST", body: { equipe1: "Arsenal", equipe2: "Chelsea", typePari: "Match nul", ia: false } });
    assert.equal(r.json.etat, "ok");
    assert.equal(r.json.ia.statut, "desactivee");
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

test("GET /api/backtest : réglages d'essai bornés et signalés, valeurs illisibles ignorées", async () => {
  const s = await start({ aiBehaviour: "off" });
  try {
    const r = await s.call("/api/backtest?pas=14&echelle=9&exposant=0.7&demiVie=200&niveauDemiVie=60&rho=abc&exposantRythme=0.4&exposantForce=5");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.essai, { halfLifeDays: 200, levelHalfLifeDays: 60, strengthExponent: 0.7, qualityExponent: 1.3, rhythmExponent: 0.4, levelFactor: 1.3 });
    assert.equal(r.json.parametres.pasEnJours, 14);
    assert.equal(r.json.parametres.modele.coefficientDeNiveau, 1.3);
    assert.equal(r.json.parametres.modele.demiVieJours, 200);
    assert.equal(r.json.parametres.modele.exposantRythme, 0.4);
    assert.equal(r.json.parametres.modele.exposantForce, 1.3);
    assert.equal(r.json.reglages.halfLifeDays, 300, "les réglages du serveur ne sont pas modifiés par un essai");
    const plain = await s.call("/api/backtest");
    assert.equal(plain.json.essai, undefined);
    assert.equal(plain.json.parametres.modele.coefficientDeNiveau, 1);
    assert.equal(plain.json.parametres.modele.exposantRythme, 0.5, "sans paramètre, le contrôle utilise la correction en service sur le serveur");
    assert.equal(plain.json.parametres.pasEnJours, 7);
    assert.ok(plain.json.butsParMatch.prevus > 0);
  } finally {
    await s.close();
  }
});

test("GET /api/backtest : par défaut avec la correction en service ; « exposantRythme=1&echelle=1 » donne le modèle d'avant", async () => {
  const s = await start({ aiBehaviour: "off" });
  try {
    s.w.data.setModelParams({ levelFactor: 1.04 });
    const now = (await s.call("/api/backtest")).json;
    assert.deepEqual([now.parametres.modele.exposantRythme, now.parametres.modele.coefficientDeNiveau], [0.5, 1.04]);
    assert.equal(now.reglages.rhythmExponent, 0.5);
    assert.equal(now.reglages.levelFactor, 1.04);
    const before = (await s.call("/api/backtest?exposantRythme=1&echelle=1")).json;
    assert.deepEqual([before.parametres.modele.exposantRythme, before.parametres.modele.coefficientDeNiveau], [1, 1]);
    assert.deepEqual(before.essai, { rhythmExponent: 1, levelFactor: 1 });
    assert.ok(now.butsParMatch.prevus > before.butsParMatch.prevus, "le coefficient relève les buts prévus");
    assert.equal(before.reglages.levelFactor, 1.04, "les réglages en service restent indiqués à part");
  } finally {
    await s.close();
  }
});

test("GET /api/backtest : un rapport gardé en mémoire ne survit pas à un changement de réglage du modèle", async () => {
  const s = await start({ aiBehaviour: "off" });
  try {
    const first = (await s.call("/api/backtest")).json;
    assert.equal(first.reglages.levelFactor, 1);
    s.w.data.setModelParams({ levelFactor: 1.1 });
    const second = (await s.call("/api/backtest")).json;
    assert.equal(second.reglages.levelFactor, 1.1);
    assert.ok(second.butsParMatch.prevus > first.butsParMatch.prevus * 1.05, `${second.butsParMatch.prevus} contre ${first.butsParMatch.prevus}`);
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

// ---- Coupes d'Europe, championnats complémentaires, clubs de coupe seulement ----

test("GET /api/teams : les clubs connus seulement par une coupe sont rangés sous « EUR », les coupes ne figurent pas comme championnats", async () => {
  const s = await start({ cups: true, keys: ["PL", "PD", "SA", "ELC"], aiBehaviour: "off" });
  try {
    await s.w.data.ensureAll({ scope: "essential" });
    const early = (await s.call("/api/teams")).json;
    assert.equal(early.complet, false, "un championnat complémentaire est encore en cours de chargement");
    await s.w.data.ensureAll({ scope: "all" });
    const r = (await s.call("/api/teams")).json;
    assert.equal(r.complet, true);
    assert.deepEqual(r.championnats.map((c) => [c.key, c.niveau, c.charge]), [["PL", "principal", true], ["PD", "principal", true], ["SA", "principal", true], ["ELC", "complementaire", true], ["EUR", "complementaire", true]]);
    assert.equal(r.championnats.find((c) => c.key === "EUR").nom, "Autres clubs européens");
    assert.ok(!r.championnats.some((c) => c.key === "UCL"), "une coupe n'est pas un championnat d'origine");
    const lonely = r.equipes.filter((e) => e.championnat === "EUR").map((e) => e.nom);
    assert.deepEqual(lonely.sort(), ["Dinamo Imaginaire", "Olimpija Fictive", "Slovan Inventé", "Sparta Fictif"]);
    assert.equal(r.equipes.find((e) => e.nom === "Leeds United FC").championnat, "ELC");
    assert.equal(r.equipes.length, 48 + 4);
    const names = r.equipes.map((e) => e.nom);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "fr")));
    assert.equal(new Set(names).size, names.length, "aucun club en double");
  } finally {
    await s.close();
  }
});

test("GET /api/teams : un championnat complémentaire en échec ne rend pas la liste incomplète, un principal ou une coupe si", async () => {
  const extraDown = await start({ cups: true, keys: ["PL", "PD", "SA", "ELC"], failing: ["ELC"], aiBehaviour: "off" });
  try {
    await extraDown.w.data.ensureAll({ scope: "all" });
    const r = (await extraDown.call("/api/teams")).json;
    assert.equal(r.complet, true);
    assert.deepEqual(r.championnats.find((c) => c.key === "ELC"), { key: "ELC", nom: "Championship", pays: "Angleterre (2e division)", niveau: "complementaire", charge: false });
  } finally {
    await extraDown.close();
  }
  const cupDown = await start({ cups: true, failing: ["UCL"], aiBehaviour: "off" });
  try {
    await cupDown.w.data.ensureAll({ scope: "all" });
    assert.equal((await cupDown.call("/api/teams")).json.complet, false, "la coupe fait partie de l'essentiel : sans elle, la liste est incomplète");
  } finally {
    await cupDown.close();
  }
});

test("état : les problèmes des championnats complémentaires vont dans « remarques », pas dans « avertissements »", async () => {
  const env = { FOOTBALL_DATA_API_KEY: "test-fd" };
  const s = await start({ cups: true, keys: ["PL", "PD", "SA", "ELC"], failing: ["ELC"], aiBehaviour: "off", env });
  try {
    await s.w.data.ensureAll({ scope: "essential" });
    const loading = (await s.call("/api/status")).json;
    assert.deepEqual(loading.avertissements, [], "les principaux et la coupe sont prêts");
    assert.deepEqual(loading.remarques, ["Chargement en cours : 1 championnat(s) complémentaire(s) pas encore prêt(s)."]);
    await s.w.data.ensureAll({ scope: "extras" });
    const down = (await s.call("/api/status")).json;
    assert.deepEqual(down.avertissements, []);
    assert.equal(down.remarques.length, 1);
    assert.match(down.remarques[0], /^Chargement impossible \(Championship\) : .*source en panne/);
    const elc = down.donnees.championnats.find((c) => c.key === "ELC");
    assert.deepEqual([elc.type, elc.niveau, elc.etat], ["championnat", "complementaire", "echec"]);
  } finally {
    await s.close();
  }
  // à l'inverse, un championnat principal ou une coupe en panne reste un avertissement
  const main = await start({ cups: true, failing: ["PD", "UCL"], aiBehaviour: "off", env });
  try {
    await main.w.data.ensureAll({ scope: "all" });
    const st = (await main.call("/api/status")).json;
    assert.equal(st.avertissements.length, 1);
    assert.match(st.avertissements[0], /^Chargement impossible \(Liga, Ligue des champions\)/);
    assert.deepEqual(st.remarques, []);
  } finally {
    await main.close();
  }
});

test("état : « europe » décrit le niveau mesuré de chaque championnat, et reste sobre quand la fonction est coupée", async () => {
  const on = await start({ cups: true, aiBehaviour: "off" });
  try {
    await on.w.data.ensureAll({ scope: "essential" });
    const e = (await on.call("/api/status")).json.europe;
    assert.equal(e.actif, true);
    assert.deepEqual(e.coupesChargees, ["UCL"]);
    assert.ok(e.matchsDeCoupeUtilises > 100);
    assert.deepEqual(Object.keys(e.niveauxDesChampionnats[0]).sort(), ["key", "matchsDeCoupe", "mesure", "niveauAPriori", "niveauEstime", "nom"]);
    assert.ok(!JSON.stringify(e).includes("test-key"));
  } finally {
    await on.close();
  }
  const off = await start({ cups: true, aiBehaviour: "off", env: { EUROPE_ENABLED: "off" } });
  try {
    assert.deepEqual((await off.call("/api/status")).json.europe, { actif: false });
    const leagues = (await off.call("/api/leagues")).json.championnats;
    assert.equal(leagues.find((c) => c.key === "UCL"), undefined, "la coupe n'est plus suivie, ni même présentée");
    assert.ok(leagues.some((c) => c.key === "ELC"), "les championnats complémentaires, eux, sont toujours là");
  } finally {
    await off.close();
  }
});

test("interrupteurs coupés : /api/leagues et /api/status présentent la liste d'avant les coupes d'Europe et des championnats complémentaires", async () => {
  const ORIGINAL = ["PL", "PD", "SA", "BL1", "FL1", "PPL", "DED", "BSA", "SPL", "BJL"];
  const allOff = await start({ cups: true, aiBehaviour: "off", env: { EUROPE_ENABLED: "off", EXTRA_LEAGUES_ENABLED: "off" } });
  try {
    const leagues = (await allOff.call("/api/leagues")).json.championnats;
    assert.deepEqual(leagues.map((c) => c.key), ORIGINAL);
    assert.ok(leagues.every((c) => c.type === "championnat" && c.niveau === "principal"));
    const status = (await allOff.call("/api/status")).json.donnees.championnats;
    assert.deepEqual(status.map((c) => c.key), ORIGINAL);
  } finally {
    await allOff.close();
  }
  const cupsOnly = await start({ cups: true, aiBehaviour: "off", env: { EXTRA_LEAGUES_ENABLED: "off" } });
  try {
    const keys = (await cupsOnly.call("/api/leagues")).json.championnats.map((c) => c.key);
    assert.deepEqual(keys, [...ORIGINAL, "UCL", "UEL", "UECL"]);
  } finally {
    await cupsOnly.close();
  }
  const allOn = await start({ cups: true, aiBehaviour: "off" });
  try {
    const rows = (await allOn.call("/api/leagues")).json.championnats;
    assert.equal(rows.length, require("../src/leagues").LEAGUES.length, "tout activé : toutes les entrées, couvertes ou non");
    assert.equal(rows.find((c) => c.key === "UEL").couvert, false);
  } finally {
    await allOn.close();
  }
});

test("POST /api/analyze : un match de Ligue des champions entre deux championnats, avec l'avertissement de comparaison", async () => {
  const s = await start({ cups: true });
  try {
    const r = await s.call("/api/analyze", { method: "POST", body: { equipe1: "Arsenal", equipe2: "Real Madrid", typePari: "Victoire ou nul domicile" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.etat, "ok");
    assert.equal(r.json.competition, "Ligue des champions");
    assert.equal(r.json.comparaisonEntreChampionnats.championnat1, "Premier League");
    assert.match(r.json.comparaisonEntreChampionnats.message, /moins précise/);
    const batch = await s.call("/api/analyze", { method: "POST", body: { legs: [{ equipe1: "Arsenal", equipe2: "Chelsea", typePari: "Match nul" }, { equipe1: "Dinamo Imaginaire", equipe2: "Sparta Fictif", typePari: "Match nul" }, { equipe1: "Arsenal", equipe2: "Zzz Inconnu", typePari: "Match nul" }] } });
    assert.deepEqual(batch.json.legs.map((l) => l.etat), ["ok", "ok", "equipe_inconnue"]);
    assert.equal(batch.json.legs[0].comparaisonEntreChampionnats, undefined);
    assert.ok(batch.json.legs[1].comparaisonEntreChampionnats);
  } finally {
    await s.close();
  }
});

test("POST /api/auto-coupon : un coupon mêlant championnat, coupe d'Europe et club de coupe seulement", async () => {
  const s = await start({ cups: true, aiBehaviour: "off" });
  try {
    const r = await s.call("/api/auto-coupon", { method: "POST", body: { matches: [{ equipe1: "Arsenal", equipe2: "Chelsea" }, { equipe1: "Juventus", equipe2: "Chelsea" }, { equipe1: "Dinamo Imaginaire", equipe2: "Liverpool" }] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.resultats.map((x) => x.etat), ["ok", "ok", "ok"]);
    assert.deepEqual(r.json.resultats.map((x) => Boolean(x.comparaisonEntreChampionnats)), [false, true, true]);
    assert.deepEqual(r.json.resultats.map((x) => x.competition), ["Premier League", "Ligue des champions", "Ligue des champions"]);
    assert.equal(r.json.analyses, 3);
    assert.ok(Number(r.json.coteTotale) > 1);
  } finally {
    await s.close();
  }
});

test("GET /api/top-matches : indique les coupes prises en compte", async () => {
  const s = await start({ cups: true, aiBehaviour: "off", fixtureHours: [] });
  try {
    const r = await s.call("/api/top-matches");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.donnees.coupesPretes, ["UCL"]);
    assert.ok(r.json.topMatches.every((m) => m.competition === "Ligue des champions" && m.comparaisonEntreChampionnats));
  } finally {
    await s.close();
  }
});

test("GET /api/backtest : par défaut les championnats principaux, un championnat complémentaire sur demande, jamais une coupe", async () => {
  const s = await start({ cups: true, keys: ["PL", "PD", "SA", "ELC"], aiBehaviour: "off" });
  try {
    const all = await s.call("/api/backtest");
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.parChampionnat.map((c) => c.championnat).sort(), ["PD", "PL", "SA"]);
    const elc = await s.call("/api/backtest?championnat=elc");
    assert.equal(elc.status, 200);
    assert.deepEqual(elc.json.parChampionnat.map((c) => c.championnat), ["ELC"]);
    assert.equal((await s.call("/api/backtest?championnat=UCL")).status, 404);
  } finally {
    await s.close();
  }
});
