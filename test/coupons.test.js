"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildWorld, HOUR, NOW } = require("./world");
const { MARKETS } = require("../src/markets");

const REQUIRED = ["id", "homeTeam", "awayTeam", "competition", "date", "meilleurPari", "probabilite", "niveauConfiance", "justification", "statsHome", "statsAway"];
const spread = (r) => {
  const ps = r.topMatches.map((m) => m.probabilite);
  return Math.max(...ps) - Math.min(...ps);
};

test("Top 4 : quatre matchs différents, dans la fenêtre, au format attendu par l'application", async () => {
  const w = buildWorld();
  const r = await w.coupons.topMatches();
  assert.equal(r.topMatches.length, 4);
  assert.equal(new Set(r.topMatches.map((m) => m.id)).size, 4);
  assert.equal(r.fenetreHeures, 72);
  assert.equal(r.complet, true);
  for (const m of r.topMatches) {
    for (const k of REQUIRED) assert.ok(m[k] !== undefined && m[k] !== null, `champ manquant : ${k}`);
    assert.equal(typeof m.probabilite, "number");
    assert.ok(Date.parse(m.date) > NOW && Date.parse(m.date) <= NOW + 72 * HOUR);
    assert.ok(["faible", "moyen", "eleve"].includes(m.niveauConfiance));
    assert.ok(m.probabilite >= 55 && m.probabilite <= 92, `probabilité hors plage : ${m.probabilite}`);
    assert.ok(Math.abs(m.coteEstimee - 100 / m.probabilite) < 0.02);
  }
  // Le pari le plus probable en premier.
  const ps = r.topMatches.map((m) => m.probabilite);
  assert.deepEqual(ps, [...ps].sort((a, b) => b - a));
});

test("Top 4 : la cote totale atteint l'objectif de 5 et reste cohérente avec les cotes de chaque sélection", async () => {
  const r = await buildWorld().coupons.topMatches();
  assert.equal(r.objectifCote, 5);
  assert.equal(r.objectifCoteAtteint, true);
  assert.ok(Number(r.coteTotale) >= 5, r.coteTotale);
  assert.ok(Number(r.coteTotale) < 6.5, `une cote bien au-delà de 5 voudrait dire des paris inutilement hasardeux : ${r.coteTotale}`);
  const product = r.topMatches.reduce((acc, m) => acc * (100 / m.probabilite), 1);
  assert.ok(Math.abs(Number(r.coteTotale) - product) < 0.08, `${r.coteTotale} vs ${product}`);
  const joint = r.topMatches.reduce((acc, m) => acc * (m.probabilite / 100), 1);
  assert.ok(Math.abs(r.probabiliteCombinee - joint * 100) < 0.4);
  assert.ok(r.probabiliteCombinee < 20 && r.probabiliteCombinee > 14, `${r.probabiliteCombinee} %`);
  assert.ok(!("message" in r), "objectif atteint, quatre matchs : rien à signaler");
  assert.match(r.avertissement, /sans marge de bookmaker/);
});

test("Top 4 : des paris équilibrés et fiables, ni quasi certains ni à pile ou face, chacun pris dans son match", async () => {
  const w = buildWorld({ aiBehaviour: "off" });
  const r = await w.coupons.topMatches();
  assert.equal(r.topMatches.length, 4);
  for (const m of r.topMatches) {
    assert.ok(m.probabilite >= 60 && m.probabilite <= 88, `${m.meilleurPari} : ${m.probabilite} %`);
    assert.equal(m.probabilite, m.probabiliteModele, "IA désactivée : aucune correction");
    // C'est la probabilité du modèle pour ce pari et ce match.
    const [leg] = await w.analysis.analyzeLegs([{ equipe1: m.homeTeam, equipe2: m.awayTeam, typePari: m.meilleurPari }], { withAi: false });
    assert.equal(leg.etat, "ok");
    assert.ok(Math.abs(leg.probabilite - m.probabilite) < 0.06, `${leg.probabilite} contre ${m.probabilite}`);
  }
  assert.ok(spread(r) < 10, `écart entre le pari le plus sûr et le moins sûr : ${spread(r)} points`);
  assert.ok(Number(r.coteTotale) >= 5);
});

