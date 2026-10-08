"use strict";

const { round } = require("./util");

// Statistiques lisibles (forme, bilan domicile / extérieur, confrontations directes),
// calculées sur les matchs réellement joués. `finished` est trié du plus ancien au plus récent.

function recent(finished, teamId, limit, venue) {
  const out = [];
  for (let i = finished.length - 1; i >= 0 && out.length < limit; i--) {
    const m = finished[i];
    const home = m.home.id === teamId;
    const away = m.away.id === teamId;
    if (!home && !away) continue;
    if (venue === "home" && !home) continue;
    if (venue === "away" && !away) continue;
    out.push(m);
  }
  return out; // du plus récent au plus ancien
}

const goalsOf = (m, teamId) => (m.home.id === teamId ? { f: m.hg, a: m.ag } : { f: m.ag, a: m.hg });

function summarize(matches, teamId) {
  let won = 0;
  let draw = 0;
  let lost = 0;
  let gf = 0;
  let ga = 0;
  for (const m of matches) {
    const { f, a } = goalsOf(m, teamId);
    gf += f;
    ga += a;
    if (f > a) won++;
    else if (f === a) draw++;
    else lost++;
  }
  const n = matches.length;
  return {
    played: n,
    won,
    draw,
    lost,
    goalsFor: gf,
    goalsAgainst: ga,
    avgGoalsFor: n ? round(gf / n, 2) : 0,
    avgGoalsAgainst: n ? round(ga / n, 2) : 0,
  };
}

function formString(matches, teamId) {
  return matches
    .map((m) => {
      const { f, a } = goalsOf(m, teamId);
      return f > a ? "V" : f < a ? "D" : "N";
    })
    .join("");
}

// Vue d'ensemble d'une équipe : 10 derniers matchs, forme sur 5, et bilan à domicile ou à l'extérieur.
function teamStats(finished, teamId, venue) {
  const last10 = recent(finished, teamId, 10);
  const last5 = last10.slice(0, 5);
  const overall = summarize(last10, teamId);
  const atVenue = summarize(recent(finished, teamId, 10, venue), teamId);
  return {
    forme: formString(last5, teamId), // du plus récent au plus ancien
    matchsAnalyses: overall.played,
    victoires: overall.won,
    nuls: overall.draw,
    defaites: overall.lost,
    butsMarquesParMatch: overall.avgGoalsFor,
    butsEncaissesParMatch: overall.avgGoalsAgainst,
    [venue === "home" ? "domicile" : "exterieur"]: atVenue,
  };
}

// Confrontations directes (jusqu'à `limit`). Le bilan est vu depuis l'équipe qui reçoit
// aujourd'hui : « homeWins » = victoires de cette équipe, quel que soit le lieu d'alors.
function headToHead(finished, homeId, awayId, limit = 5) {
  const meetings = [];
  for (let i = finished.length - 1; i >= 0 && meetings.length < limit; i--) {
    const m = finished[i];
    const pair = (m.home.id === homeId && m.away.id === awayId) || (m.home.id === awayId && m.away.id === homeId);
    if (pair) meetings.push(m);
  }
  if (!meetings.length) return null;
  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  for (const m of meetings) {
    const { f, a } = goalsOf(m, homeId);
    if (f > a) homeWins++;
    else if (f === a) draws++;
    else awayWins++;
  }
  return {
    matches: meetings.map((m) => ({
      homeTeam: m.home.name,
      score: `${m.hg}-${m.ag}`,
      awayTeam: m.away.name,
      date: new Date(m.kickoff).toISOString().slice(0, 10),
    })),
    bilan: { homeWins, draws, awayWins },
  };
}

// Bloc complet pour un match : ce que l'application affiche dans les détails.
function matchStats(finished, homeId, awayId) {
  const home = teamStats(finished, homeId, "home");
  const away = teamStats(finished, awayId, "away");
  return {
    statsEquipe1: home,
    statsEquipe2: away,
    homeAway1: { home: home.domicile },
    homeAway2: { away: away.exterieur },
    h2h: headToHead(finished, homeId, awayId),
  };
}

module.exports = { recent, summarize, formString, teamStats, headToHead, matchStats };
