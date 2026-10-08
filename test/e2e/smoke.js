"use strict";

// Démarre le vrai server.js avec de faux services et vérifie les routes principales.
// Usage : npm run e2e
const { spawn } = require("node:child_process");
const path = require("node:path");
const assert = require("node:assert/strict");

const PORT = 39500 + Math.floor(Math.random() * 400);
const root = path.join(__dirname, "..", "..");
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, ["-r", path.join(__dirname, "preload.js"), path.join(root, "server.js")], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    PORT: String(PORT),
    FOOTBALL_DATA_API_KEY: "fake-fd-key",
    ANTHROPIC_API_KEY: "sk-ant-fake",
    FOOTBALL_DATA_MIN_INTERVAL_MS: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

async function get(p, opts) {
  const r = await fetch(base + p, opts);
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
}

async function main() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await get("/health")).status === 200) break;
    } catch (e) {
      await sleep(100);
    }
  }
  let st;
  for (let i = 0; i < 300; i++) {
    st = (await get("/api/status")).json;
    const covered = st.donnees.championnats.filter((c) => c.couvert);
    if (covered.length === 8 && covered.every((c) => c.charge)) break;
    await sleep(200);
  }
  const covered = st.donnees.championnats.filter((c) => c.couvert);
  assert.equal(covered.length, 8, "8 championnats couverts par football-data.org");
  assert.ok(covered.every((c) => c.charge), "tous les championnats sont chargés");
  console.log("✔ démarrage et chargement des 8 championnats");

  const top = await get("/api/top-matches");
  assert.equal(top.status, 200);
  assert.equal(top.json.topMatches.length, 3);
  assert.equal(top.json.ia.statut, "ok");
  console.log(`✔ Top 3 : ${top.json.topMatches.map((m) => `${m.homeTeam}–${m.awayTeam} (${m.meilleurPari}, ${m.probabilite} %)`).join(" | ")} — cote ${top.json.coteTotale}`);

  const an = await get("/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ equipe1: "Arsenal", equipe2: "Chelsea", typePari: "Les deux équipes marquent" }) });
  assert.equal(an.status, 200);
  assert.equal(an.json.etat, "ok");
  assert.equal(an.json.ia.statut, "ok");
  console.log(`✔ analyse Arsenal–Chelsea : ${an.json.probabilite} % (modèle ${an.json.probabiliteModele} %, IA ${an.json.ajustementIA > 0 ? "+" : ""}${an.json.ajustementIA})`);

  const st2 = (await get("/api/status")).json;
  assert.equal(st2.ia.formeDeRequete, 0, "la forme de requête principale pour Sonnet 5.5 est acceptée");
  assert.equal(st2.ia.modele, "claude-sonnet-5-5");
  assert.ok(st2.ia.appelsAujourdhui >= 1 && st2.ia.dernierSucces);
  assert.equal(st2.ia.derniereErreur, null);
  console.log("✔ requête Sonnet 5.5 conforme (sortie structurée, réflexion minimale, aucun paramètre refusé)");

  assert.equal((await get("/api/analyze-simple", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 410);
  assert.equal((await get("/api/leagues", { headers: { origin: "https://evil.example" } })).status, 403);
  console.log("✔ ancienne route fermée, origines inconnues refusées");

  const bt = await get("/api/backtest");
  assert.equal(bt.status, 200);
  assert.ok(bt.json.matchsEvalues > 100);
  console.log(`✔ contrôle de fiabilité : ${bt.json.lecture}`);

  for (let i = 0; i < 60 && !(await get("/api/status")).json.modele.reglageAutomatique; i++) await sleep(500);
  const tuned = (await get("/api/status")).json.modele;
  assert.ok(tuned.reglageAutomatique, "le réglage automatique s'est exécuté");
  console.log(`✔ réglage automatique : ${tuned.reglageAutomatique.raison} (demi-vie ${tuned.reglages.halfLifeDays} j, a priori ${tuned.reglages.priorMatches})`);

  assert.ok(!out.includes("fake-fd-key") && !out.includes("sk-ant-fake"), "aucune clé dans les journaux");
  console.log("\nE2E OK");
}

main()
  .catch((e) => {
    console.error("\nÉCHEC E2E :", e.message);
    console.error("--- journal du serveur ---\n" + out);
    process.exitCode = 1;
  })
  .finally(() => child.kill("SIGTERM"));
