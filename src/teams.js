"use strict";

const { norm } = require("./util");

// Surnoms courants -> nom officiel (forme normalisée). La recherche approchée fait le reste.
const ALIASES = {
  psg: "paris saint germain",
  "paris sg": "paris saint germain",
  "man city": "manchester city",
  "man utd": "manchester united",
  "man united": "manchester united",
  "manchester utd": "manchester united",
  spurs: "tottenham hotspur",
  tottenham: "tottenham hotspur",
  wolves: "wolverhampton wanderers",
  forest: "nottingham forest",
  "nottm forest": "nottingham forest",
  "west ham": "west ham united",
  newcastle: "newcastle united",
  brighton: "brighton hove albion",
  leeds: "leeds united",
  barca: "barcelona",
  atletico: "atletico madrid",
  atleti: "atletico madrid",
  inter: "internazionale",
  "inter milan": "internazionale",
  milan: "ac milan",
  juve: "juventus",
  bayern: "bayern munchen",
  "bayern munich": "bayern munchen",
  dortmund: "borussia dortmund",
  bvb: "borussia dortmund",
  gladbach: "borussia monchengladbach",
  leverkusen: "bayer leverkusen",
  om: "olympique marseille",
  marseille: "olympique marseille",
  ol: "olympique lyonnais",
  lyon: "olympique lyonnais",
  sporting: "sporting cp",
  benfica: "sl benfica",
  porto: "fc porto",
  psv: "psv eindhoven",
  ajax: "afc ajax",
  flamengo: "cr flamengo",
};

const NOISE = new Set(["fc", "cf", "afc", "sc", "ac", "as", "ssc", "rc", "rcd", "fk", "sv", "vfl", "vfb", "tsg", "ud", "cd", "us", "ca", "de", "the", "club", "calcio", "1899", "1900", "04", "05", "1846", "1907", "1893"]);

const tokens = (s) => norm(s).split(" ").filter(Boolean);
const core = (s) => tokens(s).filter((t) => !NOISE.has(t)).join(" ");

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function tokenMatches(q, t) {
  return q === t || (q.length >= 4 && t.startsWith(q)) || (t.length >= 4 && q.startsWith(t));
}

function scoreName(query, candidate) {
  const nq = norm(query);
  const nc = norm(candidate);
  if (!nq || !nc) return 0;
  if (nq === nc) return 1;
  const cq = core(query);
  const cc = core(candidate);
  if (cq && cq === cc) return 0.97;
  const tq = cq ? cq.split(" ") : [];
  const tc = cc ? cc.split(" ") : [];
  if (tq.length && tq.every((q) => tc.some((t) => tokenMatches(q, t)))) return Math.max(0.78, 0.9 - 0.03 * (tc.length - tq.length));
  if (tc.length && tc.every((t) => tq.some((q) => tokenMatches(q, t)))) return 0.8;
  const dist = levenshtein(cq, cc);
  const sim = 1 - dist / Math.max(cq.length, cc.length, 1);
  return sim >= 0.8 ? 0.6 + 0.3 * sim : 0;
}

// teams : [{ id, name, shortName?, leagueKey }]
function findTeam(query, teams, { leagueKey } = {}) {
  const raw = norm(query || "");
  if (!raw) return { team: null, score: 0, alternatives: [] };
  const q = Object.prototype.hasOwnProperty.call(ALIASES, raw) ? ALIASES[raw] : raw;
  const pool = leagueKey ? teams.filter((t) => t.leagueKey === leagueKey) : teams;
  const scored = pool
    .map((t) => ({ team: t, score: Math.max(scoreName(q, t.name), t.shortName ? scoreName(q, t.shortName) : 0) }))
    .filter((x) => x.score >= 0.7)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { team: null, score: 0, alternatives: [] };
  const [best, second] = scored;
  const ambiguous = second && second.team.id !== best.team.id && best.score < 0.97 && best.score - second.score < 0.03;
  return {
    team: ambiguous ? null : best.team,
    score: best.score,
    ambiguous: Boolean(ambiguous),
    alternatives: scored.slice(0, 4).map((x) => x.team.name),
  };
}

module.exports = { findTeam, scoreName, ALIASES };
