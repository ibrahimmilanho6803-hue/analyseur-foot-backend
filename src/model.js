"use strict";

const { clamp, DAY_MS } = require("./util");

// Modèle de buts de type Maher / Dixon-Coles :
//   buts domicile  ~ Poisson( base * avantage * attaque[dom] * défense[ext] )
//   buts extérieur ~ Poisson( base * attaque[ext] * défense[dom] )
// Les forces sont estimées sur les matchs passés, pondérés par leur ancienneté
// (un match récent compte plus), avec un « a priori » qui ramène vers la moyenne
// les équipes qui ont peu de matchs (par exemple les promus).

const NEUTRAL = { a: 1, d: 1, w: 0, n: 0 };

function fitLeague(matches, opts = {}) {
  const { now = Date.now(), halfLifeDays = 150, priorMatches = 4, priorFor = () => ({ a0: 1, d0: 1 }), iterations = 60 } = opts;
  const rows = [];
  const teams = new Map();
  const ensure = (id) => {
    if (!teams.has(id)) teams.set(id, { a: 1, d: 1, w: 0, n: 0 });
    return teams.get(id);
  };
  for (const m of matches) {
    if (!Number.isFinite(m.hg) || !Number.isFinite(m.ag)) continue;
    const ageDays = Math.max(0, (now - m.kickoff) / DAY_MS);
    const w = 0.5 ** (ageDays / halfLifeDays);
    if (w < 1e-4) continue;
    rows.push({ h: m.home.id, a: m.away.id, hg: m.hg, ag: m.ag, w });
    const th = ensure(m.home.id);
    const ta = ensure(m.away.id);
    th.w += w;
    ta.w += w;
    th.n += 1;
    ta.n += 1;
  }
  if (rows.length === 0) return { teams, base: 1.2, home: 1.3, nMatches: 0, wTotal: 0 };

  const wTotal = rows.reduce((s, r) => s + r.w, 0);
  let base = rows.reduce((s, r) => s + r.w * r.ag, 0) / wTotal || 1.1;
  let home = 1.3;
  const priors = new Map([...teams.keys()].map((id) => [id, priorFor(id)]));

  for (let it = 0; it < iterations; it++) {
    const sA = new Map();
    const tA = new Map();
    const sD = new Map();
    const tD = new Map();
    const add = (m, id, v) => m.set(id, (m.get(id) || 0) + v);
    for (const r of rows) {
      const th = teams.get(r.h);
      const ta = teams.get(r.a);
      add(sA, r.h, r.w * r.hg);
      add(tA, r.h, r.w * base * home * ta.d);
      add(sA, r.a, r.w * r.ag);
      add(tA, r.a, r.w * base * th.d);
      add(sD, r.h, r.w * r.ag);
      add(tD, r.h, r.w * base * ta.a);
      add(sD, r.a, r.w * r.hg);
      add(tD, r.a, r.w * base * home * th.a);
    }
    const k = priorMatches * base;
    let maxDelta = 0;
    for (const [id, t] of teams) {
      const p = priors.get(id);
      const a = ((sA.get(id) || 0) + k * p.a0) / ((tA.get(id) || 0) + k);
      const d = ((sD.get(id) || 0) + k * p.d0) / ((tD.get(id) || 0) + k);
      maxDelta = Math.max(maxDelta, Math.abs(a - t.a), Math.abs(d - t.d));
      t.a = a;
      t.d = d;
    }
    // Normalisation (moyenne des forces = 1) pour que « base » garde un sens.
    const ids = [...teams.values()];
    const mA = ids.reduce((s, t) => s + t.a, 0) / ids.length;
    const mD = ids.reduce((s, t) => s + t.d, 0) / ids.length;
    for (const t of ids) {
      t.a /= mA;
      t.d /= mD;
    }
    // Base et avantage du terrain : équations de vraisemblance exactes.
    let sumAway = 0;
    let sumHome = 0;
    let expAway = 0;
    let expHome = 0;
    for (const r of rows) {
      const th = teams.get(r.h);
      const ta = teams.get(r.a);
      sumAway += r.w * r.ag;
      sumHome += r.w * r.hg;
      expAway += r.w * ta.a * th.d;
      expHome += r.w * th.a * ta.d;
    }
    base = sumAway / expAway;
    home = sumHome / (base * expHome);
    if (maxDelta < 1e-6 && it > 3) break;
  }
  return { teams, base, home, nMatches: rows.length, wTotal };
}

function expectedGoals(fit, homeId, awayId) {
  const th = fit.teams.get(homeId) || NEUTRAL;
  const ta = fit.teams.get(awayId) || NEUTRAL;
  return {
    lh: clamp(fit.base * fit.home * th.a * ta.d, 0.2, 4.5),
    la: clamp(fit.base * ta.a * th.d, 0.2, 4.5),
  };
}

const FACT = [1];
for (let i = 1; i <= 30; i++) FACT[i] = FACT[i - 1] * i;
const pois = (k, lam) => Math.exp(-lam) * lam ** k / FACT[k];

// Matrice des scores : P[h][a] = probabilité du score h-a. Correction de
// Dixon-Coles sur les petits scores, puis renormalisation.
function scoreMatrix(lh, la, { rho = -0.08, maxGoals = 9 } = {}) {
  const M = [];
  let total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    M[h] = [];
    for (let a = 0; a <= maxGoals; a++) {
      let tau = 1;
      if (h === 0 && a === 0) tau = 1 - lh * la * rho;
      else if (h === 0 && a === 1) tau = 1 + lh * rho;
      else if (h === 1 && a === 0) tau = 1 + la * rho;
      else if (h === 1 && a === 1) tau = 1 - rho;
      const p = Math.max(0, pois(h, lh) * pois(a, la) * tau);
      M[h][a] = p;
      total += p;
    }
  }
  for (const row of M) for (let a = 0; a < row.length; a++) row[a] /= total;
  return M;
}

// Qualité des données pour un match : nombre de matchs « utiles » des deux équipes.
function dataQuality(fit, homeId, awayId) {
  const th = fit.teams.get(homeId) || NEUTRAL;
  const ta = fit.teams.get(awayId) || NEUTRAL;
  const weakest = Math.min(th.w, ta.w);
  return { weakest, level: weakest >= 12 ? 2 : weakest >= 6 ? 1 : 0, nHome: th.n, nAway: ta.n };
}

module.exports = { fitLeague, expectedGoals, scoreMatrix, dataQuality };
