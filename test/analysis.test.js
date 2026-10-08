"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildWorld } = require("./world");

const leg = (equipe1, equipe2, typePari) => ({ equipe1, equipe2, typePari });

test("une sélection reconnue donne une probabilité, une cote estimée et les statistiques attendues par l'application", async () => {
  const w = buildWorld();
  const [r] = await w.analysis.analyzeLegs([leg("Arsenal", "Chelsea", "Victoire ou nul domicile")]);
  assert.equal(r.etat, "ok");
  assert.equal(r.equipe1, "Arsenal FC");
  assert.equal(r.equipe2, "Chelsea FC");
  assert.equal(r.competition, "Premier League");
  assert.equal(r.typePari, "Victoire ou nul domicile");
  assert.ok(r.probabilite > 20 && r.probabilite < 99, `p = ${r.probabilite}`);
  assert.ok(Math.abs(r.coteEstimee - 100 / r.probabilite) < 0.02);
  assert.ok(["faible", "moyen", "eleve"].includes(r.niveauConfiance));
  assert.equal(r.equipesTrouvees1, true);
  assert.equal(r.equipesTrouvees2, true);
  assert.equal(r.ia.statut, "ok");
  assert.match(r.justification, /Justification de test/);
  // Champs lus par l'écran « Mon coupon ».
  assert.equal(typeof r.homeAway1.home.won, "number");
  assert.equal(typeof r.homeAway2.away.avgGoalsFor, "number");
  assert.ok(r.h2h === null || (Array.isArray(r.h2h.matches) && typeof r.h2h.bilan.homeWins === "number"));
  assert.ok(r.statsEquipe1.forme.length > 0);
  assert.ok(r.butsAttendus.equipe1 > 0.2 && r.butsAttendus.equipe2 > 0.2);
});

test("la correction de l'IA est bornée et visible", async () => {
  const w = buildWorld({ aiBehaviour: { adjustment: 4 } });
  const [r] = await w.analysis.analyzeLegs([leg("Arsenal FC", "Chelsea FC", "Victoire ou nul domicile")]);
  assert.ok(Math.abs(r.probabilite - (r.probabiliteModele + 4)) < 0.11, `${r.probabilite} vs ${r.probabiliteModele}`);
  assert.equal(r.ajustementIA, 4);
});

test("finalProbability : plafond relatif pour les petites probabilités, aucun effet sur un score exact", () => {
  const { finalProbability } = buildWorld().analysis;
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(finalProbability(0.8, { adjustment: 9 }, false).p, 0.84));
  assert.ok(near(finalProbability(0.8, { adjustment: -9 }, false).p, 0.76));
  const small = finalProbability(0.1, { adjustment: 4 }, false);
  assert.ok(Math.abs(small.p - 0.12) < 1e-9 && small.adjustment === 2);
  assert.equal(finalProbability(0.12, { adjustment: 4 }, true).p, 0.12);
  assert.equal(finalProbability(0.7, null, false).adjustment, 0);
  assert.ok(finalProbability(0.985, { adjustment: 4 }, false).p <= 0.99);
});

test("sans IA, le résultat du modèle est renvoyé avec une explication chiffrée", async () => {
  const w = buildWorld({ aiBehaviour: "off" });
  const [r] = await w.analysis.analyzeLegs([leg("Arsenal", "Chelsea", "Plus de 1.5 buts")]);
  assert.equal(r.etat, "ok");
  assert.equal(r.ia.statut, "desactivee");
  assert.equal(r.probabilite, r.probabiliteModele);
  assert.equal(r.ajustementIA, 0);
  assert.match(r.justification, /Le modèle attend/);
});

test("IA en panne : même résultat que sans IA, avec le motif", async () => {
  const w = buildWorld({ aiBehaviour: "down" });
  const [r] = await w.analysis.analyzeLegs([leg("Arsenal", "Chelsea", "Plus de 1.5 buts")]);
  assert.equal(r.etat, "ok");
  assert.equal(r.ia.statut, "indisponible");
  assert.equal(r.ia.code, "UNAVAILABLE");
  assert.equal(r.probabilite, r.probabiliteModele);
});

test("les probabilités de plusieurs paris du même match sont cohérentes", async () => {
  const w = buildWorld({ aiBehaviour: "off" });
  const rs = await w.analysis.analyzeLegs([
    leg("Arsenal", "Chelsea", "Plus de 2.5 buts"),
    leg("Arsenal", "Chelsea", "Moins de 2.5 buts"),
    leg("Arsenal", "Chelsea", "Victoire domicile"),
    leg("Arsenal", "Chelsea", "Match nul"),
    leg("Arsenal", "Chelsea", "Victoire extérieur"),
  ]);
  assert.ok(Math.abs(rs[0].probabilite + rs[1].probabilite - 100) < 0.3);
  assert.ok(Math.abs(rs[2].probabilite + rs[3].probabilite + rs[4].probabilite - 100) < 0.4);
});

