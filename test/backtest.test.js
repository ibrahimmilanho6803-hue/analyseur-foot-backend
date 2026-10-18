"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runBacktest, runBacktestAsync, tuneModel, tallyPick } = require("../src/backtest");
const { simulateLeague, mulberry32, poissonSample, DAY } = require("./helpers");

const sims = [1, 2, 3, 4, 5].map((seed) => simulateLeague({ teams: 18, seasons: 4, seed }));
const leagues = sims.map((s, i) => ({ key: `SIM${i}`, finished: s.matches }));
const NOW = sims[0].now;
const OPTS = { now: NOW, evalDays: 300, stepDays: 14 };

test("le modèle fait mieux que la référence sur des matchs rejoués pas à pas", () => {
  const r = runBacktest(leagues, OPTS);
  assert.ok(r.matchsEvalues > 800, `${r.matchsEvalues} matchs`);
  assert.ok(r.resultat1N2.gainPct > 1.5, `gain ${r.resultat1N2.gainPct} %`);
  assert.ok(r.resultat1N2.brierModele < r.resultat1N2.brierReference);
  // Au moins la moitié des marchés suivis s'améliorent.
  const better = r.marches.filter((m) => m.brierModele < m.brierReference).length;
  assert.ok(better >= Math.ceil(r.marches.length / 2), `${better} marchés meilleurs que la référence sur ${r.marches.length}`);
  assert.match(r.lecture, /fait mieux/);
});

test("les paris choisis automatiquement se réalisent à peu près aussi souvent qu'annoncé", () => {
  const r = runBacktest(leagues, OPTS);
  assert.ok(r.paris.matchs > 800);
  assert.ok(Math.abs(r.paris.ecart) < 0.04, `écart ${r.paris.ecart}`);
});

test("paris automatiques sans limite de cote : toujours le plus probable, aucune plage, aucun match écarté", () => {
  const r = runBacktest(leagues, OPTS);
  assert.match(r.paris.description, /le plus probable, sans limite de cote/);
  assert.equal(r.paris.matchs, r.matchsEvalues, "chaque match reçoit un pari");
  assert.ok(r.paris.probabiliteMoyennePredite > 0.9, `${r.paris.probabiliteMoyennePredite} : ce sont les paris les plus sûrs`);
  assert.ok(Math.abs(r.paris.ecart) < 0.03, `écart ${r.paris.ecart}`);
});

