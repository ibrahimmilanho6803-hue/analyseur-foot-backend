"use strict";

const { norm } = require("./util");
const { GROUPS } = require("./team-groups");

// Mots qui ne distinguent pas un club d'un autre (« FC », « AC », « SL », années de fondation…).
const NOISE = new Set([
  "fc", "cf", "afc", "sc", "ac", "as", "ssc", "rc", "rcd", "fk", "sv", "vfl", "vfb", "tsg", "ud", "cd", "us", "ca", "de", "the", "club", "calcio",
  "ss", "ssd", "bc", "sl", "rsc", "krc", "kv", "kaa", "ksv", "se", "cr", "acf", "fsv", "ogc", "osc",
  "1899", "1900", "04", "05", "1846", "1907", "1893",
]);

// Écritures abrégées équivalentes, appliquées des deux côtés de la comparaison.
const WORD = { utd: "united", st: "saint" };

// Forme comparable d'un nom : minuscules, sans accents ni ponctuation, « & » = « and », « utd » = « united ».
const canon = (s) =>
  norm(String(s === null || s === undefined ? "" : s).replace(/&/g, " and "))
    .split(" ")
    .filter(Boolean)
    .map((w) => WORD[w] || w)
    .join(" ");

function info(s) {
  const c = canon(s);
  const words = c ? c.split(" ") : [];
  const tokens = words.filter((t) => !NOISE.has(t));
  return { c, words, core: tokens.join(" "), tokens };
}

// Index des groupes : chaque écriture d'un groupe pointe vers toutes les écritures de ce groupe.
// (Seules les écritures listées sont indexées, pas leur version abrégée : « Vitória SC » ne doit pas faire de « Vitória » seul
// un synonyme du club portugais.)
const GROUP_INDEX = new Map();
const GROUP_RAW = new Map(); // même index, mais avec les écritures telles qu'elles sont listées (pour les afficher)
for (const group of GROUPS) {
  const members = new Set(group.map((name) => canon(name)).filter(Boolean));
  for (const m of members) {
    const set = GROUP_INDEX.get(m) || new Set();
    for (const x of members) set.add(x);
    GROUP_INDEX.set(m, set);
    GROUP_RAW.set(m, group);
  }
}

// Groupe d'un club d'après un de ses noms : tel quel, puis sans les mots sans importance (« Marseille FC » → « Marseille »).
function lookupGroup(index, name) {
  const i = info(name);
  return index.get(i.c) || (i.core ? index.get(i.core) : null) || null;
}
const groupOf = (name) => lookupGroup(GROUP_INDEX, name);

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

// Un mot saisi correspond à un mot du club s'il est identique ou s'il en est le début (« manch » → « manchester »).
const wordMatches = (q, t) => q === t || (q.length >= 4 && t.startsWith(q));

// Ressemblance entre une écriture saisie et un nom de club : { s: 0 à 1, fuzzy: vrai si seule une ressemblance de lettres
// (faute de frappe) a été trouvée }. Chaque palier est volontairement prudent : mieux vaut « équipe introuvable » ou
// « nom ambigu » qu'une probabilité calculée pour le mauvais club.
function scoreInfo(q, n) {
  const hit = (s, fuzzy = false) => ({ s, fuzzy });
  if (!q.c || !n.c) return hit(0);
  if (q.c === n.c) return hit(1);
  // Même nom aux mots sans importance près. Si la saisie contient tout le nom du club et seulement des mots sans importance
  // en plus (« Angers FC » pour « Angers »), c'est presque une égalité ; si c'est le club qui porte un mot de plus
  // (« Paris » pour « Paris FC »), la saisie est incomplète et un autre club peut rester possible.
  if (q.core && q.core === n.core) return hit(n.words.every((w) => q.words.includes(w)) ? FULL_NAME : 0.97);
  const tq = q.tokens;
  const tc = n.tokens;
  // Tous les mots saisis se retrouvent dans le nom du club (« Real Mad » → « Real Madrid »).
  if (tq.length && tq.every((x) => tc.some((t) => wordMatches(x, t)))) return hit(Math.max(0.78, 0.9 - 0.03 * Math.max(0, tc.length - tq.length)));
  // Le nom du club est contenu dans une saisie plus longue (« Olympique de Marseille » → « Marseille »), mais seulement si ce
  // nom est assez distinctif : un mot court comme « Paris » ne doit pas faire reconnaître « Paris Saint-Germain ».
  if (tq.length && tc.length && (tc.length >= 2 || n.core.length >= 7) && tc.length / tq.length >= 0.5 && tc.every((t) => tq.includes(t))) return hit(0.8);
  // Faute de frappe : seulement sur des noms assez longs et avec la même première lettre. Sur un nom court, une lettre de
  // différence fait un autre club (« Bayern » / « Bayer », « Angers » / « Rangers »).
  const longest = Math.max(q.core.length, n.core.length);
  if (longest < 7 || q.core[0] !== n.core[0]) return hit(0);
  const sim = 1 - levenshtein(q.core, n.core) / longest;
  return sim >= 0.8 ? hit(0.6 + 0.3 * sim, true) : hit(0);
}

const scoreName = (query, candidate) => scoreInfo(info(query), info(candidate)).s;