test("équipe inconnue : pas de probabilité inventée, indication de l'équipe fautive", async () => {
  const w = buildWorld();
  const [r] = await w.analysis.analyzeLegs([leg("Arsenal", "Club Imaginaire", "Match nul")]);
  assert.equal(r.etat, "equipe_inconnue");
  assert.equal(r.probabilite, null);
  assert.equal(r.donneesInsuffisantes, true);
  assert.equal(r.equipesTrouvees1, true);
  assert.equal(r.equipesTrouvees2, false);
  assert.ok(r.message);
  assert.equal(w.ai.calls.length, 0, "aucun appel IA pour une équipe inconnue");
});

test("nom ambigu : l'utilisateur est invité à préciser", async () => {
  const w = buildWorld();
  const [r] = await w.analysis.analyzeLegs([leg("Real", "FC Barcelona", "Match nul")]);
  assert.equal(r.etat, "ambigu");
  assert.equal(r.probabilite, null);
  assert.ok(r.suggestions.equipe1.length >= 2);
});

test("équipes de deux championnats différents : refus explicite", async () => {
  const w = buildWorld();
  const [r] = await w.analysis.analyzeLegs([leg("Arsenal", "Juventus", "Match nul")]);
  assert.equal(r.etat, "ligues_differentes");
  assert.equal(r.probabilite, null);
  assert.equal(r.equipe1, "Arsenal FC");
});

test("même équipe des deux côtés : refus", async () => {
  const [r] = await buildWorld().analysis.analyzeLegs([leg("Arsenal", "Arsenal FC", "Match nul")]);
  assert.equal(r.etat, "meme_equipe");
});

test("type de pari non reconnu (« Autre ») : pas de probabilité, liste des paris possibles", async () => {
  const w = buildWorld();
  const [r] = await w.analysis.analyzeLegs([leg("Arsenal", "Chelsea", "Autre")]);
  assert.equal(r.etat, "marche_inconnu");
  assert.equal(r.probabilite, null);
  assert.ok(r.marchesDisponibles.includes("Les deux équipes marquent"));
  const [n] = await w.analysis.analyzeLegs([leg("Arsenal", "Chelsea", 42)]);
  assert.equal(n.etat, "marche_inconnu");
});

test("score exact : score le plus probable, sans correction de l'IA", async () => {
  const w = buildWorld();
  const [r] = await w.analysis.analyzeLegs([leg("Arsenal", "Chelsea", "Score exact")]);
  assert.equal(r.etat, "ok");
  assert.ok(r.probabilite < 25, `p = ${r.probabilite}`);
  assert.equal(r.ia.statut, "non_applicable");
  assert.equal(w.ai.calls.length, 0);
  assert.match(r.justification, /^Score le plus probable/);
});

test("anciens noms de paris et surnoms d'équipes", async () => {
  const w = buildWorld({ aiBehaviour: "off" });
  const [a, b] = await w.analysis.analyzeLegs([leg("man city", "spurs", "Victoire equipe 1"), leg("Man City", "Spurs", "Victoire domicile")]);
  assert.equal(a.etat, "ok");
  assert.equal(a.equipe1, "Manchester City FC");
  assert.equal(a.equipe2, "Tottenham Hotspur FC");
  assert.equal(a.probabilite, b.probabilite);
});

test("la même analyse n'appelle l'IA qu'une fois", async () => {
  const w = buildWorld();
  await w.analysis.analyzeLegs([leg("Arsenal", "Chelsea", "Plus de 1.5 buts")]);
  await w.analysis.analyzeLegs([leg("Arsenal FC", "Chelsea FC", "Plus de 1.5 buts")]);
  assert.equal(w.ai.calls.length, 1);
});

test("une sélection en échec n'empêche pas les autres", async () => {
  const w = buildWorld({ aiBehaviour: "off" });
  const rs = await w.analysis.analyzeLegs([leg("Arsenal", "Chelsea", "Match nul"), leg("Nulle part", "Ailleurs", "Match nul"), leg("Real Madrid", "Barcelona", "Match nul")]);
  assert.deepEqual(rs.map((r) => r.etat), ["ok", "equipe_inconnue", "ok"]);
});

test("un championnat dont la source est en panne est signalé sans bloquer les autres", async () => {
  const w = buildWorld({ aiBehaviour: "off", failing: ["PD"] });
  const rs = await w.analysis.analyzeLegs([leg("Arsenal", "Chelsea", "Match nul"), leg("Real Madrid", "Barcelona", "Match nul")]);
  assert.equal(rs[0].etat, "ok");
  assert.equal(rs[1].etat, "equipe_inconnue");
});

test("sans aucune donnée chargée, l'état « chargement » est renvoyé", () => {
  const w = buildWorld();
  assert.equal(w.analysis.resolveTeams("Arsenal", "Chelsea").state, "chargement");
});

test("la confiance baisse avec peu de données ou si l'IA est réservée, jamais l'inverse", () => {
  const { confidence } = buildWorld().analysis;
  assert.equal(confidence({ level: 0 }, 0.9, null), "faible");
  assert.equal(confidence({ level: 1 }, 0.9, null), "moyen");
  assert.equal(confidence({ level: 2 }, 0.7, null), "eleve");
  assert.equal(confidence({ level: 2 }, 0.6, null), "moyen");
  assert.equal(confidence({ level: 2 }, 0.7, "faible"), "faible");
  assert.equal(confidence({ level: 2 }, 0.7, "moyen"), "moyen");
  assert.equal(confidence({ level: 1 }, 0.7, "eleve"), "moyen");
});
