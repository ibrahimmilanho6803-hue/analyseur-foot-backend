"use strict";

// football-data.org (offre gratuite : 12 championnats, 10 requêtes par minute).
// Un seul appel par championnat et par saison renvoie tous les matchs, joués ou à venir.
const BASE = "https://api.football-data.org/v4";
const GAP_MS = 6500;

function normalize(m) {
  const home = m && m.homeTeam;
  const away = m && m.awayTeam;
  if (!home || !away || home.id == null || away.id == null) return null;
  const kickoff = Date.parse(m.utcDate);
  if (!Number.isFinite(kickoff)) return null;
  const ft = (m.score && m.score.fullTime) || {};
  const hasScore = Number.isFinite(ft.home) && Number.isFinite(ft.away);
  let status = "other";
  if (m.status === "FINISHED" && hasScore) status = "finished";
  else if (m.status === "SCHEDULED" || m.status === "TIMED") status = "scheduled";
  const team = (t) => ({ id: `fd:${t.id}`, name: t.name || t.shortName || String(t.id), shortName: t.shortName || t.tla || "" });
  return {
    id: `fd:${m.id}`,
    kickoff,
    status,
    hg: status === "finished" ? ft.home : null,
    ag: status === "finished" ? ft.away : null,
    home: team(home),
    away: team(away),
  };
}

function createFootballData({ http, key, gapMs = GAP_MS }) {
  return {
    name: "footballdata",
    label: "football-data.org",
    supports: (league) => Boolean(key && league.fd),
    async fetchSeason(league, startYear) {
      const url = `${BASE}/competitions/${league.fd}/matches?season=${startYear}`;
      const data = await http.getJson(url, {
        headers: { "X-Auth-Token": key },
        throttleKey: "footballdata",
        minIntervalMs: gapMs,
        timeoutMs: 25000,
      });
      const matches = (Array.isArray(data && data.matches) ? data.matches : []).map(normalize).filter(Boolean);
      return { matches, limited: false };
    },
  };
}

module.exports = { createFootballData, normalizeFootballData: normalize };
