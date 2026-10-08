"use strict";

const { clamp, round, norm, redact } = require("./util");

// Intégration de Claude Sonnet 5.5 (API Messages).
// Rôle : relire l'analyse chiffrée du modèle statistique, l'expliquer en français et, seulement
// s'il connaît un facteur concret, la corriger de quelques points. L'IA ne fabrique pas les
// probabilités : elles viennent du modèle ; si l'IA est indisponible, le résultat reste valable.

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const CONFIDENCE = ["eleve", "moyen", "faible"];

const SCHEMA = {
  type: "object",
  properties: {
    ajustement_points: {
      type: "number",
      description: "Correction de la probabilité du modèle, en points de pourcentage, de -4 à 4. 0 si aucun facteur concret et fiable.",
    },
    confiance: { type: "string", enum: CONFIDENCE, description: "Confiance dans ce pari." },
    justification: { type: "string", description: "Une à deux phrases en français qui expliquent ce pari, appuyées sur les chiffres fournis." },
    vigilance: { type: "string", description: "Un point de vigilance concret, ou une chaîne vide s'il n'y en a pas." },
  },
  required: ["ajustement_points", "confiance", "justification", "vigilance"],
  additionalProperties: false,
};

const SYSTEM = [
  "Tu relis l'analyse chiffrée d'un outil de pronostics football.",
  "Le modèle statistique (buts attendus, forme, bilans) est la référence : tu ne le remplaces pas.",
  "Tu peux corriger sa probabilité de quelques points seulement si tu connais un facteur concret et fiable que les chiffres ne voient pas (rivalité, enjeu du match, style de jeu connu).",
  "N'invente jamais un fait : aucune blessure, composition, suspension ou résultat dont tu n'es pas certain. Dans le doute, l'ajustement est 0.",
  "Réponds en français, clairement et en deux phrases au maximum pour la justification.",
].join(" ");

const pct = (x) => `${Math.round(x * 100)} %`;

function line(name, v, label) {
  if (!v || !v.played) return null;
  return `${name} ${label} (${v.played} derniers) : ${v.won}V ${v.draw}N ${v.lost}D, ${v.avgGoalsFor} but(s) marqué(s) et ${v.avgGoalsAgainst} encaissé(s) par match`;
}

// Texte envoyé à l'IA : uniquement des chiffres calculés par le serveur et des noms issus des données.
function buildPrompt(ctx) {
  const { home, away, competition, kickoff, bet, lh, la, outcomes, quality, stats = {} } = ctx;
  const rows = [];
  rows.push(`Match : ${home} (domicile) contre ${away} (extérieur) — ${competition || "championnat"}${kickoff ? ` — ${new Date(kickoff).toISOString().slice(0, 10)}` : ""}`);
  rows.push(`Pari étudié : ${bet.label}`);
  rows.push(`Probabilité du modèle : ${pct(bet.p)} (cote équitable ${round(1 / bet.p, 2)})`);
  rows.push(`Buts attendus : ${home} ${round(lh, 2)} — ${away} ${round(la, 2)}`);
  if (outcomes) {
    rows.push(
      `Modèle : victoire domicile ${pct(outcomes.home)}, nul ${pct(outcomes.draw)}, victoire extérieur ${pct(outcomes.away)} ; plus de 2.5 buts ${pct(outcomes.over25)} ; les deux équipes marquent ${pct(outcomes.btts)}`
    );
  }
  if (quality) {
    const label = quality.level >= 2 ? "bonne" : quality.level === 1 ? "moyenne" : "faible";
    rows.push(`Quantité de données : ${label} (${quality.nHome} matchs récents pour ${home}, ${quality.nAway} pour ${away})`);
  }
  const s1 = stats.statsEquipe1;
  const s2 = stats.statsEquipe2;
  if (s1 && s1.forme) rows.push(`Forme de ${home} (du plus récent au plus ancien) : ${s1.forme}`);
  if (s2 && s2.forme) rows.push(`Forme de ${away} (du plus récent au plus ancien) : ${s2.forme}`);
  const l1 = line(home, stats.homeAway1 && stats.homeAway1.home, "à domicile");
  const l2 = line(away, stats.homeAway2 && stats.homeAway2.away, "à l'extérieur");
  if (l1) rows.push(l1);
  if (l2) rows.push(l2);
  const h2h = stats.h2h;
  if (h2h && h2h.matches && h2h.matches.length) {
    const b = h2h.bilan;
    rows.push(`Confrontations directes récentes : ${h2h.matches.map((m) => `${m.homeTeam} ${m.score} ${m.awayTeam}`).join(" ; ")} (bilan pour ${home} : ${b.homeWins}V ${b.draws}N ${b.awayWins}D)`);
  }
  rows.push("");
  rows.push("Donne : ajustement_points (de -4 à 4), confiance (eleve, moyen ou faible), justification (une ou deux phrases pour expliquer ce pari à un parieur) et vigilance (un point concret, ou une chaîne vide).");
  return rows.join("\n");
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (e2) {
      return null;
    }
  }
}

