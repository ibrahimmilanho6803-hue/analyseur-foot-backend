"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildWorld, HOUR, NOW } = require("./world");

const REQUIRED = ["id", "homeTeam", "awayTeam", "competition", "date", "meilleurPari", "probabilite", "niveauConfiance", "justification", "statsHome", "statsAway"];

test("Top 3 : trois matchs différents, dans la fenêtre, au format attendu par l'application", async () => {
  const w = buildWorld();
  const r = await w.coupons.topMatches();
  assert.equal(r.topMatches.length, 3);
  assert.equal(new Set(r.topMatches.map((m) => m.id)).size, 3);
  assert.equal(r.fenetreHeures, 72);
  assert.equal(r.complet, true);
  for (const m of r.topMatches) {
    for (const k of REQUIRED) assert.ok(m[k] !== undefined && m[k] !== null, `champ manquant : ${k}`);
    assert.equal(typeof m.probabilite, "number");
    assert.ok(Date.parse(m.date) > NOW && Date.parse(m.date) <= NOW + 72 * HOUR);
    assert.ok(["faible", "moyen", "eleve"].includes(m.niveauConfiance));
    assert.ok(m.probabilite >= 50 && m.probabilite <= 93, `probabilité hors plage : ${m.probabilite}`);
    assert.ok(Math.abs(m.coteEstimee - 100 / m.probabilite) < 0.02);
  }
  // Le meilleur pari (le plus probable) en premier.
  const ps = r.topMatches.map((m) => m.probabilite);
  assert.deepEqual(ps, [...ps].sort((a, b) => b - a));
});

test("Top 3 : cote totale cohérente avec les cotes de chaque sélection et honnête sur l'objectif", async () => {
  const r = await buildWorld().coupons.topMatches();
  const product = r.topMatches.reduce((acc, m) => acc * (100 / m.probabilite), 1);
  assert.ok(Math.abs(Number(r.coteTotale) - product) < 0.05, `${r.coteTotale} vs ${product}`);
  assert.equal(r.objectifCoteAtteint, Number(r.coteTotale) >= r.objectifCote);
  const joint = r.topMatches.reduce((acc, m) => acc * (m.probabilite / 100), 1);
  assert.ok(Math.abs(r.probabiliteCombinee - joint * 100) < 0.2);
  assert.match(r.avertissement, /sans marge de bookmaker/);
});

test("Top 3 : l'objectif de cote est atteint quand c'est possible, en gardant la probabilité la plus haute", async () => {
  const r = await buildWorld({ aiBehaviour: "off" }).coupons.topMatches();
  assert.equal(r.objectifCoteAtteint, true);
  assert.ok(Number(r.coteTotale) >= 2.5 && Number(r.coteTotale) < 3.2, `cote ${r.coteTotale}`);
});

test("Top 3 : le résultat est gardé en mémoire puis recalculé après 15 minutes", async () => {
  const w = buildWorld();
  const a = await w.coupons.topMatches();
  const calls = w.ai.calls.length;
  const b = await w.coupons.topMatches();
  assert.equal(a, b);
  assert.equal(w.ai.calls.length, calls);
  w.clock.t += 16 * 60000;
  const c = await w.coupons.topMatches();
  assert.notEqual(c, a);
  assert.deepEqual(c.topMatches.map((m) => m.id), a.topMatches.map((m) => m.id));
  assert.equal(w.ai.calls.length, calls, "mêmes sélections : l'analyse de l'IA est réutilisée");
});

test("Top 3 : un match déjà commencé disparaît de la liste mise en mémoire", async () => {
  const w = buildWorld();
  const a = await w.coupons.topMatches();
  const firstKickoff = Math.min(...a.topMatches.map((m) => Date.parse(m.date)));
  w.clock.t = firstKickoff + 60000;
  const b = await w.coupons.topMatches();
  assert.ok(b.topMatches.every((m) => Date.parse(m.date) > w.clock.t));
});

test("Top 3 : fenêtre élargie à 7 jours quand peu de matchs sont proches", async () => {
  const w = buildWorld({ fixtureHours: [100, 110, 120, 130, 140, 150] });
  const r = await w.coupons.topMatches();
  assert.equal(r.fenetreHeures, 168);
  assert.equal(r.topMatches.length, 3);
});