test("Top 4 : la relecture de l'IA qui relève les probabilités fait recommencer le choix, la cote finale reste au moins 5", async () => {
  const w = buildWorld({ aiBehaviour: { adjustment: 3 } });
  const r = await w.coupons.topMatches();
  assert.equal(r.topMatches.length, 4);
  assert.equal(r.objectifCoteAtteint, true);
  assert.ok(Number(r.coteTotale) >= 5, r.coteTotale);
  for (const m of r.topMatches) assert.equal(m.ajustementIA, 3);
  assert.ok(w.ai.calls.length > 4 && w.ai.calls.length <= 12, `${w.ai.calls.length} relectures : un nouveau choix a été relu, au plus trois essais`);
  // La marge est prise d'emblée la fois suivante, tout est déjà relu : aucune nouvelle relecture.
  const calls = w.ai.calls.length;
  w.clock.t += 16 * 60000;
  const again = await w.coupons.topMatches();
  assert.equal(again.objectifCoteAtteint, true);
  assert.equal(w.ai.calls.length, calls, "mêmes paris : relectures réutilisées");
});

test("Top 4 : la relecture de l'IA qui baisse les probabilités donne une cote encore plus haute, sans nouvel essai", async () => {
  const w = buildWorld({ aiBehaviour: { adjustment: -3 } });
  const r = await w.coupons.topMatches();
  assert.equal(r.objectifCoteAtteint, true);
  assert.ok(Number(r.coteTotale) > 5.2);
  assert.equal(w.ai.calls.length, 4, "un seul choix relu");
});

test("Top 4 : TOP_TARGET_ODDS change l'objectif (paris plus sûrs si plus bas, moins sûrs si plus haut) et PICK_MAX_PROBABILITY plafonne les paris", async () => {
  const mean = (r) => r.topMatches.reduce((a, m) => a + m.probabilite, 0) / r.topMatches.length;
  const base = await buildWorld({ aiBehaviour: "off" }).coupons.topMatches();
  const easy = await buildWorld({ aiBehaviour: "off", env: { TOP_TARGET_ODDS: "3" } }).coupons.topMatches();
  const hard = await buildWorld({ aiBehaviour: "off", env: { TOP_TARGET_ODDS: "10" } }).coupons.topMatches();
  assert.equal(easy.objectifCote, 3);
  assert.equal(hard.objectifCote, 10);
  for (const r of [easy, hard]) {
    assert.equal(r.objectifCoteAtteint, true);
    assert.equal(r.topMatches.length, 4);
  }
  assert.ok(Number(easy.coteTotale) >= 3 && Number(easy.coteTotale) < 4);
  assert.ok(Number(hard.coteTotale) >= 10 && Number(hard.coteTotale) < 12);
  assert.ok(mean(easy) > mean(base) + 6 && mean(base) > mean(hard) + 6, `${mean(easy)} / ${mean(base)} / ${mean(hard)}`);
  const w = buildWorld({ aiBehaviour: "off", env: { PICK_MAX_PROBABILITY: "0.7" } });
  const capped = await w.coupons.topMatches();
  assert.equal(capped.topMatches.length, 4);
  for (const m of capped.topMatches) assert.ok(m.probabilite <= 70, `${m.meilleurPari} : ${m.probabilite} %`);
  const auto = await w.coupons.autoCoupon([{ equipe1: "Arsenal", equipe2: "Chelsea" }, { equipe1: "Real Madrid", equipe2: "Barcelona" }, { equipe1: "Juventus", equipe2: "Inter" }, { equipe1: "Sevilla", equipe2: "Valencia" }]);
  for (const x of auto.resultats) assert.ok(x.probabilite <= 70 && x.probabilite > 55, `${x.typePari} : ${x.probabilite} %`);
});