// Valide et borne la réponse : on ne fait jamais confiance au contenu tel quel.
function parseReview(text, maxAdjust) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const clean = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const justification = clean(obj.justification, 400);
  if (!justification) return null;
  const adj = typeof obj.ajustement_points === "string" ? Number(obj.ajustement_points.replace(",", ".")) : Number(obj.ajustement_points);
  const conf = typeof obj.confiance === "string" ? norm(obj.confiance) : "";
  return {
    adjustment: Number.isFinite(adj) ? round(clamp(adj, -maxAdjust, maxAdjust), 1) : 0,
    confiance: CONFIDENCE.includes(conf) ? conf : null,
    justification,
    vigilance: clean(obj.vigilance, 240),
  };
}

// Trois formes de requête, de la plus complète à la plus simple. Si l'API refuse un paramètre (erreur 400),
// on passe à la suivante et on retient celle qui fonctionne.
function buildBody(variant, { model, effort, maxTokens, user }) {
  const body = { model, max_tokens: maxTokens, system: SYSTEM, messages: [{ role: "user", content: user }] };
  if (variant === 0) {
    body.thinking = { type: "between_tools" }; // pas de réflexion préalable : réponse rapide et peu coûteuse
    body.output_config = { effort, format: { type: "json_schema", schema: SCHEMA } };
  } else if (variant === 1) {
    body.max_tokens = maxTokens * 3; // la réflexion adaptative consomme aussi des tokens
    body.output_config = { format: { type: "json_schema", schema: SCHEMA } };
  } else {
    body.messages = [
      {
        role: "user",
        content: `${user}\n\nRéponds UNIQUEMENT par un objet JSON valide, sans texte autour, de la forme : {"ajustement_points": 0, "confiance": "moyen", "justification": "...", "vigilance": ""}`,
      },
    ];
  }
  return body;
}

