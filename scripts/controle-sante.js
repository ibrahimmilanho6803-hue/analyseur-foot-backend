#!/usr/bin/env node
"use strict";

// Contrôle de santé de l'API en production.
//
//   node scripts/controle-sante.js [adresse] [--sans-test] [--essais=3] [--attente=60]
//
// Vérifie que le serveur répond, que les données des championnats principaux et des coupes d'Europe sont chargées et récentes, que
// l'IA n'est ni en pause ni bloquée (clé refusée, crédit épuisé, modèle introuvable) et que le budget quotidien d'appels n'est pas
// épuisé. Les championnats complémentaires (voir src/leagues.js) ne déclenchent jamais d'alerte : leurs problèmes sont seulement
// signalés en remarque. Sauf avec --sans-test, il fait aussi de vraies analyses de bout en bout (deux clubs d'un même championnat, puis
// deux clubs de championnats différents quand la comparaison entre championnats est active ; pari « Score exact » : aucun appel à l'IA, aucun coût).
// Code de sortie : 0 = tout va bien, 1 = au moins un problème (affiché en clair). Lancé toutes les 6 heures par
// .github/workflows/surveillance.yml ; GitHub prévient par e-mail quand une exécution échoue.

const DEFAULT_URL = "https://analyseur-foot-api.onrender.com";
const BLOCKING_AI_ERRORS = new Set(["AUTH", "BILLING", "MODEL"]);
const MAX_DATA_AGE_MIN = 180; // le serveur rafraîchit les données toutes les 25 minutes
const BUDGET_NOTE_RATIO = 0.8;

const time = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

// Analyse la réponse de /api/status. Renvoie { problems, notes } : « problems » vide = tout va bien.
function evaluateStatus(st) {
  const problems = [];
  const notes = [];
  if (!st || typeof st !== "object" || Array.isArray(st)) return { problems: ["La réponse de /api/status est illisible."], notes };

  // « avertissements » vide veut dire : tout l'essentiel est chargé, à jour, clés présentes (voir src/app.js).
  for (const w of Array.isArray(st.avertissements) ? st.avertissements : []) problems.push(`Avertissement du serveur : ${w}`);
  for (const r of Array.isArray(st.remarques) ? st.remarques : []) notes.push(`Championnats complémentaires : ${r}`);

  const ia = st.ia && typeof st.ia === "object" ? st.ia : {};
  if (ia.active === false) problems.push("L'IA est inactive sur le serveur (clé absente ou AI_ENABLED=false) : seul le modèle statistique répond.");
  const err = ia.derniereErreur;
  const detail = err ? ` (${err.code} : ${err.message})` : "";
  // (« pauseJusquA » n'est renseigné par le serveur que tant que la pause dure.)
  if (ia.pauseJusquA) problems.push(`L'IA est en pause jusqu'à ${ia.pauseJusquA}${detail}.`);
  // Une erreur de clé, de crédit ou de modèle reste affichée même après réparation : elle ne compte que si aucun appel n'a réussi depuis.
  if (err && BLOCKING_AI_ERRORS.has(err.code) && !(time(ia.dernierSucces) > time(err.le))) {
    problems.push(`Erreur de l'IA non résolue${detail} : ${err.code === "BILLING" ? "recharger le crédit du compte Anthropic" : err.code === "AUTH" ? "vérifier ANTHROPIC_API_KEY sur Render" : "vérifier ANTHROPIC_MODEL sur Render"}.`);
  }
  if (ia.budgetJournalier > 0 && Number.isFinite(ia.appelsAujourdhui)) {
    const ratio = ia.appelsAujourdhui / ia.budgetJournalier;
    if (ratio >= 1) problems.push(`Budget quotidien d'appels à l'IA atteint (${ia.appelsAujourdhui}/${ia.budgetJournalier}) : l'IA est coupée jusqu'à demain ou jusqu'à AI_DAILY_BUDGET_CALLS plus haut.`);
    else if (ratio >= BUDGET_NOTE_RATIO) notes.push(`Budget d'appels à l'IA consommé à ${Math.round(ratio * 100)} % (${ia.appelsAujourdhui}/${ia.budgetJournalier}).`);
  }

  const covered = ((st.donnees && st.donnees.championnats) || []).filter((c) => c && c.couvert);
  if (!covered.length) problems.push("Aucun championnat suivi dans /api/status.");
  else if (!covered.some((c) => c.etat === "pret")) problems.push("Aucun championnat n'est chargé.");
  for (const c of covered) {
    if (c.niveau === "complementaire") continue; // chargé en dernier, sans gravité s'il manque ou vieillit
    if (c.etat === "pret" && Number.isFinite(c.ageMinutes) && c.ageMinutes > MAX_DATA_AGE_MIN) {
      problems.push(`${c.nom} : données vieilles de ${Math.round(c.ageMinutes / 60)} h alors que le serveur les rafraîchit toutes les 25 minutes.`);
    }
  }
  return { problems, notes };
}

async function getJson(fetchImpl, url, { timeoutMs = 45000, ...init } = {}) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    json = null;
  }
  return { status: res.status, json };
}

