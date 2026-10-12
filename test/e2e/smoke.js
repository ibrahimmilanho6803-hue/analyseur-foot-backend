"use strict";

// Démarre le vrai server.js avec de faux services et vérifie les routes principales.
// Usage : npm run e2e
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
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

  // Analyse rapide sans IA : le modèle seul, sans entamer le quota ni le budget de l'IA.
  const appelsAvant = (await get("/api/status")).json.ia.appelsAujourdhui;
  const rapide = await get("/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ equipe1: "Arsenal", equipe2: "Chelsea", typePari: "Les deux équipes marquent", ia: false }) });
  assert.equal(rapide.json.etat, "ok");
  assert.equal(rapide.json.ia.statut, "non_demandee");
  assert.equal(rapide.json.probabilite, rapide.json.probabiliteModele);
  assert.equal((await get("/api/status")).json.ia.appelsAujourdhui, appelsAvant, "aucun appel à l'IA");
  console.log(`✔ analyse rapide sans IA : ${rapide.json.probabilite} % (aucun appel à l'IA)`);

  // Liste des clubs pour les suggestions de saisie : chaque club est retrouvé par son nom officiel.
  const teams = await get("/api/teams");
  assert.equal(teams.status, 200);
  assert.equal(teams.json.complet, true);
  assert.ok(teams.json.equipes.length >= 100, `clubs : ${teams.json.equipes.length}`);
  assert.ok(teams.json.equipes.find((t) => t.nom === "Arsenal FC"));
  console.log(`✔ liste des clubs : ${teams.json.equipes.length} clubs, ${teams.json.championnats.length} championnats`);

  // Le contrôle de santé (lancé toutes les 6 h en production) passe sur ce serveur en bon état, analyse d'essai comprise.
  const sante = await promisify(execFile)(process.execPath, [path.join(root, "scripts", "controle-sante.js"), base, "--essais=1", "--attente=1"], { timeout: 60000 });
  assert.match(sante.stdout, /Tout va bien/);
  console.log("✔ contrôle de santé : tout va bien");

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

  // Correction des totaux de buts : rythme des équipes rapproché de la moyenne, niveau de buts mesuré et ajusté par le réglage quotidien.
  const niveau = tuned.reglageAutomatique.niveauDeButs;
  assert.ok(niveau && typeof niveau.raison === "string", "le niveau de buts a été mesuré par le réglage automatique");
  assert.equal(tuned.correctionDesButs.active, true);
  assert.equal(tuned.correctionDesButs.exposantRythme, 0.5);
  assert.equal(tuned.correctionDesButs.coefficientDeNiveau, tuned.reglages.levelFactor);
  assert.ok(niveau.matchs > 100, `${niveau.matchs} matchs mesurés`);
  console.log(`✔ correction des totaux de buts : ${niveau.raison} (coefficient ${tuned.reglages.levelFactor}, rythme ramené à ${tuned.reglages.rhythmExponent})`);

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
