"use strict";

// Championnats complémentaires (ici la deuxième division anglaise « ELC ») : chargés après les autres, utiles pour analyser un match saisi
// à la main, jamais retenus pour « Top Matchs ».
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildWorld, NOW, HOUR } = require("./world");

const leg = (equipe1, equipe2, typePari = "Victoire domicile") => ({ equipe1, equipe2, typePari });
const world = (extra = {}) => buildWorld({ keys: ["PL", "PD", "SA", "ELC"], cups: true, aiBehaviour: "off", ...extra });

test("tant que les championnats complémentaires se chargent, un club pas encore connu donne « chargement » et non « équipe introuvable »", async () => {
  const w = world();
  const [early] = await w.analysis.analyzeLegs([leg("Leeds", "Leicester")]);
  assert.equal(early.etat, "chargement");
  assert.match(early.message, /en cours de chargement/);
  assert.equal(w.data.peekLeague("ELC"), null, "une demande n'attend pas les championnats complémentaires");
  // ... pendant ce temps, les championnats principaux et la coupe répondent normalement
  const [main] = await w.analysis.analyzeLegs([leg("Arsenal", "Real Madrid")]);
  assert.equal(main.etat, "ok");
  await w.data.ensureAll({ scope: "extras" });
  const [late] = await w.analysis.analyzeLegs([leg("Leeds", "Leicester")]);
  assert.equal(late.etat, "ok");
});

test("match d'un championnat complémentaire : analysé comme un match de championnat, avec sa date", async () => {
  const w = world();
  await w.data.ensureAll({ scope: "all" });
  const [r] = await w.analysis.analyzeLegs([leg("Leeds United", "Watford", "Victoire ou nul domicile")]);
  assert.equal(r.etat, "ok");
  assert.equal(r.equipe1, "Leeds United FC");
  assert.equal(r.equipe2, "Watford FC");
  assert.equal(r.competition, "Championship");
  assert.equal(r.date, new Date(NOW + 4 * HOUR).toISOString());
  assert.equal(r.comparaisonEntreChampionnats, undefined, "un même championnat : aucun avertissement de comparaison");
  assert.ok(r.probabilite > 20 && r.probabilite < 99);
  assert.ok(r.statsEquipe1.forme.length > 0);
  assert.equal(r.niveauConfiance, "eleve");
});

test("un club d'un championnat complémentaire contre un club d'un championnat principal : comparaison signalée comme peu précise", async () => {
  const w = world();
  await w.data.ensureAll({ scope: "all" });
  const [home, away] = await w.analysis.analyzeLegs([leg("Arsenal", "Leeds United", "Victoire domicile"), leg("Leeds United", "Arsenal", "Victoire domicile")]);
  assert.equal(home.etat, "ok");
  assert.equal(home.competition, "Match entre clubs de championnats différents");
  assert.equal(home.comparaisonEntreChampionnats.championnat2, "Championship");
  assert.equal(home.comparaisonEntreChampionnats.niveauDesChampionnatsMesure, false, "aucun match de coupe ne situe ce championnat");
  assert.match(home.comparaisonEntreChampionnats.message, /estimation générale/);
  assert.equal(home.niveauConfiance, "faible");
  assert.ok(home.probabilite > 55, `Arsenal, d'un niveau supérieur, est favori chez lui : ${home.probabilite}`);
  assert.ok(away.probabilite < 45, `et Leeds chez Arsenal est outsider : ${away.probabilite}`);
  // le niveau du championnat complémentaire reste à sa valeur a priori
  const row = w.europe.status().niveauxDesChampionnats.find((l) => l.key === "ELC");
  assert.equal(row.niveauEstime, row.niveauAPriori);
  assert.equal(row.mesure, false);
});

test("Top Matchs ne retient jamais de championnat complémentaire, même chargé", async () => {
  const w = world();
  await w.data.ensureAll({ scope: "all" });
  assert.ok(w.data.peekLeague("ELC"));
  const r = await w.coupons.topMatches();
  assert.deepEqual(r.donnees.championnatsPrets, ["PL", "PD", "SA"]);
  assert.ok(r.topMatches.every((m) => m.competition !== "Championship"));
  const only = await buildWorld({ keys: ["ELC"], aiBehaviour: "off" }).coupons.topMatches().catch((e) => e);
  assert.equal(only.code, "NO_DATA", "avec un seul championnat complémentaire disponible, rien à proposer : erreur claire plutôt qu'un choix hasardeux");
});

test("EXTRA_LEAGUES_ENABLED=off : les championnats complémentaires ne sont ni chargés ni reconnus", async () => {
  const w = world({ env: { EXTRA_LEAGUES_ENABLED: "off" } });
  assert.ok(!w.data.leagues.some((l) => l.key === "ELC"));
  await w.data.ensureAll({ scope: "all" });
  const [r] = await w.analysis.analyzeLegs([leg("Leeds", "Leicester")]);
  assert.equal(r.etat, "equipe_inconnue");
  assert.doesNotMatch(r.message, /indisponibles pour/);
});

test("un championnat complémentaire en panne ne gêne rien d'autre et est nommé quand on cherche un de ses clubs", async () => {
  const w = world({ failing: ["ELC"] });
  await w.data.ensureAll({ scope: "all" });
  assert.equal(w.data.allFailed(), false);
  const [fine, missing] = await w.analysis.analyzeLegs([leg("Arsenal", "Chelsea"), leg("Leeds", "Leicester")]);
  assert.equal(fine.etat, "ok");
  assert.equal(missing.etat, "equipe_inconnue");
  assert.match(missing.message, /indisponibles pour : Championship/);
  const top = await w.coupons.topMatches();
  assert.equal(top.topMatches.length, 4);
  assert.equal(top.complet, true);
});