// Écritures d'un club : son nom, son nom court, les noms alternatifs fournis par la source de données et toutes les écritures
// du groupe auquel appartient son NOM (« Paris SG » → « PSG », « Paris Saint-Germain »…).
// Les écritures s'ajoutent au club et non à la saisie : ce que l'utilisateur a tapé est comparé tel quel. Ainsi « Atlético Madrid »
// reste « Atlético Madrid » même si un autre club a « Atlético » pour nom alternatif, alors que « Atletico » seul reste ambigu.
// Les noms alternatifs ne servent pas à trouver le groupe (« Atlético », nom alternatif du club brésilien, ne le relie pas au
// groupe du club espagnol). Le résultat est gardé en mémoire : les clubs viennent d'un cache et ne changent pas à chaque requête.
const NAMES_CACHE = new WeakMap();
function namesOf(team) {
  const own = [team.name, team.shortName];
  const list = [...own, ...(Array.isArray(team.aliases) ? team.aliases : [])];
  const sig = list.join("\u0001");
  const hit = NAMES_CACHE.get(team);
  if (hit && hit.sig === sig) return hit.names;
  const seen = new Set();
  const names = [];
  const add = (raw) => {
    const i = info(raw);
    if (i.c && !seen.has(i.c)) {
      seen.add(i.c);
      names.push(i);
    }
  };
  list.forEach(add);
  for (const raw of own) {
    const group = groupOf(raw);
    if (group) group.forEach(add);
  }
  NAMES_CACHE.set(team, { sig, names });
  return names;
}

const EXACT = 0.995; // écriture identique
const FULL_NAME = 0.985; // la saisie contient le nom complet du club, avec des mots sans importance en plus

// Deux clubs qui répondent aussi bien l'un que l'autre : on demande de préciser plutôt que de choisir au hasard.
//  - un nom exact fait foi, sauf si un autre club porte exactement le même nom ;
//  - une saisie qui contient le nom complet d'un club l'emporte sur une ressemblance partielle avec un autre ;
//  - sinon, deux clubs proches en score sont ambigus, sauf si le second n'a été trouvé que par une ressemblance de lettres
//    (« Angers » ne devient pas ambigu à cause de « Rangers »).
function isAmbiguous(best, second) {
  if (!second) return false;
  if (best.score >= EXACT) return second.score >= EXACT;
  if (best.score >= FULL_NAME) return second.score >= FULL_NAME;
  if (second.fuzzy && !best.fuzzy) return false;
  return second.score >= 0.78 && best.score - second.score < 0.15;
}

// teams : [{ id, name, shortName?, aliases?, leagueKey }]
function findTeam(query, teams, { leagueKey } = {}) {
  const q = info(query);
  if (!q.c) return { team: null, score: 0, alternatives: [] };
  const pool = leagueKey ? teams.filter((t) => t.leagueKey === leagueKey) : teams;
  const scored = pool
    .map((t) => {
      let best = { s: 0, fuzzy: false };
      for (const n of namesOf(t)) {
        const r = scoreInfo(q, n);
        if (r.s > best.s || (r.s === best.s && best.fuzzy && !r.fuzzy)) best = r;
      }
      return { team: t, score: best.s, fuzzy: best.fuzzy };
    })
    .filter((x) => x.score >= 0.7)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { team: null, score: 0, alternatives: [] };
  const [best, second] = scored;
  const ambiguous = isAmbiguous(best, second);
  return {
    team: ambiguous ? null : best.team,
    score: best.score,
    ambiguous,
    alternatives: scored.slice(0, 4).map((x) => x.team.name),
  };
}

const coreOf = (s) => info(s).core;

// Index des clubs par écriture : forme comparable complète et forme sans mots sans importance (« FC », « AC »…). Sert à reconnaître
// qu'un club connu sous deux identifiants (l'un dans un championnat, l'autre dans une coupe) est un seul et même club.
// `lookup(nom)` renvoie les clubs dont une écriture est identique à `nom` à ces mots près (jamais une simple ressemblance).
function indexTeams(teams) {
  const map = new Map();
  const put = (key, team) => {
    if (!key) return;
    const set = map.get(key) || new Set();
    set.add(team);
    map.set(key, set);
  };
  for (const t of teams) {
    for (const n of namesOf(t)) {
      put(n.c, t);
      put(n.core, t);
    }
  }
  return {
    lookup(name) {
      const i = info(name);
      const found = new Set();
      for (const key of new Set([i.c, i.core])) for (const t of map.get(key) || []) found.add(t);
      return [...found];
    },
  };
}

// Écritures d'un club à montrer ou à chercher côté site (« PSG », « Man City »…), sans son nom officiel et sans doublon.
// Mêmes sources que namesOf : nom court, noms alternatifs de la source de données, écritures du groupe du club.
function spellingsOf(team, max = 16) {
  // Deux écritures qui ne diffèrent que par des mots sans importance (« Manchester City » / « Manchester City FC ») n'en font qu'une.
  const keyOf = (text) => {
    const i = info(text);
    return i.core || i.c;
  };
  const seen = new Set([keyOf(team.name)]);
  const out = [];
  const add = (raw) => {
    const text = String(raw === null || raw === undefined ? "" : raw).replace(/\s+/g, " ").trim();
    const key = keyOf(text);
    if (!key || text.length < 2 || text.length > 60 || seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  add(team.shortName);
  (Array.isArray(team.aliases) ? team.aliases : []).forEach(add);
  for (const raw of [team.name, team.shortName]) {
    const group = lookupGroup(GROUP_RAW, raw);
    if (group) group.forEach(add);
  }
  return out.slice(0, max);
}

module.exports = { findTeam, scoreName, canon, coreOf, spellingsOf, indexTeams };
