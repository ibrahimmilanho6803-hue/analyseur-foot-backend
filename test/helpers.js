"use strict";

// Outils de test : tirage au hasard reproductible et championnat fictif.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poissonSample(lambda, rand) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

const DAY = 86400000;

// Championnat fictif : chaque équipe a une force d'attaque et de défense connue.
function simulateLeague({ teams = 12, seasons = 3, seed = 7, base = 1.25, home = 1.3, now = Date.UTC(2026, 9, 8) } = {}) {
  const rand = mulberry32(seed);
  const truth = new Map();
  for (let i = 0; i < teams; i++) {
    truth.set(`T${i}`, { a: 0.7 + rand() * 0.7, d: 0.75 + rand() * 0.55 });
  }
  const ids = [...truth.keys()];
  const matches = [];
  let n = 0;
  const seasonLen = teams * (teams - 1) * 1.2;
  for (let s = 0; s < seasons; s++) {
    // La dernière saison se termine une semaine avant « now » ; les précédentes sont espacées d'environ un an.
    const seasonStart = now - 7 * DAY - seasonLen * DAY - (seasons - 1 - s) * 330 * DAY;
    let day = 0;
    for (let leg = 0; leg < 2; leg++) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = 0; j < ids.length; j++) {
          if (i === j) continue;
          if ((leg === 0) !== (i < j)) continue;
          const h = truth.get(ids[i]);
          const a = truth.get(ids[j]);
          day += 1.2;
          matches.push({
            id: `M${n++}`,
            kickoff: seasonStart + Math.floor(day) * DAY,
            home: { id: ids[i], name: `Equipe ${ids[i]}` },
            away: { id: ids[j], name: `Equipe ${ids[j]}` },
            hg: poissonSample(base * home * h.a * a.d, rand),
            ag: poissonSample(base * a.a * h.d, rand),
            status: "finished",
          });
        }
      }
    }
  }
  matches.sort((x, y) => x.kickoff - y.kickoff);
  return { matches, truth, now, base, home };
}

function correlation(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

module.exports = { mulberry32, poissonSample, simulateLeague, correlation, DAY };
