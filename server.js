"use strict";

require("dotenv").config({ quiet: true });

const { loadConfig } = require("./src/config");
const { createHttp } = require("./src/http");
const { createDataService } = require("./src/data");
const { createAi } = require("./src/ai");
const { createAnalysis } = require("./src/analysis");
const { createCoupons } = require("./src/coupons");
const { createTuner } = require("./src/tuning");
const { createApp } = require("./src/app");

const config = loadConfig(process.env);
const log = console;

if (!config.providers.order.length) log.warn("[config] Aucune source de données : définissez FOOTBALL_DATA_API_KEY (football-data.org, offre gratuite).");
if (!config.anthropic.key) log.warn("[config] ANTHROPIC_API_KEY absente : l'IA est désactivée, seul le modèle statistique répond.");

const http = createHttp();
const data = createDataService({ config, http, log });
const ai = createAi({ config, http, log });
const analysis = createAnalysis({ config, data, ai, log });
const coupons = createCoupons({ config, data, analysis, log });
const tuner = createTuner({ config, data, analysis, log });
const app = createApp({ config, data, ai, analysis, coupons, tuner, log });

const server = app.listen(config.port, "0.0.0.0", () => {
  log.log(`Analyseur Foot Pro API (modèle IA : ${config.anthropic.model}) — port ${config.port}`);

  // Données chargées en tâche de fond : « Top Matchs » répond ensuite instantanément.
  const warm = data.warmUp();
  warm.ready
    .then(() => tuner.run())
    .then(() => coupons.topMatches())
    .catch((e) => log.warn(`[démarrage] préchauffage incomplet : ${e.message}`));
  tuner.schedule();
  setInterval(() => coupons.topMatches().catch(() => {}), 5 * 60000).unref();
});

function shutdown(signal) {
  log.log(`${signal} reçu, arrêt en cours…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log.error(`[erreur non gérée] ${e && e.message}`));