test("paris automatiques avec un plafond de probabilité : plus de paris quasi certains, les lignes entières remboursées ne comptent pas", () => {
  const free = runBacktest(leagues, OPTS);
  const capped = runBacktest(leagues, { ...OPTS, pick: { maxP: 0.9 } });
  assert.match(capped.paris.description, /jusqu'à 90 %/);
  assert.ok(capped.paris.probabiliteMoyennePredite < free.paris.probabiliteMoyennePredite - 0.05);
  assert.ok(capped.paris.probabiliteMoyennePredite <= 0.9);
  // Sous le plafond, des paris « plus de 1 but » ou « moins de 2 buts » deviennent les plus probables : quand le total tombe pile sur la
  // ligne ils sont remboursés, donc écartés du décompte (la probabilité annoncée est celle de gagner quand le pari n'est pas remboursé).
  assert.ok(capped.paris.matchs < capped.matchsEvalues, `${capped.paris.matchs} sur ${capped.matchsEvalues}`);
  // … et les probabilités annoncées restent justes, remboursements compris.
  assert.ok(Math.abs(capped.paris.ecart) < 0.03, `écart ${capped.paris.ecart}`);
});

test("paris automatiques d'un coupon équilibré : des paris proches de la probabilité visée, entre le plancher et le plafond, bien calibrés", () => {
  const near = runBacktest(leagues, { ...OPTS, pick: { target: 0.67, minP: 0.6, maxP: 0.88 } });
  assert.match(near.paris.description, /le plus proche de 67 % de chances, entre 60 % et 88 %/);
  assert.equal(near.paris.matchs > 0.8 * near.matchsEvalues, true, `${near.paris.matchs} sur ${near.matchsEvalues}`);
  assert.ok(Math.abs(near.paris.probabiliteMoyennePredite - 0.67) < 0.025, `${near.paris.probabiliteMoyennePredite}`);
  assert.ok(Math.abs(near.paris.ecart) < 0.04, `écart ${near.paris.ecart}`);
  const free = runBacktest(leagues, OPTS);
  assert.ok(near.paris.probabiliteMoyennePredite < free.paris.probabiliteMoyennePredite - 0.2, "bien moins sûrs que les paris les plus probables");
});

test("tallyPick : un pari remboursé n'est ni gagné ni perdu, il n'entre pas dans le décompte", () => {
  const picks = { n: 0, sp: 0, hits: 0 };
  tallyPick(picks, { label: "Plus de 2 buts", p: 0.7 }, 1, 1); // exactement 2 buts : remboursé
  tallyPick(picks, { label: "Équipe 1 moins de 1 but", p: 0.6 }, 1, 3); // l'équipe 1 marque exactement 1 but : remboursé
  assert.deepEqual(picks, { n: 0, sp: 0, hits: 0 });
  tallyPick(picks, { label: "Plus de 2 buts", p: 0.7 }, 2, 1); // gagné
  tallyPick(picks, { label: "Plus de 2 buts", p: 0.7 }, 0, 1); // perdu
  assert.equal(picks.n, 2);
  assert.ok(Math.abs(picks.sp - 1.4) < 1e-12);
  assert.equal(picks.hits, 1);
  tallyPick(picks, { label: "Victoire équipe 1 et plus de 0.5 buts", p: 0.5 }, 1, 0); // pari ordinaire gagné
  assert.deepEqual([picks.n, picks.hits], [3, 2]);
});

test("calibration : les tranches bien fournies restent proches de la réalité", () => {
  const r = runBacktest(leagues, OPTS);
  for (const b of r.calibration.filter((x) => x.matchs >= 200)) {
    assert.ok(Math.abs(b.probabilitePredite - b.frequenceObservee) < 0.06, `${b.tranche} : prédit ${b.probabilitePredite}, observé ${b.frequenceObservee}`);
  }
});

test("aucune fuite d'information : si les résultats récents n'ont aucun lien avec la force des équipes, le modèle ne « gagne » pas", () => {
  const rand = mulberry32(99);
  const cut = NOW - OPTS.evalDays * DAY;
  const noisy = leagues.map((l) => ({
    key: l.key,
    finished: l.finished.map((m) => (m.kickoff >= cut ? { ...m, hg: poissonSample(1.45, rand), ag: poissonSample(1.15, rand) } : m)),
  }));
  const r = runBacktest(noisy, OPTS);
  assert.ok(r.resultat1N2.gainPct < 0.8, `gain suspect : ${r.resultat1N2.gainPct} %`);
});

test("version asynchrone : même résultat, et le serveur garde la main entre deux championnats", async () => {
  let yields = 0;
  const a = await runBacktestAsync(leagues.slice(0, 2), OPTS, async () => {
    yields++;
  });
  const b = runBacktest(leagues.slice(0, 2), OPTS);
  assert.equal(yields, 2);
  assert.deepEqual(a, b);
});

test("pas assez de matchs : message clair plutôt qu'un chiffre trompeur", () => {
  const few = [{ key: "X", finished: sims[0].matches.slice(0, 50) }];
  const r = runBacktest(few, OPTS);
  assert.equal(r.matchsEvalues, 0);
  assert.equal(r.resultat1N2, null);
  assert.match(r.lecture, /Pas assez/);
});

test("réglage automatique : compare plusieurs réglages et ne change que pour un gain net", async () => {
  const grid = { halfLifeDays: [100, 300, 500], priorMatches: [4, 10] };
  const t = await tuneModel(leagues.slice(0, 3), { now: NOW, current: { halfLifeDays: 300, priorMatches: 10 }, grid, evalDays: 300, stepDays: 14 });
  assert.equal(t.candidats.length, 6);
  assert.ok(t.candidats.every((c) => Number.isFinite(c.brier1N2)));
  assert.ok(t.retenu.halfLifeDays >= 300, "les forces sont stables dans la simulation : un historique court ne doit pas gagner");
  // Si le réglage actuel est déjà le meilleur, rien ne change.
  const same = await tuneModel(leagues.slice(0, 3), { now: NOW, current: t.retenu, grid, evalDays: 300, stepDays: 14 });
  assert.equal(same.changed, false);
  assert.deepEqual(same.retenu, t.retenu);
});

test("réglage automatique : exige un gain minimal avant de changer", async () => {
  const grid = { halfLifeDays: [300, 500], priorMatches: [10] };
  const t = await tuneModel(leagues.slice(0, 2), { now: NOW, current: { halfLifeDays: 300, priorMatches: 10 }, grid, evalDays: 300, stepDays: 14, minGain: 0.5 });
  assert.equal(t.changed, false);
  assert.deepEqual(t.retenu, { halfLifeDays: 300, priorMatches: 10 });
});

test("réglage automatique : sans données suffisantes, le réglage actuel est conservé", async () => {
  const t = await tuneModel([{ key: "X", finished: [] }], { now: NOW, current: { halfLifeDays: 300, priorMatches: 10 }, grid: { halfLifeDays: [300], priorMatches: [10] } });
  assert.equal(t.changed, false);
  assert.deepEqual(t.retenu, { halfLifeDays: 300, priorMatches: 10 });
  assert.deepEqual(t.candidats, []);
});

test("rapport : pente de calibration, buts par match prévus et réels, réglages utilisés", () => {
  const r = runBacktest(leagues, OPTS);
  assert.ok(r.butsParMatch.prevus > 1);
  assert.ok(Math.abs(r.butsParMatch.prevus / r.butsParMatch.reels - 1) < 0.06, JSON.stringify(r.butsParMatch));
  for (const m of r.marches) assert.ok(Number.isFinite(m.pente), m.marche);
  const home = r.marches.find((m) => m.marche === "Victoire équipe 1");
  assert.ok(home.pente > 0.7 && home.pente < 1.3, `pente ${home.pente}`);
  assert.ok(r.parChampionnat.every((c) => c.butsPrevus > 0 && c.butsReels > 0));
  assert.equal(r.parametres.modele.demiVieJours, 300);
  assert.equal(r.parametres.modele.niveauDemiVieJours, null);
  assert.equal(r.parametres.modele.coefficientDeNiveau, 1);
});

// Championnats dont le nombre de buts monte nettement sur les derniers mois (le modèle à longue mémoire est alors en retard).
function hotterLeagues(factor, lastDays) {
  return [1, 2, 3, 4, 5].map((seed) => {
    const sim = simulateLeague({ teams: 18, seasons: 4, seed });
    const rand = mulberry32(seed * 31 + 7);
    const cut = sim.now - lastDays * DAY;
    const finished = sim.matches.map((m) => {
      if (m.kickoff < cut) return m;
      const h = sim.truth.get(m.home.id);
      const a = sim.truth.get(m.away.id);
      return { ...m, hg: poissonSample(factor * sim.base * sim.home * h.a * a.d, rand), ag: poissonSample(factor * sim.base * a.a * h.d, rand) };
    });
    return { key: `HOT${seed}`, finished };
  });
}

test("niveau de buts : une hausse récente est mieux suivie avec une mémoire courte, et « plus de 2.5 buts » est moins biaisé", () => {
  const hot = hotterLeagues(1.25, 150);
  const opts = { now: NOW, evalDays: 120, stepDays: 14, model: { halfLifeDays: 500, priorMatches: 4 } };
  const plain = runBacktest(hot, opts);
  const quick = runBacktest(hot, { ...opts, model: { ...opts.model, levelHalfLifeDays: 60, levelPriorMatches: 20 } });
  const gap = (r) => 1 - r.butsParMatch.prevus / r.butsParMatch.reels;
  assert.ok(gap(plain) > 0.1, `retard sans réglage : ${gap(plain)}`);
  assert.ok(gap(quick) < 0.8 * gap(plain), `retard avec réglage : ${gap(quick)} contre ${gap(plain)}`);
  const over = (r) => r.marches.find((m) => m.marche === "Plus de 2.5 buts");
  const bias = (r) => Math.abs(over(r).frequenceReelle - over(r).probabiliteMoyenne);
  assert.ok(bias(quick) < bias(plain), `biais ${bias(quick)} contre ${bias(plain)}`);
  assert.ok(over(quick).brierModele < over(plain).brierModele);
  assert.equal(quick.parametres.modele.niveauDemiVieJours, 60);
});

test("niveau de buts : sans hausse, la mémoire courte ne dégrade pas le résultat 1-N-2", () => {
  const plain = runBacktest(leagues, OPTS);
  const quick = runBacktest(leagues, { ...OPTS, model: { levelHalfLifeDays: 90, levelPriorMatches: 40 } });
  assert.ok(quick.resultat1N2.brierModele < plain.resultat1N2.brierModele * 1.01, `${quick.resultat1N2.brierModele} contre ${plain.resultat1N2.brierModele}`);
});

test("rapport : marchés supplémentaires, dispersion des buts, tranches de calibration comparables aux anciens contrôles", () => {
  const r = runBacktest(leagues, OPTS);
  const labels = r.marches.map((m) => m.marche);
  for (const label of ["Plus de 3.5 buts", "Équipe 1 plus de 0.5 buts", "Équipe 2 plus de 0.5 buts", "Équipe 1 plus de 1.5 buts", "Équipe 2 plus de 1.5 buts"]) {
    assert.ok(labels.includes(label), label);
  }
  assert.deepEqual(labels.slice(0, 8), ["Victoire équipe 1", "Match nul", "Victoire équipe 2", "Victoire ou nul équipe 1", "Victoire ou nul équipe 2", "Plus de 1.5 buts", "Plus de 2.5 buts", "Les deux équipes marquent"]);
  assert.ok(r.butsParMatch.ecartTypeReels > 1 && r.butsParMatch.ecartTypeReels < 2.5, JSON.stringify(r.butsParMatch));
  // Seuls les 8 premiers marchés alimentent les tranches de calibration.
  assert.equal(r.calibration.reduce((s, b) => s + b.matchs, 0), 8 * r.matchsEvalues);
});

// Championnats où toutes les équipes ont le même rythme réel (seule leur force diffère) : le rythme estimé n'y est que du bruit.
const constantRhythm = (rand) => {
  const q = 0.7 + rand() * 0.8;
  return { a: Math.sqrt(q), d: 1 / Math.sqrt(q) };
};
const calmLeagues = [1, 2, 3, 4, 5].map((seed) => ({ key: `CALM${seed}`, finished: simulateLeague({ teams: 18, seasons: 4, seed, makeTeam: constantRhythm }).matches }));

test("rythme : le rapprocher de la moyenne améliore les totaux de buts sans abîmer le 1-N-2, contrairement à un exposant unique", () => {
  const run = (model) => runBacktest(calmLeagues, { now: NOW, evalDays: 300, stepDays: 14, model: { halfLifeDays: 500, priorMatches: 4, ...model } });
  const plain = run({});
  const calm = run({ rhythmExponent: 0.3 });
  const uniform = run({ strengthExponent: 0.3 });
  const brier = (r, label) => r.marches.find((m) => m.marche === label).brierModele;
  for (const label of ["Plus de 1.5 buts", "Plus de 2.5 buts", "Les deux équipes marquent", "Équipe 1 plus de 1.5 buts"]) {
    assert.ok(brier(calm, label) < brier(plain, label), `${label} : ${brier(calm, label)} contre ${brier(plain, label)}`);
  }
  assert.ok(calm.resultat1N2.brierModele <= plain.resultat1N2.brierModele * 1.001, `${calm.resultat1N2.brierModele} contre ${plain.resultat1N2.brierModele}`);
  assert.ok(uniform.resultat1N2.brierModele > plain.resultat1N2.brierModele * 1.01, "un exposant unique rapproche aussi les forces et abîme le 1-N-2");
  assert.equal(calm.parametres.modele.exposantRythme, 0.3);
  assert.equal(calm.parametres.modele.exposantForce, null);
  assert.equal(plain.parametres.modele.exposantRythme, null);
});
