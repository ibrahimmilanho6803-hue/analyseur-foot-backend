#!/usr/bin/env node
"use strict";

// TEMPORAIRE — contrôle de la production après la mise en ligne de « tous les matchs » (Ligue des champions, autres championnats,
// comparaison entre championnats). Attend le déploiement, attend le chargement des données, puis fait de vraies requêtes sans IA
// (sauf « Top Matchs », déjà calculé par le serveur toutes les 5 minutes). Ce fichier vit seulement sur une branche jetable.

const BASE = (process.env.API_URL || "https://analyseur-foot-api.onrender.com").replace(/\/+$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `[+${String(Math.round((Date.now() - t0) / 1000)).padStart(4, " ")}s]`;
const out = (...a) => console.log(stamp(), ...a);
const problems = [];
const bad = (m) => {
  problems.push(m);
  console.log(stamp(), "PROBLÈME :", m);
};

async function call(path, init = {}, timeoutMs = 90000) {
  const started = Date.now();
  try {
    const res = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      json = null;
    }
    return { status: res.status, json, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, json: null, ms: Date.now() - started, error: e && e.message ? e.message : String(e) };
  }
}
const post = (path, body, timeoutMs) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, timeoutMs);

const countBy = (list, f) => list.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});

async function main() {
  out(`Contrôle de ${BASE}`);

  // 1. Attendre la nouvelle version (le champ « europe » n'existe que dans le nouveau code).
  let status = null;
  for (let i = 0; i < 60; i++) {
    const r = await call("/api/status", {}, 60000);
    const europe = r.json && r.json.europe;
    out(`/api/status → HTTP ${r.status}${r.error ? ` (${r.error})` : ""} ; europe : ${europe === undefined ? "absent (ancienne version ou serveur en réveil)" : `actif=${europe.actif}`}`);
    if (r.status === 200 && europe !== undefined) {
      status = r.json;
      break;
    }
    await sleep(20000);
  }
  if (!status) {
    bad("La nouvelle version n'est pas en ligne après 20 minutes.");
    return;
  }
  out("Nouvelle version en ligne.");

  // 2. Attendre le chargement des championnats principaux et des coupes.
  const mainReady = (st) => {
    const rows = ((st.donnees && st.donnees.championnats) || []).filter((c) => c.couvert && c.niveau === "principal");
    return rows.length > 0 && rows.every((c) => c.etat === "pret");
  };
  const cupsReady = (st) => Boolean(st.europe && st.europe.actif && Array.isArray(st.europe.coupesChargees) && st.europe.coupesChargees.includes("UCL"));
  let loadedAt = null;
  for (let i = 0; i < 40; i++) {
    const r = await call("/api/status", {}, 60000);
    if (r.status === 200 && r.json) {
      status = r.json;
      const rows = (status.donnees && status.donnees.championnats) || [];
      const byLevel = countBy(rows.filter((c) => c.couvert), (c) => `${c.niveau}:${c.etat}`);
      out(`chargement : ${JSON.stringify(byLevel)} ; coupes chargées : ${JSON.stringify(status.europe && status.europe.coupesChargees)}`);
      if (mainReady(status) && cupsReady(status)) {
        loadedAt = Date.now();
        break;
      }
    } else {
      out(`/api/status → HTTP ${r.status}${r.error ? ` (${r.error})` : ""}`);
    }
    await sleep(30000);
  }
  if (!loadedAt) bad("Les championnats principaux et la Ligue des champions ne sont pas tous chargés après 20 minutes.");

  // 3. État détaillé.
  const eu = status.europe || {};
  out("=== /api/status ===");
  out(`avertissements : ${JSON.stringify(status.avertissements)}`);
  out(`remarques : ${JSON.stringify(status.remarques)}`);
  out(`IA : ${JSON.stringify({ active: status.ia && status.ia.active, derniereErreur: status.ia && status.ia.derniereErreur, pauseJusquA: status.ia && status.ia.pauseJusquA })}`);
  out(`europe : actif=${eu.actif} ; coupes=${JSON.stringify(eu.coupesChargees)} ; matchs de coupe utilisés=${eu.matchsDeCoupeUtilises} ; clubs sans championnat suivi=${eu.clubsSansChampionnatSuivi} ; buts ext.=${eu.butsParEquipeExterieur} ; avantage dom.=${eu.avantageDomicile}`);
  for (const l of eu.niveauxDesChampionnats || []) {
    out(`   niveau ${String(l.key).padEnd(4)} ${String(l.nom).padEnd(34)} a priori ${String(l.niveauAPriori).padStart(6)} → estimé ${String(l.niveauEstime).padStart(6)} ; matchs de coupe ${String(l.matchsDeCoupe).padStart(5)} ; mesuré=${l.mesure}`);
  }
  if (!eu.actif) bad("La comparaison entre championnats n'est pas active.");
  if (!(eu.matchsDeCoupeUtilises > 0)) bad("Aucun match de coupe utilisé par le modèle entre championnats.");
  const rows = (status.donnees && status.donnees.championnats) || [];
  out(`championnats : ${rows.length} lignes ; couverts=${rows.filter((c) => c.couvert).length} ; états=${JSON.stringify(countBy(rows.filter((c) => c.couvert), (c) => c.etat))}`);
  for (const c of rows.filter((c) => !c.couvert || c.etat !== "pret")) out(`   ${c.key} ${c.nom} : couvert=${c.couvert} état=${c.etat}${c.raison ? ` (${c.raison})` : ""}${c.message ? ` — ${c.message}` : ""}`);

  // 4. Compétitions et clubs.
  const lg = await call("/api/leagues");
  const leagues = (lg.json && lg.json.championnats) || [];
  out(`=== /api/leagues === HTTP ${lg.status} ; ${leagues.length} compétitions ; ${JSON.stringify(countBy(leagues, (l) => `${l.type}/${l.niveau}/couvert=${l.couvert}`))}`);
  const tm = await call("/api/teams");
  const teams = (tm.json && tm.json.equipes) || [];
  out(`=== /api/teams === HTTP ${tm.status} ; complet=${tm.json && tm.json.complet} ; ${teams.length} clubs ; par championnat : ${JSON.stringify(countBy(teams, (t) => t.championnat))}`);
  const euro = teams.filter((t) => t.championnat === "EUR");
  out(`   clubs « Autres clubs européens » (${euro.length}) : ${euro.slice(0, 12).map((t) => t.nom).join(", ")}`);
  if (teams.length < 300) bad(`Seulement ${teams.length} clubs dans /api/teams.`);
  const nameCount = countBy(teams, (t) => t.nom);
  const dups = Object.entries(nameCount).filter(([, n]) => n > 1);
  out(`   noms de clubs en double : ${dups.length ? JSON.stringify(dups.slice(0, 15)) : "aucun"}`);

  // 5. Analyses sans IA.
  out("=== Analyses (sans IA) ===");
  const pick = (re, key) => (teams.find((t) => (!key || t.championnat === key) && re.test(t.nom)) || {}).nom;
  const ext = teams.find((t) => t.championnat === "ELC");
  const extB = teams.filter((t) => t.championnat === "ELC")[1];
  const pairs = [
    ["Arsenal", "Chelsea", "même championnat (référence)", true],
    ["Arsenal", "Real Madrid", "Ligue des champions : Premier League – Liga", true],
    ["PSG", "Bayern", "Ligue des champions : Ligue 1 – Bundesliga", true],
    ["Man City", "Inter", "Ligue des champions : Premier League – Serie A", true],
    ["Arsenal", euro[0] && euro[0].nom, "club connu seulement par une coupe", Boolean(euro[0])],
    [euro[0] && euro[0].nom, euro[1] && euro[1].nom, "deux clubs connus seulement par une coupe", Boolean(euro[1])],
    [ext && ext.nom, "Arsenal", "championnat complémentaire contre principal", Boolean(ext)],
    [ext && ext.nom, extB && extB.nom, "deux clubs du même championnat complémentaire", Boolean(extB)],
    [pick(/Boca/i), "Real Madrid", "Argentine – Liga (niveau non mesuré)", Boolean(pick(/Boca/i))],
    ["Inter Miami", "Arsenal", "club inconnu (attendu : refus clair, aucune probabilité)", false],
  ];
  for (const [a, b, what, mustWork] of pairs) {
    if (!a || !b) {
      out(`   (ignoré : ${what} — club introuvable dans la liste)`);
      continue;
    }
    for (const bet of ["Victoire domicile", "Plus de 2.5 buts"]) {
      const r = await post("/api/analyze", { equipe1: a, equipe2: b, typePari: bet, ia: false }, 120000);
      const j = r.json || {};
      const cross = j.comparaisonEntreChampionnats;
      out(`   ${what} | ${a} – ${b} | ${bet} → HTTP ${r.status} ; etat=${j.etat} ; proba=${j.probabilite} ; confiance=${j.niveauConfiance} ; buts attendus=${j.butsAttendus ? JSON.stringify(j.butsAttendus) : "-"} ; ${r.ms} ms`);
      if (cross) out(`      comparaison : ${JSON.stringify(cross)}`);
      else if (j.message) out(`      message : ${j.message}`);
      if (mustWork && (r.status !== 200 || j.etat !== "ok" || !(j.probabilite > 0))) bad(`${what} (${a} – ${b}, ${bet}) n'a pas abouti : HTTP ${r.status}, ${j.etat}.`);
      if (mustWork && /championnats différents|Ligue des champions/.test(what) && !cross) bad(`${what} (${a} – ${b}) ne porte pas de comparaison entre championnats.`);
    }
  }
  const unknown = await post("/api/analyze", { equipe1: "Inter Miami", equipe2: "Arsenal", typePari: "Victoire domicile", ia: false });
  if (unknown.json && unknown.json.probabilite != null) bad("Un club inconnu a reçu une probabilité.");

  // 6. Coupon automatique sur des matchs mélangés.
  out("=== Coupon automatique (sans IA ne se choisit pas : l'IA relit, quelques appels) ===");
  const auto = await post(
    "/api/auto-coupon",
    { matches: [{ equipe1: "Arsenal", equipe2: "Real Madrid" }, { equipe1: "PSG", equipe2: "Bayern" }, { equipe1: "Arsenal", equipe2: "Chelsea" }] },
    150000
  );
  out(`HTTP ${auto.status} ; ${auto.ms} ms`);
  console.log(JSON.stringify(auto.json, null, 1).slice(0, 4500));
  if (auto.status !== 200) bad(`Le coupon automatique répond HTTP ${auto.status}.`);

  // 7. Top Matchs.
  out("=== Top Matchs ===");
  const top = await call("/api/top-matches", {}, 180000);
  out(`HTTP ${top.status} ; ${top.ms} ms`);
  const tj = top.json || {};
  for (const m of tj.topMatches || []) {
    out(`   ${m.competition} | ${m.homeTeam} – ${m.awayTeam} | ${m.meilleurPari} | ${m.probabilite} % | confiance=${m.niveauConfiance} | comparaison=${m.comparaisonEntreChampionnats ? "oui" : "non"} | ${m.date}`);
  }
  out(`   méta : ${JSON.stringify({ nbChampionnats: tj.nbChampionnats, nbCoupes: tj.nbCoupes, fenetreHeures: tj.fenetreHeures, message: tj.message, donnees: tj.donnees, ia: tj.ia && tj.ia.statut, avertissementDonnees: tj.avertissementDonnees })}`);
  if (top.status !== 200) bad(`Top Matchs répond HTTP ${top.status}.`);

  // 8. Bilan final de l'état (championnats complémentaires en arrière-plan).
  const last = await call("/api/status", {}, 60000);
  if (last.json) {
    const rows2 = (last.json.donnees && last.json.donnees.championnats) || [];
    out(`=== Bilan === états : ${JSON.stringify(countBy(rows2.filter((c) => c.couvert), (c) => `${c.niveau}:${c.etat}`))} ; remarques : ${JSON.stringify(last.json.remarques)} ; avertissements : ${JSON.stringify(last.json.avertissements)}`);
    if (Array.isArray(last.json.avertissements) && last.json.avertissements.length) bad(`Avertissements du serveur : ${JSON.stringify(last.json.avertissements)}`);
  }
  const health = await call("/health");
  out(`/health → HTTP ${health.status} ${JSON.stringify(health.json)}`);
}

main()
  .catch((e) => bad(`Erreur inattendue : ${e && e.stack ? e.stack : e}`))
  .finally(() => {
    out(problems.length ? `TERMINÉ AVEC ${problems.length} PROBLÈME(S)` : "TERMINÉ SANS PROBLÈME");
    process.exit(problems.length ? 1 : 0);
  });
