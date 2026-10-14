"use strict";

const { clamp } = require("./util");

const num = (v, d) => {
  if (v === undefined || v === null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const csv = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : null);
// Interrupteur « arrêt » : false / off / 0 / non / no (majuscules ou non). Toute autre valeur, ou l'absence de valeur, laisse activé.
const isOff = (v) => v !== undefined && v !== null && ["false", "off", "0", "non", "no"].includes(String(v).trim().toLowerCase());

const DEFAULT_ORIGINS = [
  "https://analyseur-foot-web.vercel.app",
  "http://localhost:3000",
  "http://localhost",
  "https://localhost",
  "capacitor://localhost",
  "ionic://localhost",
];

// Aperçus Vercel du site (une adresse par branche / par déploiement).
const ORIGIN_PATTERNS = [/^https:\/\/analyseur-foot-web(-[a-z0-9-]+)?\.vercel\.app$/];

function loadConfig(env = process.env) {
  const footballDataKey = env.FOOTBALL_DATA_API_KEY || env.FOOTBALL_API_KEY || "";
  const sportsDbKey = env.SPORTSDB_API_KEY || "";

  // Ordre des sources de données. Par défaut : celles dont la clé est présente.
  let order = csv(env.DATA_PROVIDER);
  if (!order) {
    order = [];
    if (footballDataKey) order.push("footballdata");
    if (sportsDbKey) order.push("thesportsdb");
  }

  const anthropicKey = env.ANTHROPIC_API_KEY || "";
  return {
    port: num(env.PORT, 3001),
    anthropic: {
      key: anthropicKey,
      enabled: Boolean(anthropicKey) && env.AI_ENABLED !== "false",
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      effort: env.AI_EFFORT || "medium",
      timeoutMs: num(env.AI_TIMEOUT_MS, 40000),
      maxAdjustPoints: num(env.AI_MAX_ADJUST_POINTS, 4),
      dailyBudget: num(env.AI_DAILY_BUDGET_CALLS, 400),
      // Appels à l'IA en même temps (un coupon de 12 paris se traite en deux vagues de 6 au lieu de trois de 4).
      maxParallel: Math.min(12, Math.max(1, Math.round(num(env.AI_MAX_PARALLEL, 6)))),
    },
    providers: {
      order,
      footballDataKey,
      sportsDbKey,
      // Écart minimal entre deux appels (l'offre gratuite de football-data.org autorise 10 appels par minute).
      footballDataGapMs: num(env.FOOTBALL_DATA_MIN_INTERVAL_MS, 6500),
      sportsDbGapMs: num(env.SPORTSDB_MIN_INTERVAL_MS, 2100),
    },
    model: {
      halfLifeDays: num(env.MODEL_HALF_LIFE_DAYS, 300),
      priorMatches: num(env.MODEL_PRIOR_MATCHES, 10),
      rho: num(env.MODEL_RHO, -0.08),
      maxGoals: 9,
      // Réglage automatique : le serveur rejoue les matchs récents avec plusieurs réglages et garde le meilleur.
      autoTune: env.MODEL_AUTOTUNE !== "false",
      tuneGrid: { halfLifeDays: [150, 300, 500], priorMatches: [4, 10, 20] },
      // Correction des totaux de buts (« plus de 1.5 / 2.5 », « les deux équipes marquent »…), sans toucher au 1-N-2 :
      //  - rythme des équipes rapproché de la moyenne (exposant < 1 ; 1 = pas de correction) ;
      //  - niveau de buts ajusté chaque jour d'après l'écart observé entre buts prévus et buts marqués (voir tuning.js).
      // MODEL_CALIBRATION=off coupe les deux et revient au modèle d'avant (retour arrière sans redéployer le code).
      calibration: !isOff(env.MODEL_CALIBRATION),
      rhythmExponent: clamp(num(env.MODEL_RHYTHM_EXPONENT, 0.5), 0.2, 1),
    },
    // Ouverture à tous les matchs : coupes d'Europe (Ligue des champions, Ligue Europa, Ligue Conférence), comparaison entre clubs de
    // championnats différents et championnats complémentaires. Chaque interrupteur se coupe sans redéployer le code :
    //  - EUROPE_ENABLED=off : retour au fonctionnement d'avant (seuls les clubs d'un même championnat se comparent, pas de coupes) ;
    //  - EXTRA_LEAGUES_ENABLED=off : seuls les 10 championnats principaux sont chargés ;
    //  - TOP_CUPS=off : « Top Matchs » ne retient pas de matchs de coupes d'Europe.
    europe: {
      enabled: !isOff(env.EUROPE_ENABLED),
      extraLeagues: !isOff(env.EXTRA_LEAGUES_ENABLED),
      topCups: !isOff(env.TOP_CUPS),
      // Mémoire des résultats de coupes d'Europe pour comparer les championnats (le niveau d'un championnat varie lentement).
      halfLifeDays: clamp(num(env.EUROPE_HALF_LIFE_DAYS, 365), 60, 1500),
    },
    cache: {
      seasonTtlMs: num(env.CACHE_SEASON_TTL_MIN, 20) * 60000,
      previousSeasonTtlMs: 24 * 3600000,
      namesTtlMs: 24 * 3600000,
      namesWaitMs: 2500,
      staleMs: 12 * 3600000,
      refreshEveryMs: num(env.CACHE_REFRESH_MIN, 25) * 60000,
    },
    limits: {
      generalPerMin: num(env.RATE_LIMIT_PER_MIN, 90),
      aiPerMin: num(env.RATE_LIMIT_AI_PER_MIN, 30),
      bodyLimit: "20kb",
      maxLegs: 12,
    },
    cors: {
      origins: [...DEFAULT_ORIGINS, ...(csv(env.ALLOWED_ORIGINS) || [])], // ALLOWED_ORIGINS s'ajoute à la liste par défaut
      patterns: ORIGIN_PATTERNS,
    },
    top: {
      count: 3,
      windowHours: num(env.TOP_WINDOW_HOURS, 72),
      maxWindowHours: num(env.TOP_MAX_WINDOW_HOURS, 168),
      minLegP: 0.55,
      maxLegP: 0.88,
      targetOdds: num(env.TOP_TARGET_ODDS, 2.5),
      budgetMs: 25000,
    },
  };
}

module.exports = { loadConfig, DEFAULT_ORIGINS };
