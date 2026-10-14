"use strict";

// Petit monde de test : trois championnats simulés, des matchs à venir, une IA factice.
const { createDataService } = require("../src/data");
const { createAnalysis } = require("../src/analysis");
const { createCoupons } = require("../src/coupons");
const { createEurope } = require("../src/europe");
const { SwrCache } = require("../src/cache");
const { loadConfig } = require("../src/config");
const { simulateLeague, mulberry32, poissonSample } = require("./helpers");

const HOUR = 3600000;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const JULY = Date.UTC(2026, 6, 1);

const NAMES = {
  PL: ["Arsenal FC", "Chelsea FC", "Liverpool FC", "Manchester City FC", "Manchester United FC", "Tottenham Hotspur FC", "Newcastle United FC", "Aston Villa FC", "Brighton & Hove Albion FC", "West Ham United FC", "Everton FC", "Fulham FC"],
  PD: ["Real Madrid CF", "FC Barcelona", "Club Atlético de Madrid", "Sevilla FC", "Real Betis Balompié", "Real Sociedad de Fútbol", "Villarreal CF", "Athletic Club", "Valencia CF", "Girona FC", "Rayo Vallecano de Madrid", "RC Celta de Vigo"],
  SA: ["FC Internazionale Milano", "AC Milan", "Juventus FC", "SSC Napoli", "AS Roma", "SS Lazio", "Atalanta BC", "ACF Fiorentina", "Bologna FC 1909", "Torino FC", "Udinese Calcio", "Genoa CFC"],
  // Championnat complémentaire (deuxième division anglaise) : à demander avec keys: ["PL", "PD", "SA", "ELC"]. Il ne joue pas la coupe.
  ELC: ["Leeds United FC", "Leicester City FC", "Sunderland AFC", "Norwich City FC", "Middlesbrough FC", "Coventry City FC", "Watford FC", "Bristol City FC", "Swansea City AFC", "Millwall FC", "Stoke City FC", "Hull City AFC"],
};
const EXTRA_KEYS = ["ELC"];

const quiet = { log() {}, warn() {}, error() {} };

// Vrais niveaux des trois championnats simulés (écart de log-buts par équipe, voir cross.js) : volontairement différents des niveaux
// a priori du serveur (PL 0, PD −0,14, SA −0,16), pour vérifier que les matchs de coupe les corrigent.
const TRUE_LEVEL = { PL: 0, PD: -0.2, SA: -0.45 };
// Clubs que seule la coupe fait connaître (aucun des trois championnats ne les contient).
const CUP_ONLY = ["Dinamo Imaginaire", "Sparta Fictif", "Slovan Inventé", "Olimpija Fictive"];

function leagueMatches(key, seed, fixtureHours) {
  const sim = simulateLeague({ teams: 12, seasons: 3, seed, now: NOW });
  const idx = (id) => Number(id.slice(1));
  const team = (id) => ({ id: `${key}:${idx(id)}`, name: NAMES[key][idx(id)], shortName: "" });
  const played = sim.matches.map((m) => ({ ...m, id: `${key}-${m.id}`, home: team(m.home.id), away: team(m.away.id) }));
  const fixtures = fixtureHours.map((h, k) => ({
    id: `${key}-F${k}`,
    kickoff: NOW + h * HOUR,
    status: "scheduled",
    hg: null,
    ag: null,
    home: team(`T${k}`),
    away: team(`T${k + 6}`),
  }));
  return {
    cur: [...played.filter((m) => m.kickoff >= JULY), ...fixtures],
    prev: played.filter((m) => m.kickoff < JULY),
    truth: sim.truth,
  };
}

