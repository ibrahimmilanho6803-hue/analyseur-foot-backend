"use strict";

const { tuneModel, runBacktestAsync } = require("./backtest");
const { clamp, round } = require("./util");

// Les paris choisis automatiquement se réalisent-ils aussi souvent qu'annoncé ? Sinon, on abaisse
// leurs probabilités de l'écart observé (jamais l'inverse), à condition que l'écart soit net.
function pickCalibration(paris) {
  if (!paris || paris.matchs < 300) {
    return { shift: 0, info: { applique: false, raison: "pas assez de matchs récents pour mesurer", matchs: paris ? paris.matchs : 0 } };
  }
  const gap = paris.ecart; // observé - annoncé
  const se = Math.sqrt((paris.tauxDeReussiteReel * (1 - paris.tauxDeReussiteReel)) / paris.matchs);
  const base = { matchs: paris.matchs, annoncee: paris.probabiliteMoyennePredite, observee: paris.tauxDeReussiteReel };
  if (gap < -1.5 * se) {
    const shift = clamp(gap, -0.1, 0);
    return { shift, info: { applique: true, raison: "les paris se réalisent moins souvent que prévu : probabilités abaissées", decalagePoints: round(shift * 100, 1), ...base } };
  }
  return { shift: 0, info: { applique: false, raison: "écart non significatif, aucune correction", ...base } };
}

// Réglage automatique du modèle : au démarrage puis une fois par jour, on rejoue les matchs récents
// avec plusieurs réglages et on garde le meilleur (seulement si le gain est net).
function createTuner({ config, data, analysis = null, now = Date.now, log = console }) {
  const state = { last: null, running: false };

  async function run() {
    if (state.running) return state.last;
    state.running = true;
    try {
      const { ready } = await data.ensureAll({ budgetMs: 60000 });
      const leagues = ready.map((d) => ({ key: d.league.key, finished: d.finished }));
      const current = data.getModelParams();
      const result = config.model.autoTune
        ? await tuneModel(leagues, {
            now: now(),
            current,
            grid: config.model.tuneGrid,
            model: { rho: config.model.rho, maxGoals: config.model.maxGoals },
          })
        : { changed: false, raison: "réglage automatique désactivé", candidats: [], retenu: current };
      if (result.changed) {
        data.setModelParams(result.retenu);
        log.log(`[modèle] réglage retenu : demi-vie ${result.retenu.halfLifeDays} j, a priori ${result.retenu.priorMatches} matchs (${result.raison})`);
      } else {
        log.log(`[modèle] réglage conservé : demi-vie ${current.halfLifeDays} j, a priori ${current.priorMatches} matchs (${result.raison})`);
      }
      let calibrage = null;
      if (analysis) {
        const chosen = data.getModelParams();
        const bt = await runBacktestAsync(leagues, {
          now: now(),
          evalDays: 150,
          stepDays: 7,
          model: { rho: config.model.rho, maxGoals: config.model.maxGoals, ...chosen },
          pick: { minP: config.top.minLegP, maxP: config.top.maxLegP },
        });
        const cal = pickCalibration(bt.paris);
        analysis.setPickShift(cal.shift, cal.info);
        calibrage = cal.info;
        log.log(`[modèle] paris automatiques : ${cal.info.raison}`);
      }
      state.last = { le: new Date(now()).toISOString(), ...result, calibrage };
    } catch (e) {
      log.warn(`[modèle] réglage automatique impossible : ${e.message}`);
    } finally {
      state.running = false;
    }
    return state.last;
  }

  function schedule() {
    const timer = setInterval(() => run(), 24 * 3600000);
    timer.unref();
    return timer;
  }

  return { run, schedule, status: () => state.last };
}

module.exports = { createTuner, pickCalibration };
