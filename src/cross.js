"use strict";

const { clamp, DAY_MS } = require("./util");
const { scoreMatrix } = require("./model");

// Comparer deux clubs de championnats différents.
//
// Dans un championnat, la force d'une équipe se mesure par rapport aux autres équipes du même championnat (model.js) : une équipe
// « deux fois meilleure que la moyenne » en Écosse n'est pas deux fois meilleure que la moyenne en Angleterre. Pour comparer deux
// championnats, il faut un pont : les matchs de coupes d'Europe, où des clubs de championnats différents s'affrontent.
//
// Modèle (buts attendus d'un match entre le club h, à domicile, et le club g, à l'extérieur) :
//   log λ_h = log μ + log H + log a_h + log d_g + (s_h − s_g)
//   log λ_g = log μ         + log a_g + log d_h − (s_h − s_g)
// où a et d sont l'attaque et la défense du club dans son championnat (déjà estimées, voir model.js), μ le niveau de buts d'une
// coupe, H l'avantage du terrain et s la force « entre championnats » du club : s = δ (niveau de son championnat) + τ (écart propre
// au club, mesuré dans les coupes). Seules les différences de s comptent.
//
// Les δ ont pour point de départ un niveau a priori par championnat (leagues.js) et les τ sont ramenés vers 0 : tant qu'on a peu de
// matchs de coupe, on reste près de ces valeurs de départ ; les résultats réels ne les déplacent que dans la mesure où ils sont
// nombreux. Les paramètres sont ajustés par vraisemblance de Poisson pénalisée (matchs récents plus pesants).
//
// L'écart de force entre deux clubs de championnats différents reste incertain : au lieu d'une seule valeur, la prévision mélange
// cinq valeurs possibles (quadrature de Gauss-Hermite) pondérées selon l'incertitude. Les probabilités sont ainsi moins tranchées
// qu'entre deux clubs d'un même championnat, comme il se doit.

// Quadrature de Gauss-Hermite à 5 points pour la loi normale centrée réduite (exacte pour les polynômes jusqu'au degré 9).
const GH_NODES = [-2.856970013872805, -1.355626179974266, 0, 1.355626179974266, 2.856970013872805];
const GH_WEIGHTS = [0.01125741132772069, 0.2220759220056126, 0.5333333333333333, 0.2220759220056126, 0.01125741132772069];

const DEFAULTS = {
  halfLifeDays: 365, // mémoire des résultats de coupe
  leagueSd: 0.25, // incertitude a priori sur le niveau d'un championnat (log-buts par équipe ; 0,23 ≈ 100 points Elo)
  otherSd: 0.35, // idem pour les « autres clubs européens », ensemble disparate
  teamSdRated: 0.14, // écart propre à un club dont on connaît la force dans son championnat
  teamSdUnrated: 0.28, // écart d'un club connu seulement par les coupes d'Europe (rien d'autre ne le situe)
  structuralSd: 0.12, // part d'incertitude que les données ne réduisent pas : le modèle est une simplification (≈ 50 points Elo)
  mu0: 1.15, // buts d'une équipe qui joue à l'extérieur, niveau moyen, avant d'avoir vu des matchs
  home0: 1.3, // avantage du terrain avant d'avoir vu des matchs
  muSd: 0.2,
  homeSd: 0.12,
  calibratedWeight: 10, // matchs de coupe (pondérés) à partir desquels le niveau d'un championnat est jugé mesuré
  minWeight: 1e-3,
};

const logOf = (x) => Math.log(clamp(x, 0.05, 20));

// ---------- Algèbre : résolution d'un système symétrique défini positif (décomposition de Cholesky) ----------
function cholesky(A, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * n + j];
      for (let k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(sum > 1e-12)) return null;
        L[i * n + i] = Math.sqrt(sum);
      } else {
        L[i * n + j] = sum / L[j * n + j];
      }
    }
  }
  return L;
}

function cholSolve(L, n, b) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i * n + k] * y[k];
    y[i] = sum / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k * n + i] * x[k];
    x[i] = sum / L[i * n + i];
  }
  return x;
}