// Une analyse sans IA (pari « Score exact ») ; renvoie la réponse du serveur ou un problème lisible.
async function tryAnalysis(fetchImpl, base, one, two, what) {
  const r = await getJson(fetchImpl, `${base}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ equipe1: one, equipe2: two, typePari: "Score exact", ia: false }),
  });
  if (r.status !== 200 || !r.json) return { problem: `${what} (${one} – ${two}) répond HTTP ${r.status}.` };
  if (r.json.etat !== "ok" || !(r.json.probabilite > 0)) return { problem: `${what} (${one} – ${two}) n'a pas abouti : ${r.json.etat || "réponse vide"}.` };
  return { json: r.json };
}

// Analyses complètes sans IA : deux clubs d'un même championnat chargé, puis (si `cross`) deux clubs de championnats différents.
async function smokeTest(fetchImpl, base, { cross = false } = {}) {
  const teams = await getJson(fetchImpl, `${base}/api/teams`);
  if (teams.status !== 200 || !teams.json) return [`/api/teams répond HTTP ${teams.status}.`];
  const loaded = (teams.json.championnats || []).filter((c) => c.charge).map((c) => c.key);
  const pairIn = (key) => (teams.json.equipes || []).filter((t) => t.championnat === key).slice(0, 2);
  for (const key of loaded) {
    const pair = pairIn(key);
    if (pair.length < 2) continue;
    const first = await tryAnalysis(fetchImpl, base, pair[0].nom, pair[1].nom, "L'analyse d'essai");
    if (first.problem) return [first.problem];
    if (!cross) return [];
    // Comparaison entre championnats : un club de ce championnat contre un club d'un autre championnat chargé.
    for (const other of loaded) {
      if (other === key) continue;
      const rival = pairIn(other)[0];
      if (!rival) continue;
      const second = await tryAnalysis(fetchImpl, base, pair[0].nom, rival.nom, "L'analyse d'essai entre deux championnats");
      if (second.problem) return [second.problem];
      if (!second.json.comparaisonEntreChampionnats) return [`L'analyse d'essai entre deux championnats (${pair[0].nom} – ${rival.nom}) ne signale pas la comparaison entre championnats.`];
      return [];
    }
    return [];
  }
  return ["Aucune paire de clubs trouvée dans /api/teams pour l'analyse d'essai."];
}

// Une série de vérifications. Ne lève jamais d'erreur : tout échec devient un « problème » lisible.
async function checkOnce({ base, fetchImpl, smoke }) {
  const problems = [];
  let notes = [];
  try {
    const health = await getJson(fetchImpl, `${base}/health`);
    if (health.status !== 200 || !health.json || health.json.ok !== true) {
      return { problems: [`Le serveur répond mal (/health : HTTP ${health.status}).`], notes };
    }
  } catch (e) {
    return { problems: [`Le serveur ne répond pas (${e && e.name === "TimeoutError" ? "délai dépassé" : e && e.message ? e.message : "erreur réseau"}).`], notes };
  }
  let cross = false;
  try {
    const status = await getJson(fetchImpl, `${base}/api/status`);
    if (status.status !== 200) problems.push(`/api/status répond HTTP ${status.status}.`);
    else {
      const out = evaluateStatus(status.json);
      problems.push(...out.problems);
      notes = out.notes;
      cross = Boolean(status.json && status.json.europe && status.json.europe.actif);
    }
  } catch (e) {
    problems.push(`/api/status est injoignable (${e && e.message ? e.message : "erreur réseau"}).`);
  }
  if (smoke) {
    try {
      problems.push(...(await smokeTest(fetchImpl, base, { cross })));
    } catch (e) {
      problems.push(`L'analyse d'essai a échoué (${e && e.message ? e.message : "erreur réseau"}).`);
    }
  }
  return { problems, notes };
}

// Plusieurs essais espacés : un redémarrage du serveur (chargement des championnats : 1 à 2 minutes) ne doit pas déclencher d'alerte.
async function controle({ base = DEFAULT_URL, fetchImpl = globalThis.fetch, sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 3, delayMs = 60000, smoke = true, log = () => {} } = {}) {
  const url = String(base).replace(/\/+$/, "");
  let last = { problems: [], notes: [] };
  for (let i = 1; i <= attempts; i++) {
    last = await checkOnce({ base: url, fetchImpl, smoke });
    if (!last.problems.length) return { ok: true, essais: i, ...last };
    if (i < attempts) {
      log(`Essai ${i}/${attempts} : ${last.problems.length} problème(s) (${last.problems[0]}) — nouvel essai dans ${Math.round(delayMs / 1000)} s.`);
      await sleepImpl(delayMs);
    }
  }
  return { ok: false, essais: attempts, ...last };
}

function parseArgs(argv, env = {}) {
  const out = { base: env.API_URL || DEFAULT_URL, smoke: true, attempts: 3, delayMs: 60000 };
  for (const a of argv) {
    if (a === "--sans-test") out.smoke = false;
    else if (/^--essais=\d+$/.test(a)) out.attempts = Math.min(10, Math.max(1, Number(a.split("=")[1])));
    else if (/^--attente=\d+$/.test(a)) out.delayMs = Math.min(600, Number(a.split("=")[1])) * 1000;
    else if (/^https?:\/\//.test(a)) out.base = a;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2), process.env);
  const onGithub = process.env.GITHUB_ACTIONS === "true";
  console.log(`Contrôle de ${opts.base}`);
  const r = await controle({ ...opts, log: (m) => console.log(m) });
  for (const n of r.notes) console.log(`Remarque : ${n}`);
  if (r.ok) {
    console.log(`Tout va bien (essai ${r.essais}).`);
    return 0;
  }
  for (const p of r.problems) {
    console.error(onGithub ? `::error title=Analyseur Foot Pro::${p}` : `PROBLÈME : ${p}`);
  }
  return 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`Erreur inattendue : ${e && e.message}`);
      process.exit(1);
    }
  );
}

module.exports = { evaluateStatus, checkOnce, controle, parseArgs, DEFAULT_URL };
