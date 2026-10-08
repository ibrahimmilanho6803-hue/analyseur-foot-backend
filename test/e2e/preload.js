"use strict";

// Remplace fetch par de faux services (football-data.org et API Anthropic) afin de tester le vrai
// server.js sans réseau. Les faux services refusent ce que les vrais refuseraient (Sonnet 5.5 :
// pas de température, pas de réflexion « disabled », pas de préremplissage, etc.).
const { simulateLeague } = require("../helpers");
const { NAMES } = require("../world");

const realFetch = globalThis.fetch;
const DAY = 86400000;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CODES = ["PL", "PD", "SA", "BL1", "FL1", "PPL", "DED", "BSA"];
const worlds = new Map();

function world(code) {
  if (worlds.has(code)) return worlds.get(code);
  const n = CODES.indexOf(code);
  const sim = simulateLeague({ teams: 14, seasons: 3, seed: 100 + n, now: Date.now() });
  const idx = (id) => Number(id.slice(1));
  const team = (id) => ({ id: 1000 * (n + 1) + idx(id), name: (NAMES[code] || [])[idx(id)] || `Club ${code} ${idx(id)}`, shortName: `${code}${idx(id)}`, tla: `${code}${idx(id)}`.slice(0, 3) });
  const played = sim.matches.map((m) => ({ id: 100000 * (n + 1) + Number(m.id.slice(1)), utcDate: new Date(m.kickoff).toISOString(), status: "FINISHED", homeTeam: team(m.home.id), awayTeam: team(m.away.id), score: { fullTime: { home: m.hg, away: m.ag } } }));
  const upcoming = Array.from({ length: 7 }, (_, k) => ({
    id: 900000 * (n + 1) + k,
    utcDate: new Date(Date.now() + (3 + k * 9) * 3600000).toISOString(),
    status: "TIMED",
    homeTeam: team(`T${k}`),
    awayTeam: team(`T${k + 7}`),
    score: { fullTime: { home: null, away: null } },
  }));
  const w = { played, upcoming };
  worlds.set(code, w);
  return w;
}

function seasonMatches(code, season) {
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
    if (!m || !CODES.includes(m[1])) return json(404, { message: "not found" });
    return json(200, { matches: seasonMatches(m[1], Number(u.searchParams.get("season"))) });
  }
  if (u.host === "api.anthropic.com" && u.pathname === "/v1/messages") {
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return checkAnthropic(headers, JSON.parse(init.body));
  }
  return realFetch(url, init);
};
