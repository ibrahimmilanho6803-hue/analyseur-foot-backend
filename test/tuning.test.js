"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTuner, pickCalibration, levelCalibration } = require("../src/tuning");
const { buildWorld, NOW } = require("./world");
const { mulberry32, poissonSample, DAY } = require("./helpers");

const quiet = { log() {}, warn() {}, error() {} };
const paris = (matchs, predit, observe) => ({ matchs, probabiliteMoyennePredite: predit, tauxDeReussiteReel: observe, ecart: Math.round((observe - predit) * 1000) / 1000 });

test("correction des paris automatiques : seulement vers le bas et seulement si l'écart est net", () => {
  assert.equal(pickCalibration(null).shift, 0);
  assert.equal(pickCalibration(paris(120, 0.83, 0.7)).shift, 0, "trop peu de matchs pour conclure");
  assert.equal(pickCalibration(paris(600, 0.83, 0.84)).shift, 0, "mieux que prévu : pas de relèvement");
  assert.equal(pickCalibration(paris(600, 0.83, 0.82)).shift, 0, "écart dans la marge d'erreur");
  const down = pickCalibration(paris(600, 0.83, 0.77));
  assert.equal(down.info.applique, true);
  assert.ok(Math.abs(down.shift + 0.06) < 1e-9);
  assert.equal(pickCalibration(paris(900, 0.85, 0.55)).shift, -0.1, "correction plafonnée à 10 points");
});

function bigWorld() {
  const w = buildWorld({ aiBehaviour: "off" });
  w.config.model.tuneGrid = { halfLifeDays: [300], priorMatches: [10] };
  return w;
}

test("réglage automatique et contrôle : sur des données bien décrites par le modèle, aucune correction notable", async () => {
  const w = bigWorld();
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet });
  const r = await tuner.run();
  assert.ok(r.calibrage, "le contrôle des paris automatiques a été fait");
  assert.ok(Math.abs(w.analysis.calibration.pickShift) <= 0.06, `décalage ${w.analysis.calibration.pickShift}`);
  const { halfLifeDays, priorMatches } = w.data.getModelParams();
  assert.deepEqual(tuner.status().retenu, { halfLifeDays, priorMatches });
});

test("résultats récents bien plus pauvres en buts que prévu : les probabilités des paris automatiques sont abaissées", async () => {
  const w = bigWorld();
  const rand = mulberry32(5);
  const cut = NOW - 150 * DAY;
  // Depuis cinq mois, les scores ne suivent plus du tout le modèle (0,5 et 0,35 but par équipe, quelle que soit l'équipe) : les paris que
  // l'application choisit (autour de 67 % de chances : « plus de 1.5 buts », « victoire ou nul »…) se réalisent nettement moins souvent.
  for (const key of Object.keys(w.store)) {
    for (const season of ["cur", "prev"]) {
      w.store[key][season] = w.store[key][season].map((m) => (m.status === "finished" && m.kickoff >= cut ? { ...m, hg: poissonSample(0.5, rand), ag: poissonSample(0.35, rand) } : m));
    }
  }
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet });
  const before = await w.coupons.topMatches();
  assert.equal(before.topMatches[0].ajustementCalibrage, undefined);
  const r = await tuner.run();
  assert.equal(r.calibrage.applique, true, JSON.stringify(r.calibrage));
  assert.ok(r.calibrage.observee < r.calibrage.annoncee - 0.05, JSON.stringify(r.calibrage));
  assert.ok(w.analysis.calibration.pickShift < -0.02);
  w.clock.t += 20 * 60000;
  const after = await w.coupons.topMatches();
  for (const m of after.topMatches) {
    assert.ok(m.ajustementCalibrage < 0);
    assert.ok(m.probabilite < m.probabiliteModele, `${m.probabilite} devrait être sous ${m.probabiliteModele}`);
  }
  assert.ok(Number(after.coteTotale) > 0);
});

