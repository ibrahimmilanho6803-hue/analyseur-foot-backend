"use strict";

// Remplace fetch par de faux services (football-data.org et API Anthropic) afin de tester le vrai
// server.js sans réseau. Les faux services refusent ce que les vrais refuseraient (Sonnet 5.5 :
// pas de température, pas de réflexion « disabled », pas de préremplissage, etc.).
const { simulateLeague, mulberry32, poissonSample } = require("../helpers");
const { NAMES } = require("../world");

const realFetch = globalThis.fetch;
const DAY = 86400000;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Championnats simulés (codes football-data.org) : les championnats nationaux, la deuxième division anglaise (ELC) et la Ligue des champions (CL).
const CODES = ["PL", "PD", "SA", "BL1", "FL1", "PPL", "DED", "BSA", "ELC"];
// Championnats dont les clubs jouent la Ligue des champions simulée, avec leur vrai niveau (écart de log-buts par équipe).
const CUP_LEVEL = { PL: 0, PD: -0.12, SA: -0.2, BL1: -0.2, FL1: -0.4, PPL: -0.55, DED: -0.5 };
const worlds = new Map();

// Un club est identifié de la même façon dans son championnat et en coupe (comme chez football-data.org).
const teamObj = (code, i) => {
  const n = CODES.indexOf(code);
  return { id: 1000 * (n + 1) + i, name: (NAMES[code] || [])[i] || `Club ${code} ${i}`, shortName: `${code}${i}`, tla: `${code}${i}`.slice(0, 3) };
};

function world(code) {
  if (worlds.has(code)) return worlds.get(code);
  const n = CODES.indexOf(code);
  const sim = simulateLeague({ teams: 14, seasons: 3, seed: 100 + n, now: Date.now() });
  const idx = (id) => Number(id.slice(1));
  const team = (id) => teamObj(code, idx(id));
  const played = sim.matches.map((m) => ({ id: 100000 * (n + 1) + Number(m.id.slice(1)), utcDate: new Date(m.kickoff).toISOString(), status: "FINISHED", homeTeam: team(m.home.id), awayTeam: team(m.away.id), score: { fullTime: { home: m.hg, away: m.ag } } }));
  const upcoming = Array.from({ length: 7 }, (_, k) => ({
    id: 900000 * (n + 1) + k,
    utcDate: new Date(Date.now() + (3 + k * 9) * 3600000).toISOString(),
    status: "TIMED",
    homeTeam: team(`T${k}`),
    awayTeam: team(`T${k + 7}`),
    score: { fullTime: { home: null, away: null } },
  }));
  const w = { played, upcoming, truth: sim.truth };
  worlds.set(code, w);
  return w;
}

// Ligue des champions simulée : des clubs de championnats différents, dont les buts suivent la force de chaque club et le niveau de son championnat.
function cupWorld() {
  if (worlds.has("CL")) return worlds.get("CL");
  const rand = mulberry32(4242);
  const pool = [];
  for (const code of Object.keys(CUP_LEVEL)) {
    const truth = world(code).truth;
    for (const [id, t] of truth) pool.push({ code, team: teamObj(code, Number(id.slice(1))), a: t.a, d: t.d, level: CUP_LEVEL[code] });
  }
  const now = Date.now();
  const thisYear = new Date(now).getUTCMonth() >= 6 ? new Date(now).getUTCFullYear() : new Date(now).getUTCFullYear() - 1;
  const draw = (from, to, count, base) => {
    const out = [];
    while (out.length < count) {
      const h = pool[Math.floor(rand() * pool.length)];
      const g = pool[Math.floor(rand() * pool.length)];
      if (h.code === g.code) continue;
      const u = h.level - g.level;
      out.push({
        id: base + out.length,
        utcDate: new Date(from + Math.floor(rand() * (to - from))).toISOString(),
        status: "FINISHED",
        homeTeam: h.team,
        awayTeam: g.team,
        score: { fullTime: { home: poissonSample(Math.min(6, 1.1 * 1.3 * h.a * g.d * Math.exp(u)), rand), away: poissonSample(Math.min(6, 1.1 * g.a * h.d * Math.exp(-u)), rand) } },
      });
    }
    return out;
  };
  const find = (code, i) => teamObj(code, i);
  const fixture = (id, hours, h, g) => ({ id, utcDate: new Date(now + hours * 3600000).toISOString(), status: "TIMED", homeTeam: h, awayTeam: g, score: { fullTime: { home: null, away: null } } });
  const current = [...draw(Date.UTC(thisYear, 7, 1), now - 3 * DAY, 160, 8000000), fixture(8100000, 20, find("PL", 0), find("PD", 0)), fixture(8100001, 31, find("SA", 2), find("BL1", 1)), fixture(8100002, 44, find("FL1", 3), find("PL", 1))];
  const previous = draw(Date.UTC(thisYear - 1, 7, 1), Date.UTC(thisYear, 4, 25), 190, 8200000);
  const w = { current, previous };
  worlds.set("CL", w);
  return w;
}

