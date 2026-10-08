"use strict";

// TheSportsDB. Attention : avec la clé gratuite, « eventsseason » ne renvoie que 15 matchs
// par saison (constaté), ce qui est trop peu pour estimer la force des équipes. Une clé
// payante renvoie la saison complète. On détecte ce cas et on le signale.
const BASE = "https://www.thesportsdb.com/api/v1/json";
const GAP_MS = 2100;

function parseKickoff(e) {
  const ts = e.strTimestamp;
  if (ts) {
    const t = Date.parse(/(z|[+-]\d\d:?\d\d)$/i.test(ts) ? ts : `${ts}Z`);
    if (Number.isFinite(t)) return t;
  }
  if (e.dateEvent) {
    const t = Date.parse(`${e.dateEvent}T${e.strTime || "12:00:00"}Z`);
    if (Number.isFinite(t)) return t;
  }
  return NaN;
}

function toScore(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function normalize(e, nowMs) {
  if (!e || !e.idHomeTeam || !e.idAwayTeam) return null;
  const kickoff = parseKickoff(e);
  if (!Number.isFinite(kickoff)) return null;
  const hg = toScore(e.intHomeScore);
  const ag = toScore(e.intAwayScore);
  const off = /postp|cancel|abandon|suspend/i.test(`${e.strStatus || ""} ${e.strPostponed === "yes" ? "postponed" : ""}`);
  let status = "other";
  if (!off && hg !== null && ag !== null && kickoff <= nowMs) status = "finished";
  else if (!off && hg === null && ag === null && kickoff > nowMs - 3 * 3600000) status = "scheduled";
  return {
    id: `ts:${e.idEvent}`,
    kickoff,
    status,
    hg: status === "finished" ? hg : null,
    ag: status === "finished" ? ag : null,
    home: { id: `ts:${e.idHomeTeam}`, name: e.strHomeTeam, shortName: "" },
    away: { id: `ts:${e.idAwayTeam}`, name: e.strAwayTeam, shortName: "" },
  };
}

function createTheSportsDb({ http, key, now = Date.now, gapMs = GAP_MS }) {
  return {
    name: "thesportsdb",
    label: "TheSportsDB",
    supports: (league) => Boolean(key && league.tsdb),
    async fetchSeason(league, startYear) {
      const names = league.style === "calendar" ? [`${startYear}`, `${startYear}-${startYear + 1}`] : [`${startYear}-${startYear + 1}`];
      for (const s of names) {
        const url = `${BASE}/${key}/eventsseason.php?id=${league.tsdb}&s=${s}`;
        const data = await http.getJson(url, { throttleKey: "thesportsdb", minIntervalMs: gapMs, timeoutMs: 25000 });
        const events = Array.isArray(data && data.events) ? data.events : [];
        if (!events.length) continue;
        const nowMs = now();
        const matches = events.map((e) => normalize(e, nowMs)).filter(Boolean);
        const limited = events.length === 15 || events.length === 100 || events.length < 60;
        return { matches, limited, rawCount: events.length };
      }
      return { matches: [], limited: false, rawCount: 0 };
    },
  };
}

module.exports = { createTheSportsDb, normalizeTheSportsDb: normalize };