test("auto-coupon : la correction s'applique aussi aux paris choisis automatiquement", async () => {
  const w = bigWorld();
  w.analysis.setPickShift(-0.05, { applique: true });
  const r = await w.coupons.autoCoupon([{ equipe1: "Arsenal", equipe2: "Chelsea" }]);
  assert.equal(r.resultats[0].ajustementCalibrage, -5);
  assert.ok(Math.abs(r.resultats[0].probabilite - (r.resultats[0].probabiliteModele - 5)) < 0.2);
  // Une sélection choisie par l'utilisateur n'est pas corrigée.
  const [own] = await w.analysis.analyzeLegs([{ equipe1: "Arsenal", equipe2: "Chelsea", typePari: "Plus de 1.5 buts" }]);
  assert.equal(own.ajustementCalibrage, undefined);
});

test("la correction ne peut jamais relever une probabilité", () => {
  const w = bigWorld();
  w.analysis.setPickShift(0.2, {});
  assert.equal(w.analysis.calibration.pickShift, 0);
});

test("réglage automatique désactivé : le contrôle des paris reste actif", async () => {
  const w = bigWorld();
  w.config.model.autoTune = false;
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet });
  const r = await tuner.run();
  assert.equal(r.changed, false);
  assert.match(r.raison, /désactivé/);
  assert.ok(r.calibrage);
});

test("un seul réglage à la fois, et une panne de données ne casse rien", async () => {
  const w = buildWorld({ failing: ["PL", "PD", "SA"], aiBehaviour: "off" });
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet });
  const [a, b] = await Promise.all([tuner.run(), tuner.run()]);
  assert.equal(b, null, "le second appel simultané n'ouvre pas un second calcul");
  assert.equal(a.changed, false);
  assert.equal(a.calibrage.applique, false);
  assert.equal(w.analysis.calibration.pickShift, 0);
});

test("réglage automatique : un changement de réglage recharge aussi les coupes et les championnats complémentaires", async () => {
  const w = buildWorld({ keys: ["PL", "PD", "SA", "ELC"], cups: true, aiBehaviour: "off" });
  w.config.model.tuneGrid = { halfLifeDays: [300], priorMatches: [10] };
  await w.data.ensureAll({ budgetMs: 5000, scope: "all" });
  assert.ok(w.data.peekLeague("UCL") && w.data.peekLeague("ELC"), "tout est chargé avant le réglage");
  // Un coefficient de niveau en service différent de celui que le réglage va mesurer : le réglage changera donc les paramètres du modèle,
  // ce qui efface tous les championnats en mémoire.
  w.data.setModelParams({ levelFactor: 1.05 });
  assert.equal(w.data.peekLeague("UCL"), null, "l'effacement a bien lieu");
  await w.data.ensureAll({ budgetMs: 5000, scope: "all" });
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet });
  await tuner.run();
  assert.notEqual(w.data.getModelParams().levelFactor, 1.05, "le réglage a bien changé le coefficient (sinon ce test ne prouve rien)");
  // Les championnats complémentaires sont rechargés en arrière-plan : on leur laisse le temps de finir.
  for (let i = 0; i < 400 && !(w.data.peekLeague("ELC") && w.data.peekLeague("UCL")); i++) await new Promise((r) => setImmediate(r));
  assert.ok(w.data.peekLeague("UCL"), "la coupe est rechargée");
  assert.ok(w.data.peekLeague("ELC"), "le championnat complémentaire est rechargé");
  const [r] = await w.analysis.analyzeLegs([{ equipe1: "Leeds United", equipe2: "Norwich City", typePari: "Victoire domicile" }], { withAi: false });
  assert.equal(r.etat, "ok", "un match d'un championnat complémentaire reste analysable juste après le réglage");
});

// ---- Niveau de buts ----

const report = (matchs, prevus, reels, ecartTypeReels = 1.65) => ({ matchsEvalues: matchs, butsParMatch: { prevus, reels, ecartTypeReels } });

