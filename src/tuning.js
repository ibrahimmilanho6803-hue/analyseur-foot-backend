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

// Niveau de buts : le modèle prévoit-il autant de buts par match qu'il n'en est marqué ? Un écart durable fausse « plus de 2.5 buts »,
// « les deux équipes marquent »… sans changer le 1-N-2 : on corrige donc le niveau de buts attendus (coefficient sur les deux équipes).
// `bt` est un contrôle de fiabilité fait SANS coefficient de niveau (il mesure l'écart du modèle brut, quel que soit le coefficient
// déjà en service). L'écart est exprimé en marges d'erreur (z = écart ÷ erreur-type de la moyenne des buts) et la correction est
// réduite d'autant que l'écart est incertain : on n'en garde que la fraction 1 − 1/z² (nulle à z = 1, 75 % à z = 2, 91 % à z = 3,3),
// ce qui donne une correction continue (jamais de saut d'un jour à l'autre) et aucune sur un écart noyé dans le hasard.
// Le coefficient est borné (± 8 %). Il peut monter comme baisser : c'est un niveau, pas une prudence.
function levelCalibration(bt, { minMatches = 600, maxFactor = 1.08 } = {}) {
  const goals = bt && bt.butsParMatch;
  const n = bt ? bt.matchsEvalues : 0;
  if (!goals || !(n >= minMatches) || !(goals.prevus > 0) || !(goals.reels > 0)) {
    return { factor: 1, info: { applique: false, raison: "pas assez de matchs récents pour mesurer", matchs: n || 0 } };
  }
  // Dispersion des buts réels ; à défaut, celle d'une loi de Poisson légèrement dispersée.
  const sd = goals.ecartTypeReels > 0 ? goals.ecartTypeReels : Math.sqrt(goals.reels * 1.1);
  const z = (goals.reels - goals.prevus) / (sd / Math.sqrt(n));
  const keep = Math.max(0, 1 - 1 / (z * z));
  const wanted = 1 + (goals.reels / goals.prevus - 1) * keep;
  const factor = round(clamp(wanted, 1 / maxFactor, maxFactor), 3);
  const base = { matchs: n, butsPrevus: goals.prevus, butsReels: goals.reels, ecartEnMargesDerreur: round(z, 1) };
  if (factor === 1) return { factor: 1, info: { applique: false, raison: "écart trop faible ou trop incertain, aucune correction", ...base } };
  const capped = factor !== round(wanted, 3);
  return {
    factor,
    info: {
      applique: true,
      raison: `${goals.reels > goals.prevus ? "il se marque plus de buts que prévu" : "il se marque moins de buts que prévu"} : niveau de buts ${factor > 1 ? "relevé" : "abaissé"}${capped ? " (correction plafonnée)" : ""}`,
      coefficient: factor,
      ...base,
    },
  };
}

// Réglage automatique du modèle : au démarrage puis une fois par jour, on rejoue les matchs récents
// avec plusieurs réglages et on garde le meilleur (seulement si le gain est net).
// `levelMinMatches` : nombre minimal de matchs récents pour oser corriger le niveau de buts.
function createTuner({ config, data, analysis = null, now = Date.now, log = console, levelMinMatches = 600 }) {
  const state = { last: null, running: false };

  async function run() {
    if (state.running) return state.last;
    state.running = true;
    try {
      const { ready } = await data.ensureAll({ budgetMs: 60000 });
      const leagues = ready.map((d) => ({ key: d.league.key, finished: d.finished }));
      const current = data.getModelParams();
      const fixed = { rho: config.model.rho, maxGoals: config.model.maxGoals };
      const result = config.model.autoTune
        ? await tuneModel(leagues, {
            now: now(),
            // Les réglages essayés sont comparés avec la correction des totaux déjà en service, comme dans les réponses du serveur.
            current: { halfLifeDays: current.halfLifeDays, priorMatches: current.priorMatches },
            grid: config.model.tuneGrid,
            model: { ...fixed, ...current },
          })
        : { changed: false, raison: "réglage automatique désactivé", candidats: [], retenu: { halfLifeDays: current.halfLifeDays, priorMatches: current.priorMatches } };

      // Niveau de buts : mesuré sur les 180 derniers jours avec les réglages retenus, sans coefficient (voir levelCalibration).
      let niveau;
      if (config.model.calibration === false) {
        niveau = { factor: 1, info: { applique: false, raison: "correction désactivée (MODEL_CALIBRATION=off)" } };
      } else {
        const bt = await runBacktestAsync(leagues, { now: now(), evalDays: 180, stepDays: 14, model: { ...fixed, ...current, ...result.retenu, levelFactor: 1 } });
        niveau = levelCalibration(bt, { minMatches: levelMinMatches });
      }

      if (data.setModelParams({ ...result.retenu, levelFactor: niveau.factor })) {
        // Les forces des équipes sont recalculées tout de suite (sans re-télécharger les matchs), pas à la prochaine demande.
        await data.ensureAll({ budgetMs: 60000 });
      }
      if (result.changed) {
        log.log(`[modèle] réglage retenu : demi-vie ${result.retenu.halfLifeDays} j, a priori ${result.retenu.priorMatches} matchs (${result.raison})`);
      } else {
        log.log(`[modèle] réglage conservé : demi-vie ${result.retenu.halfLifeDays} j, a priori ${result.retenu.priorMatches} matchs (${result.raison})`);
      }
      log.log(`[modèle] niveau de buts : ${niveau.info.raison}${niveau.info.applique ? ` (coefficient ${niveau.factor}, ${niveau.info.butsReels} buts réels contre ${niveau.info.butsPrevus} prévus)` : ""}`);

      let calibrage = null;
      if (analysis) {
        const bt = await runBacktestAsync(leagues, {
          now: now(),
          evalDays: 150,
          stepDays: 7,
          model: { ...fixed, ...data.getModelParams() },
          pick: { minP: config.top.minLegP, maxP: config.top.maxLegP },
        });
        const cal = pickCalibration(bt.paris);
        analysis.setPickShift(cal.shift, cal.info);
        calibrage = cal.info;
        log.log(`[modèle] paris automatiques : ${cal.info.raison}`);
      }
      state.last = { le: new Date(now()).toISOString(), ...result, niveauDeButs: niveau.info, calibrage };
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

module.exports = { createTuner, pickCalibration, levelCalibration };