// Coupe d'Europe simulée entre clubs des championnats donnés et de clubs « de coupe seulement » : les buts suivent exactement le modèle
// de cross.js avec les vraies forces de chaque club et les vrais niveaux de TRUE_LEVEL. `pairs` : matchs à venir [[club, club, heures]].
function cupWorld(store, keys, { seed = 77, perSeason = 110, pairs = [] } = {}) {
  const rand = mulberry32(seed);
  const pool = new Map();
  for (const k of keys) {
    for (const [tid, t] of store[k].truth) {
      const i = Number(tid.slice(1));
      pool.set(`${k}:${i}`, { id: `${k}:${i}`, name: NAMES[k][i], level: TRUE_LEVEL[k], a: t.a, d: t.d });
    }
  }
  CUP_ONLY.forEach((name, i) => pool.set(`X:${i}`, { id: `X:${i}`, name, level: -0.9 + (i - 1.5) * 0.12, a: 1, d: 1 }));
  const all = [...pool.values()];
  const team = (t) => ({ id: t.id, name: t.name, shortName: "" });
  const draw = (from, to, prefix) => {
    const out = [];
    for (let n = 0; out.length < perSeason && n < perSeason * 20; n++) {
      const h = all[Math.floor(rand() * all.length)];
      const g = all[Math.floor(rand() * all.length)];
      if (h.id.split(":")[0] === g.id.split(":")[0]) continue; // des clubs de championnats différents seulement
      const u = h.level - g.level;
      out.push({
        id: `UCL-${prefix}${out.length}`,
        kickoff: from + Math.floor(rand() * (to - from)),
        status: "finished",
        hg: poissonSample(Math.min(6, 1.1 * 1.3 * h.a * g.d * Math.exp(u)), rand),
        ag: poissonSample(Math.min(6, 1.1 * g.a * h.d * Math.exp(-u)), rand),
        home: team(h),
        away: team(g),
      });
    }
    return out;
  };
  const upcoming = pairs.map(([h, g, hours], k) => ({ id: `UCL-F${k}`, kickoff: NOW + hours * HOUR, status: "scheduled", hg: null, ag: null, home: team(pool.get(h)), away: team(pool.get(g)) }));
  return {
    cur: [...draw(JULY + 5 * 86400000, NOW - 3 * 86400000, "c"), ...upcoming],
    prev: draw(JULY - 300 * 86400000, JULY - 20 * 86400000, "p"),
  };
}

// Matchs à venir de la coupe (clubs « championnat:numéro ») : trois entre championnats, un avec un club de coupe seulement.
const CUP_PAIRS = [
  ["PL:0", "PD:0", 30], // Arsenal – Real Madrid
  ["SA:2", "PL:1", 55], // Juventus – Chelsea
  ["PD:1", "SA:0", 20], // FC Barcelona – Inter
  ["X:0", "PL:2", 70], // Dinamo Imaginaire – Liverpool
];

// aliases : { "PL:0": ["Les Gunners"], … } = noms alternatifs que la source de données fournit pour certains clubs.
// cups : ajoute la Ligue des champions simulée (matchs entre les championnats de `keys`, voir cupWorld).
function buildWorld({ fixtureHours = [4, 14, 26, 38, 50, 62], failing = [], aiBehaviour = "ok", env = {}, keys = ["PL", "PD", "SA"], aliases = null, cups = false } = {}) {
  const clock = { t: NOW };
  const now = () => clock.t;
  const store = {};
  keys.forEach((k, i) => (store[k] = leagueMatches(k, 11 + i * 7, fixtureHours)));
  const supported = cups ? [...keys, "UCL"] : keys;
  const cupKeys = keys.filter((k) => !EXTRA_KEYS.includes(k)); // les championnats complémentaires ne jouent pas la coupe simulée
  if (cups) store.UCL = cupWorld(store, cupKeys, { pairs: CUP_PAIRS.filter(([h, g]) => [h, g].every((id) => id.startsWith("X:") || cupKeys.includes(id.split(":")[0]))) });
  const provider = {
    name: "fake",
    label: "Source de test",
    supports: (l) => supported.includes(l.key),
    fetchSeason: async (league, year) => {
      if (failing.includes(league.key)) throw new Error("source en panne");
      return { matches: year === 2026 ? store[league.key].cur : store[league.key].prev, limited: false };
    },
  };
  if (aliases) {
    provider.fetchTeams = async (league) =>
      Object.entries(aliases)
        .filter(([id]) => id.startsWith(`${league.key}:`))
        .map(([id, names]) => ({ id, name: NAMES[league.key][Number(id.split(":")[1])], aliases: names }));
  }
  const config = loadConfig({ ANTHROPIC_API_KEY: "test-key", ...env });
  const data = createDataService({ config, http: null, cache: new SwrCache({ now }), now, log: quiet, providers: [provider] });

  const ai = {
    enabled: aiBehaviour !== "off",
    calls: [],
    review: async (ctx) => {
      ai.calls.push(ctx);
      if (aiBehaviour === "down") return { ok: false, code: "UNAVAILABLE", message: "L'IA est momentanément indisponible." };
      const adjustment = typeof aiBehaviour === "object" ? aiBehaviour.adjustment : 1;
      return { ok: true, adjustment, confiance: "moyen", justification: `Justification de test pour ${ctx.home}.`, vigilance: "", variant: 0 };
    },
    status: () => ({ active: aiBehaviour !== "off" }),
  };
  const europe = createEurope({ config, data, now, log: quiet });
  const analysis = createAnalysis({ config, data, ai, europe, now, log: quiet });
  const coupons = createCoupons({ config, data, analysis, europe, now, log: quiet });
  return { clock, config, data, ai, europe, analysis, coupons, store };
}

module.exports = { buildWorld, NOW, HOUR, NAMES, TRUE_LEVEL, CUP_ONLY };