function seasonMatches(code, season) {
  if (code === "CL") {
    const { current, previous } = cupWorld();
    const now = Date.now();
    const thisYear = new Date(now).getUTCMonth() >= 6 ? new Date(now).getUTCFullYear() : new Date(now).getUTCFullYear() - 1;
    return season === thisYear ? current : season === thisYear - 1 ? previous : [];
  }
  const { played, upcoming } = world(code);
  const lo = Date.UTC(season, 6, 1);
  const hi = Date.UTC(season + 1, 6, 1);
  const inSeason = played.filter((m) => Date.parse(m.utcDate) >= lo && Date.parse(m.utcDate) < hi);
  const fut = upcoming.filter((m) => Date.parse(m.utcDate) >= lo && Date.parse(m.utcDate) < hi);
  return [...inSeason, ...fut];
}

function checkAnthropic(headers, body) {
  const bad = (message) => json(400, { type: "error", error: { type: "invalid_request_error", message } });
  if (headers["x-api-key"] !== "sk-ant-fake") return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
  if (!headers["anthropic-version"]) return bad("anthropic-version header is required");
  if (body.model !== "claude-sonnet-5-5") return json(404, { type: "error", error: { type: "not_found_error", message: `model: ${body.model}` } });
  for (const k of ["temperature", "top_p", "top_k", "output_format"]) if (k in body) return bad(`${k} is not supported for this model`);
  if (body.thinking && body.thinking.type !== "adaptive" && body.thinking.type !== "between_tools") return bad('To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}.');
  if (body.tool_choice && body.tool_choice.type !== "auto") return bad('tool_choice: type "tool" and "any" are not supported for this model.');
  const last = body.messages && body.messages[body.messages.length - 1];
  if (!last || last.role !== "user") return bad("This model does not support assistant message prefill.");
  const oc = body.output_config;
  if (oc) {
    if (oc.effort && !["low", "medium", "high", "xhigh", "max"].includes(oc.effort)) return bad("invalid effort");
    if (body.thinking && body.thinking.type === "between_tools" && ["xhigh", "max"].includes(oc.effort)) return bad("between_tools is not supported at this effort");
    if (oc.format) {
      const walk = (n) => {
        if (n && typeof n === "object") {
          if (n.type === "object" && n.additionalProperties !== false) throw new Error("additionalProperties must be false");
          Object.values(n).forEach(walk);
        }
      };
      try {
        walk(oc.format.schema);
      } catch (e) {
        return bad(e.message);
      }
    }
  }
  const text = JSON.stringify({ ajustement_points: 0.5, confiance: "moyen", justification: "Analyse de test : les chiffres du modèle sont cohérents avec la forme récente.", vigilance: "" });
  return json(200, {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: body.model,
    stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "", signature: "fake" }, { type: "text", text }],
    usage: { input_tokens: 600, output_tokens: 80 },
  });
}

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.host === "api.football-data.org") {
    const headers = init.headers || {};
    if (headers["X-Auth-Token"] !== "fake-fd-key") return json(403, { message: "invalid token" });
    const m = u.pathname.match(/^\/v4\/competitions\/([A-Z0-9]+)\/matches$/);
    if (!m || (m[1] !== "CL" && !CODES.includes(m[1]))) return json(404, { message: "not found" });
    return json(200, { matches: seasonMatches(m[1], Number(u.searchParams.get("season"))) });
  }
  if (u.host === "api.anthropic.com" && u.pathname === "/v1/messages") {
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return checkAnthropic(headers, JSON.parse(init.body));
  }
  return realFetch(url, init);
};