test("niveau de buts : la correction est proportionnelle à l'écart, réduite quand il est incertain, bornée, et peut baisser comme monter", () => {
  // 1 300 matchs, 2,75 buts prévus, 2,90 réels : l'écart vaut 3,3 marges d'erreur, la correction en garde environ 91 %.
  const up = levelCalibration(report(1300, 2.75, 2.9));
  assert.equal(up.info.applique, true);
  assert.ok(Math.abs(up.factor - 1.0495) < 0.001, `${up.factor}`);
  assert.equal(up.info.coefficient, up.factor);
  assert.ok(up.info.ecartEnMargesDerreur > 3 && up.info.ecartEnMargesDerreur < 3.6, JSON.stringify(up.info));
  assert.match(up.info.raison, /plus de buts que prévu.*relevé/);

  // Le même écart sur moins de matchs est plus incertain : moins de correction.
  const fewer = levelCalibration(report(650, 2.75, 2.9));
  assert.ok(fewer.factor > 1 && fewer.factor < up.factor, `${fewer.factor} devrait être entre 1 et ${up.factor}`);

  // Un écart noyé dans le hasard ne corrige rien (le coefficient reste exactement 1).
  for (const noisy of [report(1300, 2.75, 2.77), report(1300, 2.75, 2.73), report(700, 2.75, 2.8)]) {
    const r = levelCalibration(noisy);
    assert.equal(r.factor, 1, JSON.stringify(r));
    assert.equal(r.info.applique, false);
    assert.match(r.info.raison, /trop faible ou trop incertain/);
  }

  // Dans l'autre sens : trop de buts prévus, le niveau baisse.
  const down = levelCalibration(report(1300, 2.9, 2.75));
  assert.ok(down.factor < 1 && down.factor > 0.94, `${down.factor}`);
  assert.match(down.info.raison, /moins de buts que prévu.*abaissé/);

  // Plafond de ± 8 %, signalé.
  const capped = levelCalibration(report(1300, 2.5, 3.2));
  assert.equal(capped.factor, 1.08);
  assert.match(capped.info.raison, /plafonnée/);
  assert.equal(levelCalibration(report(1300, 3.4, 2.5)).factor, Math.round((1 / 1.08) * 1000) / 1000);
});

test("niveau de buts : pas assez de matchs ou mesure illisible, aucune correction", () => {
  for (const bad of [null, undefined, {}, { matchsEvalues: 0, butsParMatch: null }, report(300, 2.5, 3.2), report(1300, 0, 2.9), report(1300, 2.75, 0)]) {
    const r = levelCalibration(bad);
    assert.equal(r.factor, 1);
    assert.equal(r.info.applique, false);
    assert.match(r.info.raison, /pas assez de matchs/);
  }
  assert.equal(levelCalibration(report(300, 2.5, 3.2), { minMatches: 200 }).info.applique, true, "le seuil est un réglage");
  // Sans écart-type fourni, la dispersion d'une loi de Poisson légèrement dispersée sert de repli.
  const fallback = levelCalibration({ matchsEvalues: 1300, butsParMatch: { prevus: 2.75, reels: 2.9 } });
  assert.equal(fallback.info.applique, true);
});

// Même monde, mais les 180 derniers jours comptent plus de buts (« boost » fois plus) que ne le laissait prévoir l'historique,
// avec les mêmes forces d'équipes : chaque but marqué en attire d'autres en proportion.
function hotWorld(boost, env = {}) {
  const w = buildWorld({ aiBehaviour: "off", env });
  w.config.model.tuneGrid = { halfLifeDays: [300], priorMatches: [10] };
  const rand = mulberry32(21);
  const cut = NOW - 180 * DAY;
  const more = (goals) => goals + poissonSample((boost - 1) * goals, rand);
  for (const key of Object.keys(w.store)) {
    for (const season of ["cur", "prev"]) {
      w.store[key][season] = w.store[key][season].map((m) => (m.status === "finished" && m.kickoff >= cut ? { ...m, hg: more(m.hg), ag: more(m.ag) } : m));
    }
  }
  return w;
}

const totalGoals = async (w, home = "Arsenal", away = "Chelsea") => {
  const [r] = await w.analysis.analyzeLegs([{ equipe1: home, equipe2: away, typePari: "Plus de 2.5 buts" }], { withAi: false });
  return r;
};