// ---------- Ajustement ----------
// matches : [{ h, g, hg, ag, kickoff }] (h = club à domicile, g = club à l'extérieur, identifiants de référence)
// describe(id) : { leagueKey, a, d, rated } — a et d : forces du club dans son championnat (1 et 1 s'il n'en a pas)
// leagues : [{ key, mean, sd? }] — niveau a priori de chaque championnat (toujours inclure « EUR » pour les clubs sans championnat suivi)
function fitCross({ matches, describe, leagues, now = Date.now(), ...custom }) {
  // Un réglage non renseigné (undefined) garde sa valeur par défaut : sinon il la remplacerait et tous les paramètres deviendraient NaN.
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== undefined)) };
  const nL = leagues.length;
  const leagueIndex = new Map(leagues.map((l, i) => [l.key, i]));
  const teamIndex = new Map(); // identifiant de club → numéro de paramètre
  const teamList = [];
  const rows = [];

  const paramMean = leagues.map((l) => l.mean);
  const paramPrec = leagues.map((l) => 1 / (l.sd || (l.key === "EUR" ? o.otherSd : o.leagueSd)) ** 2);
  const teamStats = new Map(); // identifiant → { w, n } (poids et nombre de matchs de coupe)

  const ensureTeam = (id, rated) => {
    if (!teamIndex.has(id)) {
      teamIndex.set(id, nL + teamList.length);
      teamList.push(id);
      paramMean.push(0);
      paramPrec.push(1 / (rated ? o.teamSdRated : o.teamSdUnrated) ** 2);
      teamStats.set(id, { w: 0, n: 0 });
    }
    return teamIndex.get(id);
  };

  const seen = new Set();
  for (const m of matches) {
    if (!m || m.h === m.g || !Number.isFinite(m.hg) || !Number.isFinite(m.ag)) continue;
    const key = `${m.id || ""}|${m.h}|${m.g}|${m.kickoff}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dh = describe(m.h);
    const dg = describe(m.g);
    if (!dh || !dg) continue;
    const w = 0.5 ** (Math.max(0, now - m.kickoff) / DAY_MS / o.halfLifeDays);
    if (w < o.minWeight) continue;
    const lh = leagueIndex.get(dh.leagueKey);
    const lg = leagueIndex.get(dg.leagueKey);
    if (lh === undefined || lg === undefined) continue;
    const th = ensureTeam(m.h, dh.rated);
    const tg = ensureTeam(m.g, dg.rated);
    teamStats.get(m.h).w += w;
    teamStats.get(m.h).n += 1;
    teamStats.get(m.g).w += w;
    teamStats.get(m.g).n += 1;
    rows.push({
      w,
      x: m.hg,
      y: m.ag,
      lh,
      lg,
      th,
      tg,
      // Forces des deux clubs dans leur championnat : ce que le modèle ne cherche pas à corriger (décalages fixes).
      offH: logOf(dh.a) + logOf(dg.d),
      offG: logOf(dg.a) + logOf(dh.d),
    });
  }

  const P = nL + teamList.length;
  const theta = Float64Array.from(paramMean);
  const logMu0 = Math.log(o.mu0);
  const logHome0 = Math.log(o.home0);
  let logMu = logMu0;
  let logHome = logHome0;

  // Pour chaque paramètre, les matchs où il intervient (et avec quel signe : + côté domicile, − côté extérieur).
  const adjacency = Array.from({ length: P }, () => []);
  rows.forEach((r, i) => {
    if (r.lh !== r.lg) {
      adjacency[r.lh].push([i, 1]);
      adjacency[r.lg].push([i, -1]);
    }
    adjacency[r.th].push([i, 1]);
    adjacency[r.tg].push([i, -1]);
  });

  const n = rows.length;
  const lamH = new Float64Array(n);
  const lamG = new Float64Array(n);
  const delta = (r) => theta[r.lh] + theta[r.th] - theta[r.lg] - theta[r.tg];
  const refresh = () => {
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const u = delta(r);
      lamH[i] = Math.exp(clamp(logMu + logHome + r.offH + u, -6, 3));
      lamG[i] = Math.exp(clamp(logMu + r.offG - u, -6, 3));
    }
  };
  refresh();

  if (n > 0) {
    for (let sweep = 0; sweep < 300; sweep++) {
      let biggest = 0;
      for (let j = 0; j < P; j++) {
        const adj = adjacency[j];
        if (!adj.length) continue;
        let g = 0;
        let h = 0;
        for (const [i, c] of adj) {
          const r = rows[i];
          g += c * r.w * (r.x - lamH[i] - (r.y - lamG[i]));
          h += r.w * (lamH[i] + lamG[i]);
        }
        g -= (theta[j] - paramMean[j]) * paramPrec[j];
        h += paramPrec[j];
        const step = clamp(g / h, -0.5, 0.5);
        if (step === 0) continue;
        theta[j] += step;
        for (const [i, c] of adj) {
          const f = Math.exp(c * step);
          lamH[i] *= f;
          lamG[i] /= f;
        }
        biggest = Math.max(biggest, Math.abs(step));
      }
      // Niveau de buts (μ) puis avantage du terrain (H) : même méthode, avec un a priori peu contraignant.
      let gm = 0;
      let hm = 0;
      for (let i = 0; i < n; i++) {
        const r = rows[i];
        gm += r.w * (r.x - lamH[i] + (r.y - lamG[i]));
        hm += r.w * (lamH[i] + lamG[i]);
      }
      gm -= (logMu - logMu0) / o.muSd ** 2;
      hm += 1 / o.muSd ** 2;
      const stepMu = clamp(gm / hm, -0.5, 0.5);
      logMu += stepMu;
      const fMu = Math.exp(stepMu);
      for (let i = 0; i < n; i++) {
        lamH[i] *= fMu;
        lamG[i] *= fMu;
      }
      let gh = 0;
      let hh = 0;
      for (let i = 0; i < n; i++) {
        gh += rows[i].w * (rows[i].x - lamH[i]);
        hh += rows[i].w * lamH[i];
      }
      gh -= (logHome - logHome0) / o.homeSd ** 2;
      hh += 1 / o.homeSd ** 2;
      const stepHome = clamp(gh / hh, -0.5, 0.5);
      logHome += stepHome;
      const fHome = Math.exp(stepHome);
      for (let i = 0; i < n; i++) lamH[i] *= fHome;
      biggest = Math.max(biggest, Math.abs(stepMu), Math.abs(stepHome));
      if (biggest < 1e-7) break;
    }
    refresh();
  }

  // Poids de coupe (entre championnats seulement) de chaque championnat : sert à dire s'il est « mesuré ».
  const leagueWeight = new Float64Array(nL);
  for (const r of rows) {
    if (r.lh === r.lg) continue;
    leagueWeight[r.lh] += r.w;
    leagueWeight[r.lg] += r.w;
  }

  // Matrice d'information (hessienne de la vraisemblance pénalisée) : calculée seulement si l'on demande une incertitude.
  let chol;
  const factor = () => {
    if (chol !== undefined) return chol;
    const H = new Float64Array(P * P);
    for (let j = 0; j < P; j++) H[j * P + j] += paramPrec[j];
    const idx = [0, 0, 0, 0];
    const sgn = [1, 1, -1, -1];
    rows.forEach((r, i) => {
      const wl = r.w * (lamH[i] + lamG[i]);
      idx[0] = r.lh;
      idx[1] = r.th;
      idx[2] = r.lg;
      idx[3] = r.tg;
      // Quand les deux clubs ont le même championnat, son niveau n'intervient pas dans l'écart.
      const used = r.lh === r.lg ? [1, 3] : [0, 1, 2, 3];
      for (const a of used) for (const b of used) H[idx[a] * P + idx[b]] += wl * sgn[a] * sgn[b];
    });
    chol = cholesky(H, P);
    return chol;
  };

  // Variance de combinaison linéaire des paramètres : coefficients = Map(numéro de paramètre → coefficient).
  const varianceOf = (coefs) => {
    const L = factor();
    const b = new Float64Array(P);
    for (const [j, c] of coefs) b[j] += c;
    if (!L) {
      let v = 0;
      for (const [j, c] of coefs) v += (c * c) / paramPrec[j];
      return v;
    }
    const x = cholSolve(L, P, b);
    let v = 0;
    for (const [j, c] of coefs) v += c * x[j];
    return Math.max(0, v);
  };

  const leagueInfo = (key) => {
    const i = leagueIndex.get(key);
    if (i === undefined) return null;
    return {
      key,
      value: theta[i],
      prior: paramMean[i],
      priorSd: 1 / Math.sqrt(paramPrec[i]),
      weight: leagueWeight[i],
      calibrated: leagueWeight[i] >= o.calibratedWeight,
    };
  };

  const sOf = (d) => {
    const li = leagueIndex.get(d.leagueKey);
    const ti = teamIndex.get(d.id);
    return (li === undefined ? 0 : theta[li]) + (ti === undefined ? 0 : theta[ti]);
  };

  // Prévision pour h (domicile) contre g (extérieur). Chaque descripteur : { id, leagueKey, a, d, rated }.
  function predict(h, g) {
    const delta = sOf(h) - sOf(g);
    const eh = logMu + logHome + logOf(h.a) + logOf(g.d);
    const eg = logMu + logOf(g.a) + logOf(h.d);
    const coefs = new Map();
    const add = (j, c) => coefs.set(j, (coefs.get(j) || 0) + c);
    let extra = 0;
    const involve = (d, sign) => {
      const li = leagueIndex.get(d.leagueKey);
      if (li !== undefined) add(li, sign);
      const ti = teamIndex.get(d.id);
      if (ti !== undefined) add(ti, sign);
      else extra += (d.rated ? o.teamSdRated : o.teamSdUnrated) ** 2; // aucun match de coupe : l'écart propre au club reste à sa valeur a priori
    };
    involve(h, 1);
    involve(g, -1);
    // Deux clubs du même championnat : le niveau du championnat s'annule.
    if (h.leagueKey === g.leagueKey) {
      const li = leagueIndex.get(h.leagueKey);
      if (li !== undefined) coefs.delete(li);
    }
    const fitted = varianceOf(coefs) + extra;
    const variance = fitted + o.structuralSd ** 2;
    return {
      lh: clamp(Math.exp(eh + delta), 0.2, 4.5),
      la: clamp(Math.exp(eg - delta), 0.2, 4.5),
      delta,
      fittedSd: Math.sqrt(fitted),
      sd: Math.sqrt(variance),
      variance,
    };
  }

  return {
    mu: Math.exp(logMu),
    home: Math.exp(logHome),
    nMatches: n,
    wTotal: rows.reduce((s, r) => s + r.w, 0),
    leagues: leagues.map((l) => leagueInfo(l.key)),
    league: leagueInfo,
    team: (id) => {
      const ti = teamIndex.get(id);
      const st = teamStats.get(id);
      return ti === undefined ? null : { tau: theta[ti], w: st.w, n: st.n };
    },
    predict,
    options: o,
  };
}

// Matrice des scores d'un match entre championnats : moyenne de cinq matrices, une par écart de force possible.
// Chaque matrice garde les buts attendus moyens du match (correction −v/2 en échelle logarithmique).
function crossMatrix(pred, { rho, maxGoals }) {
  const sd = pred.sd;
  const v = pred.variance;
  let out = null;
  GH_NODES.forEach((node, k) => {
    const shift = sd * node;
    const lh = clamp(pred.lh * Math.exp(shift - v / 2), 0.2, 4.5);
    const la = clamp(pred.la * Math.exp(-shift - v / 2), 0.2, 4.5);
    const M = scoreMatrix(lh, la, { rho, maxGoals });
    if (!out) out = M.map((row) => row.map((p) => p * GH_WEIGHTS[k]));
    else M.forEach((row, h) => row.forEach((p, a) => (out[h][a] += p * GH_WEIGHTS[k])));
  });
  return out;
}

module.exports = { fitCross, crossMatrix, cholesky, cholSolve, GH_NODES, GH_WEIGHTS, DEFAULTS };