test("Top 3 : aucun match à venir", async () => {
  const w = buildWorld({ fixtureHours: [] });
  const r = await w.coupons.topMatches();
  assert.deepEqual(r.topMatches, []);
  assert.match(r.message, /Aucun match/);
  assert.equal(r.coteTotale, "0.00");
});

test("Top 3 : l'IA en panne ne bloque pas la sélection", async () => {
  const w = buildWorld({ aiBehaviour: "down" });
  const r = await w.coupons.topMatches();
  assert.equal(r.topMatches.length, 3);
  assert.equal(r.ia.statut, "indisponible");
  for (const m of r.topMatches) {
    assert.equal(m.ajustementIA, 0);
    assert.match(m.justification, /Le modèle attend/);
  }
});

test("Top 3 : IA désactivée", async () => {
  const r = await buildWorld({ aiBehaviour: "off" }).coupons.topMatches();
  assert.equal(r.ia.statut, "desactivee");
  assert.equal(r.topMatches.length, 3);
});

test("Top 3 : un championnat en panne est signalé, les autres servent quand même", async () => {
  const w = buildWorld({ failing: ["SA"] });
  const r = await w.coupons.topMatches();
  assert.equal(r.topMatches.length, 3);
  assert.equal(r.complet, true);
  assert.deepEqual(r.donnees.enEchec.map((f) => f.key), ["SA"]);
  assert.ok(r.topMatches.every((m) => m.competition !== "Serie A"));
});

test("Top 3 : si aucune source ne répond, erreur claire", async () => {
  const dead = buildWorld({ failing: ["PL", "PD", "SA"] });
  await assert.rejects(dead.coupons.topMatches(), (e) => e.code === "NO_DATA");
});

test("Top 3 : si le recalcul échoue, la dernière sélection encore valable est conservée et marquée périmée", async () => {
  const w = buildWorld();
  const good = await w.coupons.topMatches();
  w.clock.t += 20 * 60000; // expirée, mais aucun match n'a commencé
  w.data.ensureAll = async () => {
    throw new Error("panne soudaine");
  };
  const again = await w.coupons.topMatches();
  assert.equal(again.perime, true);
  assert.deepEqual(again.topMatches.map((m) => m.id), good.topMatches.map((m) => m.id));
  // Si un des matchs a commencé, on ne ressert pas une liste dépassée.
  w.clock.t = Math.min(...good.topMatches.map((m) => Date.parse(m.date))) + 60000;
  await assert.rejects(w.coupons.topMatches(), /panne soudaine/);
});

test("coupon automatique : le pari le plus probable par match, totaux cohérents", async () => {
  const w = buildWorld({ aiBehaviour: "off" });
  const r = await w.coupons.autoCoupon([
    { equipe1: "Arsenal", equipe2: "Chelsea" },
    { equipe1: "Real Madrid", equipe2: "Barcelona" },
    { equipe1: "Inconnu FC", equipe2: "Chelsea" },
  ]);
  assert.equal(r.resultats.length, 3);
  assert.deepEqual(r.resultats.map((x) => x.index), [0, 1, 2]);
  assert.equal(r.resultats[0].etat, "ok");
  assert.equal(r.resultats[2].etat, "equipe_inconnue");
  assert.equal(r.analyses, 2);
  for (const x of r.resultats.slice(0, 2)) {
    assert.ok(x.probabilite >= 55 && x.probabilite <= 88, `p = ${x.probabilite}`);
    assert.ok(x.typePari);
  }
  const joint = (r.resultats[0].probabilite / 100) * (r.resultats[1].probabilite / 100);
  assert.ok(Math.abs(r.probabiliteCombinee - joint * 100) < 0.2);
  assert.ok(Number(r.coteTotale) > 1);
});

test("coupon automatique : aucune sélection exploitable", async () => {
  const w = buildWorld({ aiBehaviour: "off" });
  const r = await w.coupons.autoCoupon([{ equipe1: "Zzz", equipe2: "Yyy" }]);
  assert.equal(r.analyses, 0);
  assert.equal(r.probabiliteCombinee, null);
  assert.equal(r.coteTotale, null);
});
