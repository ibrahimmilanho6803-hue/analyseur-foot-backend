"use strict";

const express = require("express");
const cors = require("cors");
const { clamp } = require("./util");
const { createLimiter } = require("./ratelimit");
const { runBacktestAsync } = require("./backtest");
const { SwrCache } = require("./cache");
const { isCup, OTHER, OTHER_KEY } = require("./leagues");
const { spellingsOf } = require("./teams");
const { version: VERSION } = require("../package.json");

// Nombre optionnel lu dans l'adresse : absent ou illisible = undefined, sinon borné.
const optNum = (v, lo, hi) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : undefined;
};

const cleanText = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

function readLeg(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const equipe1 = cleanText(raw.equipe1, 60);
  const equipe2 = cleanText(raw.equipe2, 60);
  if (!equipe1 || !equipe2) return null;
  return { equipe1, equipe2, typePari: cleanText(raw.typePari, 80) };
}

function createApp({ config, data, ai, analysis, coupons, europe = null, tuner = null, now = Date.now, log = console }) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  const general = createLimiter({ limit: config.limits.generalPerMin, now });
  const aiLimit = createLimiter({ limit: config.limits.aiPerMin, now });
  const heavy = createLimiter({ limit: 6, now });
  const backtestCache = new SwrCache({ max: 20, now });

  const originAllowed = (origin) => config.cors.origins.includes(origin) || config.cors.patterns.some((re) => re.test(origin));

  // ---- Sécurité de base ----
  app.use((req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
    next();
  });
  app.get("/health", (req, res) => res.json({ ok: true, version: VERSION, uptimeSec: Math.round(process.uptime()) }));

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin)) return res.status(403).json({ error: "Origine non autorisée.", origine: origin });
    next();
  });
  app.use(cors({ origin: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type"], maxAge: 86400 }));

  const consume = (limiter, req, res, cost = 1) => {
    const r = limiter.consume(req.ip || "inconnu", cost);
    if (!r.ok) {
      res.set("Retry-After", String(r.retryAfterSec));
      res.status(429).json({ error: `Trop de demandes : réessayez dans ${r.retryAfterSec} s.`, reessayerDansSecondes: r.retryAfterSec });
      return false;
    }
    return true;
  };

  app.use("/api", (req, res, next) => (consume(general, req, res) ? next() : undefined));
  app.use(express.json({ limit: config.limits.bodyLimit }));

  // ---- Informations ----
  app.get("/", (req, res) => res.json({ service: "Analyseur Foot Pro — API", version: VERSION, etat: "/api/status" }));

  // type : « championnat » ou « coupe » (Ligue des champions…) ; niveau : « principal » ou « complementaire » (chargé ensuite, sert aux
  // matchs saisis à la main mais pas au « Top Matchs »).
  app.get("/api/leagues", (req, res) => {
    const covered = new Set(data.leagues.map((l) => l.key));
    res.json({
      championnats: data.listed.map((l) => ({
        key: l.key,
        nom: l.name,
        pays: l.country,
        type: isCup(l) ? "coupe" : "championnat",
        niveau: l.tier === "core" ? "principal" : "complementaire",
        couvert: covered.has(l.key),
      })),
    });
  });

  // Clubs connus et leurs écritures courantes (« PSG », « Man City »…) : sert aux suggestions pendant la saisie sur le site.
  // « complet » reste faux tant qu'un championnat n'est pas chargé : le site ne garde alors cette liste que quelques minutes.
  // Les clubs connus seulement par une coupe d'Europe (aucun championnat suivi) sont rangés sous la clé « EUR ».
  // « complet » : tous les championnats principaux et coupes sont chargés et aucun championnat complémentaire ne l'est encore en cours
  // (un complémentaire en échec ne bloque pas : il serait sinon redemandé sans fin).
  app.get("/api/teams", (req, res) => {
    const teams = data.allTeams();
    const equipes = teams.map((t) => ({ nom: t.name, championnat: t.leagueKey, noms: spellingsOf(t) })).sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
    const championnats = data.leagues
      .filter((l) => !isCup(l))
      .map((l) => ({ key: l.key, nom: l.name, pays: l.country, niveau: l.tier === "core" ? "principal" : "complementaire", charge: data.peekLeague(l.key) !== null }));
    if (teams.some((t) => t.leagueKey === OTHER_KEY)) championnats.push({ key: OTHER_KEY, nom: OTHER.name, pays: OTHER.country, niveau: "complementaire", charge: true });
    res.set("Cache-Control", "public, max-age=300");
    res.json({
      genereLe: new Date(now()).toISOString(),
      complet: !data.unloadedLeagues().some((l) => l.lot === "core" || l.etat === "chargement"),
      championnats,
      equipes,
    });
  });

  app.get("/api/status", (req, res) => {
    const avertissements = [];
    if (!config.providers.order.length) avertissements.push("Aucune source de données configurée : ajoutez FOOTBALL_DATA_API_KEY (offre gratuite de football-data.org).");
    if (!config.anthropic.key) avertissements.push("ANTHROPIC_API_KEY absente : l'IA est désactivée, le modèle statistique répond seul.");
    const donnees = data.status();
    // « avertissements vide » doit vouloir dire « tout est chargé et à jour » : on signale donc aussi ce qui n'a jamais pu
    // se charger (avec la raison, regroupée par message) et ce qui est encore en cours de chargement.
    // Les championnats complémentaires se chargent après les autres et peuvent manquer sans gravité : leurs problèmes vont dans
    // « remarques », pas dans « avertissements » (que la surveillance traite comme une panne).
    const echecs = { principal: new Map(), complementaire: new Map() };
    const enChargement = { principal: 0, complementaire: 0 };
    const remarques = [];
    for (const c of donnees.championnats) {
      if (!c.couvert) continue;
      const notes = c.niveau === "principal" ? avertissements : remarques;
      if (c.alertes.length) notes.push(`${c.nom} : ${c.alertes[0]}`);
      if (c.etat === "echec") echecs[c.niveau].set(c.derniereErreur, [...(echecs[c.niveau].get(c.derniereErreur) || []), c.nom]);
      else if (c.etat === "chargement") enChargement[c.niveau] += 1;
      else if (c.derniereErreur) notes.push(`${c.nom} : la dernière actualisation a échoué (${c.derniereErreur}), données vieilles de ${c.ageMinutes} min.`);
    }
    for (const [message, noms] of echecs.principal) avertissements.push(`Chargement impossible (${noms.join(", ")}) : ${message}`);
    for (const [message, noms] of echecs.complementaire) remarques.push(`Chargement impossible (${noms.join(", ")}) : ${message}`);
    if (enChargement.principal) avertissements.push(`Chargement en cours : ${enChargement.principal} championnat(s) pas encore prêt(s).`);
    if (enChargement.complementaire) remarques.push(`Chargement en cours : ${enChargement.complementaire} championnat(s) complémentaire(s) pas encore prêt(s).`);
    const modelParams = data.getModelParams();
    res.json({
      service: "Analyseur Foot Pro — API",
      version: VERSION,
      heure: new Date(now()).toISOString(),
      ia: ai.status(),
      donnees,
      modele: {
        reglages: modelParams,
        // Correction des totaux de buts : rythme des équipes rapproché de la moyenne + niveau de buts ajusté chaque jour (MODEL_CALIBRATION=off la coupe).
        correctionDesButs: { active: config.model.calibration !== false, exposantRythme: modelParams.rhythmExponent, coefficientDeNiveau: modelParams.levelFactor },
        reglageAutomatique: tuner ? tuner.status() : null,
        correctionParisAutomatiques: analysis.calibration ? { decalagePoints: Math.round(analysis.calibration.pickShift * 1000) / 10, detail: analysis.calibration.info } : null,
      },
      europe: europe ? europe.status() : { actif: false },
      avertissements,
      remarques,
    });
  });

  // ---- Analyse d'une ou plusieurs sélections ----
  app.post("/api/analyze", async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const batch = Array.isArray(body.legs);
      const rawLegs = batch ? body.legs : [body];
      if (!rawLegs.length || rawLegs.length > config.limits.maxLegs) {
        return res.status(400).json({ error: `Envoyez entre 1 et ${config.limits.maxLegs} sélections.` });
      }
      const legs = rawLegs.map(readLeg);
      if (legs.some((l) => !l)) return res.status(400).json({ error: "Chaque sélection doit contenir equipe1 et equipe2 (texte)." });
      // `ia: false` : réponse rapide du seul modèle statistique (aucun appel à l'IA, donc pas de quota IA consommé). Le site peut
      // l'afficher tout de suite, puis relancer la même demande avec l'IA pour la relecture.
      const withAi = body.ia !== false;
      if (withAi && !consume(aiLimit, req, res, legs.length)) return undefined;
      const results = await analysis.analyzeLegs(legs, { withAi });
      return res.json(batch ? { legs: results } : results[0]);
    } catch (e) {
      return next(e);
    }
  });

  app.get("/api/top-matches", async (req, res, next) => {
    try {
      res.json(await coupons.topMatches());
    } catch (e) {
      if (e.code === "NO_DATA") return res.status(503).json({ error: e.message, details: e.details || [] });
      return next(e);
    }
    return undefined;
  });

  app.post("/api/auto-coupon", async (req, res, next) => {
    try {
      const raw = req.body && Array.isArray(req.body.matches) ? req.body.matches : null;
      if (!raw || !raw.length || raw.length > config.limits.maxLegs) {
        return res.status(400).json({ error: `Envoyez entre 1 et ${config.limits.maxLegs} matchs dans « matches ».` });
      }
      const matches = raw.map(readLeg);
      if (matches.some((m) => !m)) return res.status(400).json({ error: "Chaque match doit contenir equipe1 et equipe2 (texte)." });
      if (!consume(aiLimit, req, res, matches.length)) return undefined;
      return res.json(await coupons.autoCoupon(matches));
    } catch (e) {
      return next(e);
    }
  });

  // ---- Contrôle de fiabilité sur les matchs récents ----
  // Sans paramètre, le contrôle utilise les réglages en service sur le serveur, correction des totaux de buts comprise. Paramètres facultatifs
  // (lecture seule, sans effet sur les réponses du serveur) : `pas` (jours entre deux ré-ajustements) et des réglages d'essai du modèle, pour
  // comparer plusieurs réglages sur exactement les mêmes matchs : demiVie, prior, rho, niveauDemiVie, niveauPrior, exposant, exposantForce,
  // exposantRythme, echelle (voir model.js). Par exemple `exposantRythme=1&echelle=1` donne le modèle d'avant la correction.
  app.get("/api/backtest", async (req, res, next) => {
    try {
      if (!consume(heavy, req, res)) return undefined;
      const jours = clamp(parseInt(req.query.jours, 10) || 120, 30, 365);
      const pas = Math.round(optNum(req.query.pas, 3, 28) ?? 7);
      const wanted = typeof req.query.championnat === "string" ? req.query.championnat.toUpperCase().slice(0, 4) : "";
      // Sans précision : les 10 championnats principaux. Un championnat complémentaire peut être demandé par sa clé ; une coupe, non.
      const domestic = data.leagues.filter((l) => !isCup(l));
      const keys = wanted ? domestic.filter((l) => l.key === wanted).map((l) => l.key) : domestic.filter((l) => l.tier === "core").map((l) => l.key);
      if (!keys.length) return res.status(404).json({ error: "Championnat inconnu ou non couvert." });
      const essai = {};
      const put = (name, value) => {
        if (value !== undefined) essai[name] = value;
      };
      put("halfLifeDays", optNum(req.query.demiVie, 30, 1500));
      put("priorMatches", optNum(req.query.prior, 0, 60));
      put("rho", optNum(req.query.rho, -0.3, 0.1));
      put("levelHalfLifeDays", optNum(req.query.niveauDemiVie, 0, 1500));
      put("levelPriorMatches", optNum(req.query.niveauPrior, 0, 400));
      put("strengthExponent", optNum(req.query.exposant, 0.3, 1.3));
      put("qualityExponent", optNum(req.query.exposantForce, 0.2, 1.3));
      put("rhythmExponent", optNum(req.query.exposantRythme, 0.2, 1.3));
      put("levelFactor", optNum(req.query.echelle, 0.8, 1.3));
      // Les réglages en service font partie de la clé : un rapport gardé en mémoire ne doit pas survivre à un changement de réglage.
      const report = await backtestCache.get(`${jours}:${pas}:${keys.join(",")}:${JSON.stringify(essai)}:${JSON.stringify(data.getModelParams())}`, {
        ttlMs: 6 * 3600000,
        errorTtlMs: 60000,
        loader: async () => {
          const { ready } = await data.ensureAll({ budgetMs: 25000, keys });
          if (!ready.length) throw Object.assign(new Error("Aucune donnée disponible pour le moment."), { code: "NO_DATA" });
          const r = await runBacktestAsync(
            ready.map((d) => ({ key: d.league.key, finished: d.finished })),
            { now: now(), evalDays: jours, stepDays: pas, model: { ...config.model, ...data.getModelParams(), ...essai } }
          );
          return { genereLe: new Date(now()).toISOString(), reglages: data.getModelParams(), ...(Object.keys(essai).length ? { essai } : {}), ...r };
        },
      });
      return res.json(report);
    } catch (e) {
      if (e.code === "NO_DATA") return res.status(503).json({ error: e.message });
      return next(e);
    }
  });

  // ---- Ancienne route : elle relayait n'importe quelle requête vers Anthropic avec la clé du serveur ----
  app.all("/api/analyze-simple", (req, res) => {
    res.status(410).json({ error: "Cette route a été supprimée pour des raisons de sécurité. Utilisez /api/auto-coupon." });
  });

  app.use((req, res) => res.status(404).json({ error: "Route introuvable." }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Corps de la requête invalide (JSON attendu)." });
    if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Requête trop volumineuse." });
    log.error(`[erreur] ${req.method} ${req.path} : ${err && err.message}`);
    return res.status(500).json({ error: "Erreur interne du serveur." });
  });

  return app;
}

module.exports = { createApp, readLeg };