test("niveau de buts : un écart net est corrigé chaque jour, les probabilités de totaux suivent, le 1-N-2 reste cohérent", async () => {
  const w = hotWorld(1.12);
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet, levelMinMatches: 100 });
  const before = await totalGoals(w);
  assert.equal(w.data.getModelParams().levelFactor, 1);
  const r = await tuner.run();
  const n = r.niveauDeButs;
  assert.equal(n.applique, true, JSON.stringify(n));
  assert.ok(n.coefficient > 1 && n.coefficient <= 1.08, JSON.stringify(n));
  assert.ok(n.butsReels > n.butsPrevus);
  assert.equal(w.data.getModelParams().levelFactor, n.coefficient, "le coefficient est en service");
  assert.deepEqual(tuner.status().niveauDeButs, n, "visible dans l'état du serveur");

  // Les forces d'équipes ont été recalculées tout de suite : plus de buts attendus, donc « plus de 2.5 buts » plus probable.
  w.clock.t += 20 * 60000; // les mises en cache de l'analyse expirent
  const after = await totalGoals(w);
  assert.ok(after.probabiliteModele > before.probabiliteModele, `${after.probabiliteModele} devrait dépasser ${before.probabiliteModele}`);

  // Le lendemain, la mesure repart du modèle brut (sans coefficient) : le coefficient ne s'empile pas, il reste du même ordre.
  w.clock.t += 24 * 3600000;
  const again = (await tuner.run()).niveauDeButs;
  assert.ok(Math.abs(again.coefficient - n.coefficient) < 0.03, `${again.coefficient} contre ${n.coefficient}`);
  assert.equal(w.data.getModelParams().levelFactor, again.coefficient);
});

test("niveau de buts : un écart énorme est plafonné à 8 %", async () => {
  const w = hotWorld(1.5);
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet, levelMinMatches: 100 });
  const r = await tuner.run();
  assert.equal(r.niveauDeButs.coefficient, 1.08);
  assert.match(r.niveauDeButs.raison, /plafonnée/);
});

test("niveau de buts : sur des données bien décrites par le modèle, le coefficient reste proche de 1", async () => {
  const w = bigWorld();
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet, levelMinMatches: 100 });
  const r = await tuner.run();
  assert.ok(Math.abs(w.data.getModelParams().levelFactor - 1) < 0.04, JSON.stringify(r.niveauDeButs));
});

test("niveau de buts : trop peu de matchs récents (seuil par défaut), le coefficient reste à 1 et la raison est donnée", async () => {
  const w = hotWorld(1.3);
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet });
  const r = await tuner.run();
  assert.equal(r.niveauDeButs.applique, false);
  assert.match(r.niveauDeButs.raison, /pas assez de matchs/);
  assert.equal(w.data.getModelParams().levelFactor, 1);
});

test("MODEL_CALIBRATION=off : ni rythme rapproché ni coefficient de niveau, même si l'écart est net", async () => {
  const w = hotWorld(1.3, { MODEL_CALIBRATION: "off" });
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet, levelMinMatches: 100 });
  const r = await tuner.run();
  assert.equal(r.niveauDeButs.applique, false);
  assert.match(r.niveauDeButs.raison, /désactivée/);
  assert.deepEqual(w.data.getModelParams(), { halfLifeDays: 300, priorMatches: 10, rhythmExponent: 1, levelFactor: 1 });
});

test("niveau de buts : un coefficient en service est retiré quand l'écart disparaît", async () => {
  const w = bigWorld();
  w.data.setModelParams({ levelFactor: 1.06 });
  const tuner = createTuner({ config: w.config, data: w.data, analysis: w.analysis, now: () => w.clock.t, log: quiet });
  await tuner.run(); // seuil par défaut : trop peu de matchs pour confirmer, donc retour à 1 plutôt qu'un coefficient jamais vérifié
  assert.equal(w.data.getModelParams().levelFactor, 1);
});
