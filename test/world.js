"use strict";

// Petit monde de test : trois championnats simulés, des matchs à venir, une IA factice.
const { createDataService } = require("../src/data");
const { createAnalysis } = require("../src/analysis");
const { createCoupons } = require("../src/coupons");
const { SwrCache } = require("../src/cache");
const { loadConfig } = require("../src/config");
const { simulateLeague } = require("./helpers");

const HOUR = 3600000;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const JULY = Date.UTC(2026, 6, 1);

const NAMES = {
  PL: ["Arsenal FC", "Chelsea FC", "Liverpool FC", "Manchester City FC", "Manchester United FC", "Tottenham Hotspur FC", "Newcastle United FC", "Aston Villa FC", "Brighton & Hove Albion FC", "West Ham United FC", "Everton FC", "Fulham FC"],
  PD: ["Real Madrid CF", "FC Barcelona", "Club Atlético de Madrid", "Sevilla FC", "Real Betis Balompié", "Real Sociedad de Fútbol", "Villarreal CF", "Athletic Club", "Valencia CF", "Girona FC", "Rayo Vallecano de Madrid", "RC Celta de Vigo"],
  SA: ["FC Internazionale Milano", "AC Milan", "Juventus FC", "SSC Napoli", "AS Roma", "SS Lazio", "Atalanta BC", "ACF Fiorentina", "Bologna FC 1909", "Torino FC", "Udinese Calcio", "Genoa CFC"],
};

const quiet = { log() {}, warn() {}, error() {} };

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
  };
}

function buildWorld({ fixtureHours = [4, 14, 26, 38, 50, 62], failing = [], aiBehaviour = "ok", env = {}, keys = ["PL", "PD", "SA"] } = {}) {
  const clock = { t: NOW };
  const now = () => clock.t;
  const store = {};
  keys.forEach((k, i) => (store[k] = leagueMatches(k, 11 + i * 7, fixtureHours)));
  const provider = {
    name: "fake",
    label: "Source de test",
    supports: (l) => keys.includes(l.key),
    fetchSeason: async (league, year) => {
      if (failing.includes(league.key)) throw new Error("source en panne");
      return { matches: year === 2026 ? store[league.key].cur : store[league.key].prev, limited: false };
    },
  };
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
  const analysis = createAnalysis({ config, data, ai, now, log: quiet });
  const coupons = createCoupons({ config, data, analysis, now, log: quiet });
  return { clock, config, data, ai, analysis, coupons, store };
}

module.exports = { buildWorld, NOW, HOUR, NAMES };
