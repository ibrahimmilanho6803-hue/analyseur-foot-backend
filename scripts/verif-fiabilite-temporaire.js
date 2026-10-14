"use strict";

// TEMPORAIRE : prévisions « pas à pas » sur de vrais résultats (football-data.co.uk) avec le code de la branche à contrôler.
// Pour chaque semaine, le modèle est ajusté avec les seuls matchs déjà joués (saison en cours + saison précédente, comme en production),
// puis on enregistre, pour chaque match de la semaine, les buts attendus (lh, la) et le score réel. L'analyse se fait ensuite hors ligne.
// Usage : node scripts/verif-fiabilite-temporaire.js <dossier du code à contrôler> <fichier de sortie .jsonl>

const fs = require("fs");
const path = require("path");

const codeDir = path.resolve(process.argv[2] || "code");
const outFile = process.argv[3] || "donnees-predictions.jsonl";
const { fitLeague, expectedGoals } = require(path.join(codeDir, "src/model"));

const DAY = 86400000;
const SEASONS = ["2122", "2223", "2324", "2425", "2526", "2627"];
const DIVS = ["E0", "E1", "E2", "E3", "SC0", "SC1", "D1", "D2", "I1", "I2", "SP1", "SP2", "F1", "F2", "N1", "B1", "P1", "T1", "G1"];
const EVAL_FROM = Date.UTC(2024, 7, 1); // début de la saison 2024-2025
const MODEL = { halfLifeDays: 300, priorMatches: 10, rhythmExponent: 0.5, levelFactor: 1, strengthExponent: 1, levelHalfLifeDays: 0 };
const MIN_TRAIN = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCsv(text, div) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split(",").map((s) => s.trim());
  const ix = (name) => head.indexOf(name);
  const iD = ix("Date");
  const iT = ix("Time");
  const iH = ix("HomeTeam");
  const iA = ix("AwayTeam");
  const iHG = ix("FTHG");
  const iAG = ix("FTAG");
  if ([iD, iH, iA, iHG, iAG].some((i) => i < 0)) return [];
  const out = [];
  for (const line of lines.slice(1)) {
    const f = line.split(",");
    const hg = Number(f[iHG]);
    const ag = Number(f[iAG]);
    const home = (f[iH] || "").trim();
    const away = (f[iA] || "").trim();
    const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec((f[iD] || "").trim());
    if (!dm || !home || !away || f[iHG] === "" || f[iAG] === "" || !Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const year = Number(dm[3]) < 100 ? 2000 + Number(dm[3]) : Number(dm[3]);
    const tm = iT >= 0 ? /^(\d{1,2}):(\d{2})$/.exec((f[iT] || "").trim()) : null;
    const kickoff = Date.UTC(year, Number(dm[2]) - 1, Number(dm[1]), tm ? Number(tm[1]) : 15, tm ? Number(tm[2]) : 0);
    out.push({ kickoff, home: { id: `${div}:${home}`, name: home }, away: { id: `${div}:${away}`, name: away }, hg, ag });
  }
  return out;
}

async function download(season, div) {
  const url = `https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (verification temporaire)" } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt === 3) {
        console.log(`  échec ${season}/${div} : ${e.message}`);
        return null;
      }
      await sleep(1500 * attempt);
    }
  }
  return null;
}

// Début de la saison précédente (1er juillet) pour une date donnée : en production, le modèle connaît la saison en cours et la précédente.
function previousSeasonStart(t) {
  const d = new Date(t);
  const startYear = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return Date.UTC(startYear - 1, 6, 1);
}

async function main() {
  const byDiv = new Map();
  let files = 0;
  for (const div of DIVS) {
    const all = [];
    for (const season of SEASONS) {
      const text = await download(season, div);
      await sleep(150);
      if (!text) continue;
      const rows = parseCsv(text, div);
      if (rows.length) files++;
      all.push(...rows);
    }
    all.sort((a, b) => a.kickoff - b.kickoff);
    byDiv.set(div, all);
    console.log(`${div} : ${all.length} matchs joués (${all.length ? new Date(all[0].kickoff).toISOString().slice(0, 10) : "-"} → ${all.length ? new Date(all[all.length - 1].kickoff).toISOString().slice(0, 10) : "-"})`);
  }
  console.log(`${files} fichiers lus`);

  const now = Date.now();
  const lines = [];
  const perDiv = {};
  for (const [div, finished] of byDiv) {
    let n = 0;
    for (let t = EVAL_FROM; t < now; t += 7 * DAY) {
      const block = finished.filter((m) => m.kickoff >= t && m.kickoff < Math.min(now, t + 7 * DAY));
      if (!block.length) continue;
      const since = previousSeasonStart(t);
      const train = finished.filter((m) => m.kickoff < t && m.kickoff >= since);
      if (train.length < MIN_TRAIN) continue;
      const fit = fitLeague(train, { now: t, ...MODEL });
      for (const m of block) {
        const th = fit.teams.get(m.home.id);
        const ta = fit.teams.get(m.away.id);
        if (!th || !ta) continue;
        const { lh, la } = expectedGoals(fit, m.home.id, m.away.id);
        lines.push(JSON.stringify({ d: div, t: m.kickoff, h: m.home.name, a: m.away.name, hg: m.hg, ag: m.ag, lh: Math.round(lh * 1e5) / 1e5, la: Math.round(la * 1e5) / 1e5, nh: th.n, na: ta.n }));
        n++;
      }
    }
    perDiv[div] = n;
  }
  fs.writeFileSync(outFile, lines.join("\n") + "\n");
  console.log(`${lines.length} prévisions enregistrées dans ${outFile}`);
  console.log(JSON.stringify(perDiv));
}

main().catch((e) => {
  console.error("ERREUR", e);
  process.exit(1);
});
