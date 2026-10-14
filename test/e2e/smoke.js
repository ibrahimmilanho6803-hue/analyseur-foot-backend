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
  // 8 championnats nationaux + la Ligue des champions + le Championship (football-data.org) : les complémentaires arrivent en dernier.
  // (Le serveur limite à 90 requêtes par minute : on interroge sans insister.)
  let st;
  for (let i = 0; i < 100; i++) {
    st = (await get("/api/status")).json;
    const covered = st.donnees && st.donnees.championnats.filter((c) => c.couvert);
    if (covered && covered.length === 10 && covered.every((c) => c.charge)) break;
    await sleep(700);
  }
  const covered = st.donnees.championnats.filter((c) => c.couvert);
  assert.equal(covered.length, 10, "10 compétitions couvertes par football-data.org");
  assert.ok(covered.every((c) => c.charge), `toutes sont chargées : ${JSON.stringify(covered.filter((c) => !c.charge).map((c) => [c.key, c.etat, c.derniereErreur]))}`);
  assert.deepEqual(covered.filter((c) => c.type === "coupe").map((c) => c.key), ["UCL"]);
  assert.deepEqual(covered.filter((c) => c.niveau === "complementaire").map((c) => c.key), ["ELC"]);
  assert.deepEqual(st.avertissements, []);
  console.log("✔ démarrage et chargement : 8 championnats, la Ligue des champions et un championnat complémentaire");

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
  assert.equal(teams.json.equipes.find((t) => t.nom === "Leeds United FC").championnat, "ELC", "le championnat complémentaire est dans la liste");
  assert.ok(!teams.json.championnats.some((c) => c.key === "UCL"), "la Ligue des champions n'est pas un championnat d'origine");
  assert.equal(new Set(teams.json.equipes.map((t) => t.nom)).size, teams.json.equipes.length, "aucun club en double entre championnats et coupe");
  console.log(`✔ liste des clubs : ${teams.json.equipes.length} clubs, ${teams.json.championnats.length} championnats`);

  // Ligue des champions et clubs de championnats différents : le niveau relatif des championnats vient des matchs de coupe.
  const eu = (await get("/api/status")).json.europe;
  assert.equal(eu.actif, true);
  assert.deepEqual(eu.coupesChargees, ["UCL"]);
  assert.ok(eu.matchsDeCoupeUtilises > 100, `${eu.matchsDeCoupeUtilises} matchs de coupe`);
  const mesures = eu.niveauxDesChampionnats.filter((l) => l.mesure).map((l) => l.key);
  assert.ok(["PL", "PD", "SA", "BL1", "FL1", "PPL", "DED"].every((k) => mesures.includes(k)), `championnats mesurés : ${mesures}`);
  const lvl = (k) => eu.niveauxDesChampionnats.find((l) => l.key === k).niveauEstime;
  assert.ok(lvl("PL") > lvl("PPL") + 0.2 && lvl("PL") > lvl("DED") + 0.2, "la Premier League est jugée plus forte que le Portugal et les Pays-Bas");
  const cl = await get("/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ equipe1: "Arsenal", equipe2: "Real Madrid", typePari: "Victoire ou nul domicile" }) });
  assert.equal(cl.json.etat, "ok");
  assert.equal(cl.json.competition, "Ligue des champions");
  assert.ok(Date.parse(cl.json.date) > Date.now());
  assert.equal(cl.json.comparaisonEntreChampionnats.niveauDesChampionnatsMesure, true);
  assert.notEqual(cl.json.niveauConfiance, "eleve");
  console.log(`✔ Ligue des champions Arsenal–Real Madrid : ${cl.json.probabilite} % (confiance ${cl.json.niveauConfiance}, ${cl.json.comparaisonEntreChampionnats.championnat1} contre ${cl.json.comparaisonEntreChampionnats.championnat2})`);

  // N'importe quel match dans « Mon coupon » et dans « Auto » : championnat, coupe, deux championnats sans match de coupe prévu, 2e division.
  const mix = [
    { equipe1: "Arsenal", equipe2: "Chelsea" },
    { equipe1: "Arsenal", equipe2: "Real Madrid" },
    { equipe1: "Chelsea", equipe2: "FC Barcelona" },
    { equipe1: "Leeds United", equipe2: "Leicester City" },
    { equipe1: "Arsenal", equipe2: "Leeds United" },
  ];
  const auto = await get("/api/auto-coupon", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ matches: mix }) });
  assert.equal(auto.status, 200);
  assert.deepEqual(auto.json.resultats.map((r) => r.etat), ["ok", "ok", "ok", "ok", "ok"], JSON.stringify(auto.json.resultats.map((r) => r.message)));
  assert.deepEqual(auto.json.resultats.map((r) => Boolean(r.comparaisonEntreChampionnats)), [false, true, true, false, true]);
  assert.deepEqual(auto.json.resultats.map((r) => r.competition), ["Premier League", "Ligue des champions", "Match entre clubs de championnats différents", "Championship", "Match entre clubs de championnats différents"]);
  assert.equal(auto.json.analyses, 5);
  const mon = await get("/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ legs: mix.map((m) => ({ ...m, typePari: "Plus de 1.5 buts" })) }) });
  assert.deepEqual(mon.json.legs.map((r) => r.etat), ["ok", "ok", "ok", "ok", "ok"]);
  console.log(`✔ n'importe quel match : coupon automatique à ${auto.json.resultats.length} matchs (cote ${auto.json.coteTotale}), « Mon coupon » identique`);

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