test("Top 4 : le résultat est gardé en mémoire puis recalculé après 15 minutes", async () => {
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

test("Top 4 : un match déjà commencé disparaît de la liste mise en mémoire", async () => {
  const w = buildWorld();
  const a = await w.coupons.topMatches();
  const firstKickoff = Math.min(...a.topMatches.map((m) => Date.parse(m.date)));
  w.clock.t = firstKickoff + 60000;
  const b = await w.coupons.topMatches();
  assert.ok(b.topMatches.every((m) => Date.parse(m.date) > w.clock.t));
});

test("Top 4 : fenêtre élargie à 7 jours quand peu de matchs sont proches", async () => {
  const w = buildWorld({ fixtureHours: [100, 110, 120, 130, 140, 150] });
  const r = await w.coupons.topMatches();
  assert.equal(r.fenetreHeures, 168);
  assert.equal(r.topMatches.length, 4);
  assert.equal(r.objectifCoteAtteint, true);
});

test("Top 4 : aucun match à venir", async () => {
  const w = buildWorld({ fixtureHours: [] });
  const r = await w.coupons.topMatches();
  assert.deepEqual(r.topMatches, []);
  assert.match(r.message, /Aucun match/);
  assert.equal(r.coteTotale, "0.00");
  assert.equal(r.objectifCote, 5);
  assert.equal(r.objectifCoteAtteint, false);
});

test("Top 4 : trois matchs seulement, tous retenus, l'objectif est atteint avec des paris un peu moins sûrs et le nombre de matchs est signalé", async () => {
  const w = buildWorld({ fixtureHours: [10], aiBehaviour: "off" });
  const r = await w.coupons.topMatches();
  assert.equal(r.topMatches.length, 3);
  assert.equal(r.objectifCoteAtteint, true);
  assert.ok(Number(r.coteTotale) >= 5);
  assert.match(r.message, /Seulement 3 match\(s\)/);
  for (const m of r.topMatches) assert.ok(m.probabilite >= 55, `${m.meilleurPari} : ${m.probabilite} %`);
});

test("Top 4 : deux matchs seulement, l'objectif de cote n'est pas atteignable avec des paris fiables : signalé clairement", async () => {
  const w = buildWorld({ fixtureHours: [10, 20], keys: ["PL"], aiBehaviour: "off" });
  const r = await w.coupons.topMatches();
  assert.equal(r.topMatches.length, 2);
  assert.equal(r.objectifCote, 5);
  assert.equal(r.objectifCoteAtteint, false);
  assert.ok(Number(r.coteTotale) > 2.5 && Number(r.coteTotale) < 5, r.coteTotale);
  assert.match(r.message, /Seulement 2 match\(s\)/);
  assert.match(r.message, /cote visée \(5\) n'est pas atteinte/);
  assert.match(r.message, new RegExp(`cote totale : ${r.coteTotale.replace(".", "\\.")}`));
  // Le plus près possible de l'objectif, mais jamais sous 55 % de chances par pari.
  for (const m of r.topMatches) assert.ok(m.probabilite >= 55 - 0.06 && m.probabilite < 62, `${m.meilleurPari} : ${m.probabilite} %`);
});

test("Top 4 : l'IA en panne ne bloque pas la sélection", async () => {
  const w = buildWorld({ aiBehaviour: "down" });
  const r = await w.coupons.topMatches();
  assert.equal(r.topMatches.length, 4);
  assert.equal(r.ia.statut, "indisponible");
  assert.equal(r.objectifCoteAtteint, true);
  for (const m of r.topMatches) {
    assert.equal(m.ajustementIA, 0);
    assert.match(m.justification, /Le modèle attend/);
  }
});

test("Top 4 : IA désactivée", async () => {
  const r = await buildWorld({ aiBehaviour: "off" }).coupons.topMatches();
  assert.equal(r.ia.statut, "desactivee");
  assert.equal(r.topMatches.length, 4);
  assert.equal(r.objectifCoteAtteint, true);
});

test("Top 4 : un championnat en panne est signalé, les autres servent quand même", async () => {
  const w = buildWorld({ failing: ["SA"] });
  const r = await w.coupons.topMatches();
  assert.equal(r.topMatches.length, 4);
  assert.equal(r.complet, true);
  assert.deepEqual(r.donnees.enEchec.map((f) => f.key), ["SA"]);
  assert.ok(r.topMatches.every((m) => m.competition !== "Serie A"));
});

test("Top 4 : si aucune source ne répond, erreur claire", async () => {
  const dead = buildWorld({ failing: ["PL", "PD", "SA"] });
  await assert.rejects(dead.coupons.topMatches(), (e) => e.code === "NO_DATA");
});

test("Top 4 : si le recalcul échoue, la dernière sélection encore valable est conservée et marquée périmée", async () => {
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

const SIX = [
  { equipe1: "Arsenal", equipe2: "Chelsea" },
  { equipe1: "Real Madrid", equipe2: "Barcelona" },
  { equipe1: "Juventus", equipe2: "Inter" },
  { equipe1: "Sevilla", equipe2: "Valencia" },
  { equipe1: "Napoli", equipe2: "Roma" },
  { equipe1: "Liverpool", equipe2: "Manchester City" },
];

test("coupon automatique : un pari par match, cote totale visée atteinte avec des paris équilibrés, totaux cohérents", async () => {
  const w = buildWorld({ aiBehaviour: "off" });
  const r = await w.coupons.autoCoupon([...SIX.slice(0, 4), { equipe1: "Inconnu FC", equipe2: "Chelsea" }]);
  assert.equal(r.resultats.length, 5);
  assert.deepEqual(r.resultats.map((x) => x.index), [0, 1, 2, 3, 4]);
  assert.equal(r.resultats[4].etat, "equipe_inconnue");
  assert.equal(r.analyses, 4);
  assert.equal(r.objectifCote, 5);
  assert.equal(r.objectifCoteAtteint, true);
  assert.ok(Number(r.coteTotale) >= 5 && Number(r.coteTotale) < 6.5, r.coteTotale);
  assert.ok(!("message" in r));
  const ok = r.resultats.slice(0, 4);
  for (const x of ok) {
    assert.equal(x.etat, "ok");
    assert.ok(x.probabilite >= 60 && x.probabilite <= 88, `${x.typePari} : ${x.probabilite} %`);
    assert.ok(x.typePari);
  }
  const ps = ok.map((x) => x.probabilite);
  assert.ok(Math.max(...ps) - Math.min(...ps) < 10, ps.join(", "));
  const joint = ok.reduce((acc, x) => acc * (x.probabilite / 100), 1);
  assert.ok(Math.abs(r.probabiliteCombinee - joint * 100) < 0.4);
  const odds = ok.reduce((acc, x) => acc * x.coteEstimee, 1);
  assert.ok(Math.abs(Number(r.coteTotale) - odds) < 0.01);
});

test("coupon automatique : plus il y a de matchs, plus les paris sont sûrs pour la même cote totale", async () => {
  const w = buildWorld({ aiBehaviour: "off" });
  const four = await w.coupons.autoCoupon(SIX.slice(0, 4));
  const six = await w.coupons.autoCoupon(SIX);
  const mean = (r) => r.resultats.reduce((a, x) => a + x.probabilite, 0) / r.resultats.length;
  assert.equal(four.objectifCoteAtteint, true);
  assert.equal(six.objectifCoteAtteint, true);
  assert.ok(mean(six) > mean(four) + 4, `${mean(six)} contre ${mean(four)}`);
  assert.ok(Number(six.coteTotale) >= 5);
});

test("coupon automatique : trop peu de matchs pour une cote de 5 avec des paris fiables, le coupon s'en approche et le dit", async () => {
  const w = buildWorld({ aiBehaviour: "off" });
  const two = await w.coupons.autoCoupon(SIX.slice(0, 2));
  assert.equal(two.analyses, 2);
  assert.equal(two.objectifCoteAtteint, false);
  assert.ok(Number(two.coteTotale) > 2.8 && Number(two.coteTotale) < 3.8, two.coteTotale);
  assert.match(two.message, /cote visée \(5\) n'est pas atteinte/);
  assert.match(two.message, /Avec 2 matchs/);
  assert.match(two.message, /ajoutez des matchs/);
  for (const x of two.resultats) assert.ok(x.probabilite >= 54.9 && x.probabilite < 62, `${x.typePari} : ${x.probabilite} %`);
  const one = await w.coupons.autoCoupon(SIX.slice(0, 1));
  assert.equal(one.objectifCoteAtteint, false);
  assert.match(one.message, /Avec 1 match,/);
  assert.ok(Number(one.coteTotale) > 1.5 && Number(one.coteTotale) < 2, one.coteTotale);
  // Trois matchs suffisent, avec des paris un peu moins sûrs.
  const three = await w.coupons.autoCoupon(SIX.slice(0, 3));
  assert.equal(three.objectifCoteAtteint, true);
  assert.ok(Number(three.coteTotale) >= 5);
});

test("coupon automatique : la relecture de l'IA qui relève les probabilités fait recommencer le choix, la cote finale reste au moins 5", async () => {
  const w = buildWorld({ aiBehaviour: { adjustment: 3 } });
  const r = await w.coupons.autoCoupon(SIX.slice(0, 4));
  assert.equal(r.objectifCoteAtteint, true);
  assert.ok(Number(r.coteTotale) >= 5, r.coteTotale);
  for (const x of r.resultats) assert.equal(x.ajustementIA, 3);
  assert.ok(w.ai.calls.length > 4 && w.ai.calls.length <= 12, `${w.ai.calls.length} relectures`);
});

test("coupon automatique : ia false = modèle statistique seul, sans aucun appel à l'IA", async () => {
  const w = buildWorld();
  const r = await w.coupons.autoCoupon(SIX.slice(0, 4), { withAi: false });
  assert.equal(w.ai.calls.length, 0);
  assert.equal(r.objectifCoteAtteint, true);
  for (const x of r.resultats) assert.equal(x.ia.statut, "non_demandee");
});

test("coupon automatique : le pari retenu est un pari connu ; s'il est remboursable, le cas du remboursement est indiqué", async () => {
  const w = buildWorld({ aiBehaviour: "off" });
  const r = await w.coupons.autoCoupon(SIX);
  const byLabel = new Map(MARKETS.map((m) => [m.label, m]));
  for (const x of r.resultats) {
    assert.equal(x.etat, "ok");
    const market = byLabel.get(x.typePari);
    assert.ok(market, x.typePari);
    assert.equal(Boolean(x.remboursement), Boolean(market.push), `${x.typePari} : remboursement ${JSON.stringify(x.remboursement)}`);
    if (x.remboursement) assert.ok(x.remboursement.probabilite > 0 && x.remboursement.quand);
  }
});

test("coupon automatique : aucune sélection exploitable", async () => {
  const w = buildWorld({ aiBehaviour: "off" });
  const r = await w.coupons.autoCoupon([{ equipe1: "Zzz", equipe2: "Yyy" }]);
  assert.equal(r.analyses, 0);
  assert.equal(r.probabiliteCombinee, null);
  assert.equal(r.coteTotale, null);
  assert.equal(r.objectifCoteAtteint, null, "rien à comparer à l'objectif");
  assert.ok(!("message" in r));
  assert.equal(r.objectifCote, 5);
});