const textOf = (data) =>
  (Array.isArray(data && data.content) ? data.content : [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");

function createAi({ config, http, now = Date.now, log = console }) {
  const cfg = config.anthropic;
  const effort = ["low", "medium", "high"].includes(cfg.effort) ? cfg.effort : "medium";
  const state = { variant: 0, day: "", used: 0, failures: 0, openUntil: 0, lastError: null, lastOkAt: 0, running: 0 };
  const queue = [];
  const MAX_PARALLEL = 4;

  const today = () => new Date(now()).toISOString().slice(0, 10);
  const fail = (code, message) => ({ ok: false, code, message });

  async function slot() {
    if (state.running < MAX_PARALLEL) {
      state.running++;
      return;
    }
    await new Promise((resolve) => queue.push(resolve)); // release() nous transmet son créneau
  }
  function release() {
    const next = queue.shift();
    if (next) next();
    else state.running--;
  }

  function noteFailure(code, message, openMs = 0) {
    state.lastError = { code, message: redact(message), at: now() };
    state.failures++;
    if (openMs) state.openUntil = now() + openMs;
    else if (state.failures >= 4) state.openUntil = now() + 60000;
  }

  async function callOnce(variant, ctx, timeoutMs, maxTokens) {
    const body = buildBody(variant, { model: cfg.model, effort, maxTokens, user: ctx.prompt });
    return http.postJson(API_URL, body, {
      headers: { "x-api-key": cfg.key, "anthropic-version": API_VERSION },
      timeoutMs,
      retries: 1,
    });
  }

  async function run(ctx, timeoutMs) {
    let variant = state.variant;
    let maxTokens = 700;
    let invalidTries = 0;
    for (let guard = 0; guard < 6; guard++) {
      let data;
      try {
        data = await callOnce(variant, ctx, timeoutMs, maxTokens);
      } catch (e) {
        const detail = `${e.message} ${e.detail || ""}`;
        if (e.status === 401 || e.status === 403) {
          noteFailure("AUTH", "clé Anthropic refusée", 10 * 60000);
          return fail("AUTH", "La clé Anthropic est refusée.");
        }
        if (e.status === 400 && /credit balance|billing|plans? & billing/i.test(detail)) {
          noteFailure("BILLING", "crédit Anthropic insuffisant", 10 * 60000);
          return fail("BILLING", "Le crédit du compte Anthropic est épuisé.");
        }
        if (e.status === 400 || e.status === 404 || e.status === 422) {
          if (e.status === 404 && /model/i.test(detail)) {
            noteFailure("MODEL", `modèle introuvable : ${cfg.model}`, 10 * 60000);
            return fail("MODEL", `Le modèle ${cfg.model} est introuvable.`);
          }
          if (variant < 2) {
            log.warn(`[ia] requête refusée (${e.status}) avec la forme ${variant}, essai d'une forme plus simple : ${redact(e.detail || e.message).slice(0, 200)}`);
            variant++;
            continue;
          }
          noteFailure("REQUEST", detail);
          return fail("REQUEST", "La requête à l'IA a été refusée.");
        }
        const code = e.code === "TIMEOUT" ? "TIMEOUT" : e.code === "RATE_LIMIT" ? "RATE_LIMIT" : "UNAVAILABLE";
        noteFailure(code, detail);
        return fail(code, "L'IA est momentanément indisponible.");
      }

      if (data && data.stop_reason === "refusal") return fail("REFUSAL", "L'IA a décliné de répondre à cette demande.");
      if (data && data.stop_reason === "max_tokens" && invalidTries < 1) {
        invalidTries++;
        maxTokens *= 2;
        continue;
      }
      const review = data && data.stop_reason !== "max_tokens" ? parseReview(textOf(data), cfg.maxAdjustPoints) : null;
      if (!review) {
        if (invalidTries < 1) {
          invalidTries++;
          continue;
        }
        noteFailure("INVALID_OUTPUT", "réponse de l'IA inexploitable");
        return fail("INVALID_OUTPUT", "La réponse de l'IA était inexploitable.");
      }
      state.variant = variant;
      state.failures = 0;
      state.lastOkAt = now();
      return { ok: true, ...review, variant, usage: data.usage || null };
    }
    return fail("REQUEST", "La requête à l'IA a échoué.");
  }

  // ctx : voir buildPrompt. Ne lève jamais d'erreur : renvoie { ok: true, ... } ou { ok: false, code, message }.
  async function review(ctx, { timeoutMs = cfg.timeoutMs } = {}) {
    if (!cfg.enabled) return fail("DISABLED", "L'IA n'est pas activée sur ce serveur.");
    if (now() < state.openUntil) return fail("UNAVAILABLE", state.lastError ? state.lastError.message : "IA en pause");
    const day = today();
    if (state.day !== day) {
      state.day = day;
      state.used = 0;
    }
    if (cfg.dailyBudget > 0 && state.used >= cfg.dailyBudget) return fail("BUDGET", "Le budget quotidien d'appels à l'IA est atteint.");
    state.used++;
    await slot();
    try {
      return await run({ prompt: buildPrompt(ctx) }, Math.min(timeoutMs, cfg.timeoutMs));
    } catch (e) {
      noteFailure("ERROR", e.message);
      return fail("ERROR", "Erreur inattendue lors de l'appel à l'IA.");
    } finally {
      release();
    }
  }

  function status() {
    return {
      active: cfg.enabled,
      modele: cfg.model,
      effort,
      formeDeRequete: state.variant,
      appelsAujourdhui: state.day === today() ? state.used : 0,
      budgetJournalier: cfg.dailyBudget,
      pauseJusquA: now() < state.openUntil ? new Date(state.openUntil).toISOString() : null,
      derniereErreur: state.lastError ? { code: state.lastError.code, message: state.lastError.message, le: new Date(state.lastError.at).toISOString() } : null,
      dernierSucces: state.lastOkAt ? new Date(state.lastOkAt).toISOString() : null,
    };
  }

  return { review, status, enabled: cfg.enabled };
}

module.exports = { createAi, buildPrompt, buildBody, parseReview, SCHEMA, SYSTEM, API_URL, API_VERSION };
