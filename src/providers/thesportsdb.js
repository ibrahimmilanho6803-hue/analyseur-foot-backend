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

// « strTeamAlternate » : noms alternatifs séparés par des virgules (« Olympique Lyonnais, Olympique Lyon, OL »).
function splitAlternates(value, name) {
  const seen = new Set([String(name || "").trim().toLowerCase()]);
  const out = [];
  for (const part of String(value || "").split(",")) {
    const alt = part.trim().replace(/\s+/g, " ");
    const k = alt.toLowerCase();
    if (alt.length < 2 || alt.length > 60 || seen.has(k)) continue;
    seen.add(k);
    out.push(alt);
    if (out.length >= 12) break;
  }
  return out;
}

// Une équipe appartient au championnat demandé si sa fiche l'indique (fiche sans indication : on lui fait confiance).
function inLeague(t, league) {
  const id = t.idLeague;
  return id === undefined || id === null || id === "" || String(id) === String(league.tsdb);
}

function toTeam(t) {
  const alternate = t.strTeamAlternate !== undefined ? t.strTeamAlternate : t.strAlternate;
  return { id: `ts:${t.idTeam}`, name: String(t.strTeam || ""), aliases: splitAlternates(alternate, t.strTeam) };
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
    // Noms alternatifs des clubs d'un championnat (« PSG », « OL », « Bayern »…) : sert à reconnaître ce que l'utilisateur tape.
    // Les identifiants sont ceux des matchs (« ts:… »). Deux adresses sont essayées, dans cet ordre :
    //  1. la recherche par nom de championnat (vérifiée pour les 10 championnats suivis) ;
    //  2. la liste par identifiant, qui avec la clé gratuite renvoie toujours les mêmes clubs anglais de 3e division.
    // Toute équipe d'un autre championnat que celui demandé est écartée : mieux vaut aucun nom alternatif que de mauvais.
    // Avec une clé gratuite la liste est tronquée à 10 clubs, ce qui est sans gravité ici.
    async fetchTeams(league) {
      const urls = [];
      if (league.tsdbName) urls.push(`${BASE}/${key}/search_all_teams.php?l=${encodeURIComponent(league.tsdbName)}`);
      urls.push(`${BASE}/${key}/lookup_all_teams.php?id=${league.tsdb}`);
      let lastError = null;
      for (const url of urls) {
        try {
          const data = await http.getJson(url, { throttleKey: "thesportsdb", minIntervalMs: gapMs, timeoutMs: 25000, retries: 1 });
          const rows = (Array.isArray(data && data.teams) ? data.teams : []).filter((t) => t && t.idTeam && inLeague(t, league));
          if (rows.length) return rows.map(toTeam);
        } catch (e) {
          lastError = e;
        }
      }
      if (lastError) throw lastError;
      return [];
    },
  };
}

module.exports = { createTheSportsDb, normalizeTheSportsDb: normalize, splitAlternates };
