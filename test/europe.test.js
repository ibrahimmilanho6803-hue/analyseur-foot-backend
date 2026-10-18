"use strict";

// Matchs entre clubs de championnats différents et coupes d'Europe, de bout en bout dans le monde simulé de world.js :
// trois championnats (PL, PD, SA) de niveaux différents, une « Ligue des champions » où ils se rencontrent, quatre clubs que seule la coupe fait connaître.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildWorld, NOW, HOUR, TRUE_LEVEL, CUP_ONLY } = require("./world");
const { scoreMatrix } = require("../src/model");
const { describeMatrix } = require("../src/markets");

const leg = (equipe1, equipe2, typePari = "Victoire domicile") => ({ equipe1, equipe2, typePari });
const world = (extra = {}) => buildWorld({ cups: true, aiBehaviour: "off", ...extra });
const close = (a, b, eps, label = "") => assert.ok(Math.abs(a - b) <= eps, `${label} ${a} ≠ ${b} (±${eps})`);

test("la Ligue des champions est chargée avec les championnats et ses matchs servent à situer les championnats entre eux", async () => {
  const w = world();
  await w.analysis.loadAll();
  const s = w.europe.status();
  assert.equal(s.actif, true);
  assert.deepEqual(s.coupesChargees, ["UCL"]);
  assert.ok(s.matchsDeCoupeUtilises > 150, `${s.matchsDeCoupeUtilises} matchs`);
  assert.equal(s.clubsSansChampionnatSuivi, CUP_ONLY.length);
  const level = (k) => s.niveauxDesChampionnats.find((l) => l.key === k);
  for (const k of ["PL", "PD", "SA"]) {
    assert.equal(level(k).mesure, true, `${k} mesuré`);
    assert.ok(level(k).matchsDeCoupe > 50);
  }
  // Niveaux a priori du serveur : PL 0, PD −0,14, SA −0,16. Réalité simulée : 0, −0,2, −0,45. Les matchs de coupe écartent la Serie A.
  assert.equal(level("SA").niveauAPriori, -0.16);
  assert.ok(level("PL").niveauEstime > level("PD").niveauEstime && level("PD").niveauEstime > level("SA").niveauEstime, "ordre retrouvé");
  const gap = (x, y) => level(x).niveauEstime - level(y).niveauEstime;
  assert.ok(gap("SA", "PL") < -0.3 && gap("SA", "PL") > -0.8, `SA − PL = ${gap("SA", "PL")} (vrai : ${TRUE_LEVEL.SA - TRUE_LEVEL.PL}, a priori : −0,16)`);
  assert.ok(gap("PD", "PL") < -0.05 && gap("PD", "PL") > -0.5, `PD − PL = ${gap("PD", "PL")}`);
  // Le tableau trie du plus fort au plus faible et contient le groupe des autres clubs européens
  const levels = s.niveauxDesChampionnats.map((l) => l.niveauEstime);
  assert.deepEqual(levels, [...levels].sort((a, b) => b - a));
  assert.ok(s.niveauxDesChampionnats.some((l) => l.key === "EUR" && l.nom === "Autres clubs européens"));
  assert.ok(s.butsParEquipeExterieur > 0.8 && s.butsParEquipeExterieur < 1.6);
  assert.ok(s.avantageDomicile > 1.1 && s.avantageDomicile < 1.6);
  assert.match(s.calculeLe, /^2026-10-08T12:00:00/);
});

test("match de Ligue des champions entre deux championnats : compétition, date, estimation signalée comme moins précise", async () => {
  const w = world({ aiBehaviour: "ok" });
  const [r] = await w.analysis.analyzeLegs([leg("Arsenal", "Real Madrid", "Victoire ou nul domicile")]);
  assert.equal(r.etat, "ok");
  assert.equal(r.equipe1, "Arsenal FC");
  assert.equal(r.equipe2, "Real Madrid CF");
  assert.equal(r.competition, "Ligue des champions");
  assert.equal(r.date, new Date(NOW + 30 * HOUR).toISOString());
  assert.ok(r.probabilite > 30 && r.probabilite < 99);
  const c = r.comparaisonEntreChampionnats;
  assert.equal(c.championnat1, "Premier League");
  assert.equal(c.championnat2, "Liga");
  assert.equal(c.niveauDesChampionnatsMesure, true);
  assert.match(c.message, /ne jouent pas dans le même championnat/);
  assert.match(c.message, /moins précise/);
  assert.match(r.justification, /Justification de test/);
  assert.ok(r.statsEquipe1.forme.length > 0 && r.statsEquipe2.forme.length > 0, "forme calculée sur les matchs de championnat et de coupe");
  assert.ok(r.h2h === null || Array.isArray(r.h2h.matches));
  assert.ok(r.butsAttendus.equipe1 > 0.2 && r.butsAttendus.equipe2 > 0.2);
});

test("le texte d'explication sans IA précise que la comparaison entre championnats est moins précise", async () => {
  const w = world({ aiBehaviour: "off" });
  const [r] = await w.analysis.analyzeLegs([leg("Arsenal", "Real Madrid", "Plus de 1.5 buts")]);
  assert.match(r.justification, /Le modèle attend/);
  assert.match(r.justification, /ne jouent pas dans le même championnat/);
  const [same] = await w.analysis.analyzeLegs([leg("Arsenal", "Chelsea", "Plus de 1.5 buts")]);
  assert.doesNotMatch(same.justification, /même championnat/);
  assert.equal(same.comparaisonEntreChampionnats, undefined, "aucun avertissement entre deux clubs d'un même championnat");
});

test("sans match de coupe programmé entre les deux clubs : libellé générique et pas de date", async () => {
  const w = world();
  const [r] = await w.analysis.analyzeLegs([leg("Real Madrid", "Arsenal", "Victoire domicile")]); // la coupe programme Arsenal – Real, pas l'inverse
  assert.equal(r.etat, "ok");
  assert.equal(r.competition, "Match entre clubs de championnats différents");
  assert.equal(r.date, null);
});

test("l'ordre des clubs compte : l'avantage du terrain joue pour le club qui reçoit", async () => {
  const w = world();
  const [home, away] = await w.analysis.analyzeLegs([leg("Arsenal", "Real Madrid", "Victoire domicile"), leg("Real Madrid", "Arsenal", "Victoire extérieur")]);
  // Arsenal gagne plus souvent chez lui que chez l'adversaire
  assert.ok(home.probabilite > away.probabilite + 3, `${home.probabilite} vs ${away.probabilite}`);
});

test("les paris d'un match entre championnats restent cohérents entre eux", async () => {
  const w = world();
  const rs = await w.analysis.analyzeLegs([
    leg("Arsenal", "Real Madrid", "Victoire domicile"),
    leg("Arsenal", "Real Madrid", "Match nul"),
    leg("Arsenal", "Real Madrid", "Victoire extérieur"),
    leg("Arsenal", "Real Madrid", "Plus de 2.5 buts"),
    leg("Arsenal", "Real Madrid", "Moins de 2.5 buts"),
    leg("Arsenal", "Real Madrid", "Victoire ou nul domicile"),
    leg("Arsenal", "Real Madrid", "Score exact"),
  ]);
  assert.ok(rs.every((r) => r.etat === "ok"));
  close(rs[0].probabilite + rs[1].probabilite + rs[2].probabilite, 100, 0.4, "1-N-2");
  close(rs[3].probabilite + rs[4].probabilite, 100, 0.3, "plus/moins de 2,5 buts");
  close(rs[5].probabilite, rs[0].probabilite + rs[1].probabilite, 0.3, "victoire ou nul");
  assert.ok(rs[6].probabilite < 25);
});

test("un match entre championnats n'obtient jamais la confiance « élevé » ni la fiabilité « bonne » : la comparaison reste une estimation", async () => {
  const w = world();
  const pairs = [["Arsenal", "Real Madrid"], ["Real Madrid", "Arsenal"], ["Juventus", "Chelsea"], ["Barcelona", "Inter"], ["Liverpool", "AC Milan"], ["Atletico", "Manchester City"]];
  const rs = await w.analysis.analyzeLegs(pairs.map(([a, b]) => leg(a, b, "Plus de 1.5 buts")));
  for (const r of rs) {
    assert.equal(r.etat, "ok", `${r.equipe1} – ${r.equipe2}`);
    assert.notEqual(r.niveauConfiance, "eleve", `${r.equipe1} – ${r.equipe2}`);
    assert.notEqual(r.fiabiliteDonnees.niveau, "bonne");
    assert.ok(r.comparaisonEntreChampionnats);
  }
  // alors qu'entre deux clubs d'un même championnat, la confiance peut être élevée
  const [domestic] = await w.analysis.analyzeLegs([leg("Arsenal", "Chelsea", "Plus de 1.5 buts")]);
  assert.equal(domestic.niveauConfiance, "eleve");
});

test("un match entre clubs d'un même championnat est calculé comme avant : même résultat avec ou sans la comparaison entre championnats", async () => {
  const withEurope = world();
  const without = world({ env: { EUROPE_ENABLED: "off" } });
  const legs = [leg("Arsenal", "Chelsea", "Victoire domicile"), leg("Real Madrid", "Barcelona", "Plus de 2.5 buts"), leg("Juventus", "Inter", "Match nul")];
  const a = await withEurope.analysis.analyzeLegs(legs);
  const b = await without.analysis.analyzeLegs(legs);
  assert.deepEqual(a.map((r) => [r.etat, r.probabilite, r.butsAttendus, r.competition]), b.map((r) => [r.etat, r.probabilite, r.butsAttendus, r.competition]));
  assert.ok(a.every((r) => r.comparaisonEntreChampionnats === undefined));
});

test("l'IA reçoit l'information « championnats différents » pour un match entre championnats, et seulement pour celui-là", async () => {
  const w = buildWorld({ cups: true });
  await w.analysis.analyzeLegs([leg("Arsenal", "Real Madrid", "Victoire domicile"), leg("Arsenal", "Chelsea", "Victoire domicile")]);
  const crossCall = w.ai.calls.find((c) => c.home === "Arsenal FC" && c.away === "Real Madrid CF");
  const domesticCall = w.ai.calls.find((c) => c.home === "Arsenal FC" && c.away === "Chelsea FC");
  assert.ok(crossCall && domesticCall);
  assert.equal(crossCall.cross.championnat1, "Premier League");
  assert.equal(crossCall.cross.championnat2, "Liga");
  assert.equal(crossCall.cross.etalonne, true);
  assert.equal(crossCall.competition, "Ligue des champions");
  assert.equal(domesticCall.cross, undefined);
  // le texte envoyé à l'IA le dit
  const { buildPrompt } = require("../src/ai");
  assert.match(buildPrompt(crossCall), /ne jouent pas dans le même championnat/);
  assert.doesNotMatch(buildPrompt(domesticCall), /même championnat/);
});

test("club connu seulement par la coupe d'Europe : analysé, mais présenté comme peu précis", async () => {
  const w = world({ aiBehaviour: "ok" });
  const [r] = await w.analysis.analyzeLegs([leg("Dinamo Imaginaire", "Liverpool", "Victoire extérieur")]);
  assert.equal(r.etat, "ok");
  assert.equal(r.equipe1, "Dinamo Imaginaire");
  assert.equal(r.equipe2, "Liverpool FC");
  assert.equal(r.competition, "Ligue des champions");
  assert.equal(r.date, new Date(NOW + 70 * HOUR).toISOString());
  assert.equal(r.comparaisonEntreChampionnats.championnat1, "Autres clubs européens");
  assert.equal(r.comparaisonEntreChampionnats.championnat2, "Premier League");
  assert.match(r.comparaisonEntreChampionnats.message, /ne joue dans aucun championnat suivi/);
  assert.match(r.justification, /Justification de test/);
  assert.ok(r.probabilite > 50, "Liverpool, bien plus fort, est favori");
  assert.notEqual(r.niveauConfiance, "eleve");
  const [noAi] = await world().analysis.analyzeLegs([leg("Dinamo Imaginaire", "Liverpool", "Victoire extérieur")]);
  assert.match(noAi.justification, /Dinamo Imaginaire ne joue dans aucun championnat suivi/);
  assert.ok(noAi.statsEquipe1.forme.length > 0, "la forme du club vient de ses matchs de coupe");
});

test("deux clubs connus seulement par la coupe : analysés, libellé neutre", async () => {
  const w = world();
  const [r] = await w.analysis.analyzeLegs([leg("Dinamo Imaginaire", "Sparta Fictif", "Plus de 1.5 buts")]);
  assert.equal(r.etat, "ok");
  assert.equal(r.competition, "Match entre clubs européens");
  assert.equal(r.date, null);
  assert.match(r.comparaisonEntreChampionnats.message, /Aucun de ces clubs ne joue dans un championnat suivi/);
  assert.match(r.justification, /ne jouent dans aucun championnat suivi/);
  assert.notEqual(r.niveauConfiance, "eleve");
});

test("un club inconnu de tous les championnats et de toutes les coupes reste « équipe introuvable » : aucune probabilité inventée", async () => {
  const w = world();
  const [r] = await w.analysis.analyzeLegs([leg("Arsenal", "Club Totalement Inconnu", "Victoire domicile")]);
  assert.equal(r.etat, "equipe_inconnue");
  assert.equal(r.probabilite, null);
  assert.equal(r.equipesTrouvees1, true);
  assert.equal(r.equipesTrouvees2, false);
  assert.equal(w.ai.calls.length, 0);
});

test("des clubs de coupe aux noms proches de ceux des championnats ne se confondent pas", async () => {
  const w = world();
  const [ambig, exact] = await w.analysis.analyzeLegs([leg("Dinamo", "Arsenal", "Match nul"), leg("Sparta Fictif", "Arsenal", "Match nul")]);
  assert.equal(ambig.etat, "ok", "« Dinamo » ne désigne qu'un club ici");
  assert.equal(ambig.equipe1, "Dinamo Imaginaire");
  assert.equal(exact.etat, "ok");
  assert.equal(exact.equipe1, "Sparta Fictif");
});

test("coupe d'Europe en panne : les clubs des championnats restent comparables, avec le niveau a priori des championnats, et le dit", async () => {
  const w = world({ failing: ["UCL"] });
  const [r, unknown] = await w.analysis.analyzeLegs([leg("Arsenal", "Real Madrid", "Victoire domicile"), leg("Dinamo Imaginaire", "Liverpool", "Victoire extérieur")]);
  assert.equal(r.etat, "ok");
  assert.equal(r.competition, "Match entre clubs de championnats différents");
  assert.equal(r.date, null);
  assert.equal(r.comparaisonEntreChampionnats.niveauDesChampionnatsMesure, false);
  assert.match(r.comparaisonEntreChampionnats.message, /estimation générale/);
  assert.equal(r.niveauConfiance, "faible");
  const s = w.europe.status();
  assert.deepEqual(s.coupesChargees, []);
  assert.equal(s.matchsDeCoupeUtilises, 0);
  for (const l of s.niveauxDesChampionnats) {
    assert.equal(l.mesure, false);
    assert.equal(l.niveauEstime, l.niveauAPriori, `${l.key} reste à son niveau a priori`);
  }
  // le club « de coupe seulement » n'est pas connu sans la coupe : le message nomme la coupe indisponible
  assert.equal(unknown.etat, "equipe_inconnue");
  assert.match(unknown.message, /indisponibles pour : Ligue des champions/);
});

test("EUROPE_ENABLED=off : plus de coupes, plus de comparaison, le fonctionnement d'avant", async () => {
  const w = world({ env: { EUROPE_ENABLED: "off" } });
  assert.equal(w.europe.enabled, false);
  assert.deepEqual(w.europe.status(), { actif: false });
  assert.equal(w.europe.model(), null);
  assert.equal(w.europe.core({ id: "PL:0" }, { id: "PD:0" }), null);
  assert.equal(w.europe.findFixture("PL:0", "PD:0"), null);
  assert.deepEqual(w.europe.upcomingCupFixtures(0, Infinity), []);
  assert.deepEqual(w.europe.relevantFinished({ id: "PL:0" }, { id: "PD:0" }), []);
  assert.ok(w.data.leagues.every((l) => l.kind !== "cup"), "aucune coupe suivie");
  const [r, unknown] = await w.analysis.analyzeLegs([leg("Arsenal", "Real Madrid", "Victoire domicile"), leg("Dinamo Imaginaire", "Liverpool", "Victoire extérieur")]);
  assert.equal(r.etat, "ligues_differentes");
  assert.equal(unknown.etat, "equipe_inconnue");
});

test("matchs de coupe programmés : fenêtre, ordre et clubs reconnus", async () => {
  const w = world();
  await w.analysis.loadAll();
  const names = (list) => list.map((f) => `${f.home.name} – ${f.away.name}`);
  assert.deepEqual(names(w.europe.upcomingCupFixtures(NOW, NOW + 100 * HOUR)), [
    "FC Barcelona – FC Internazionale Milano",
    "Arsenal FC – Real Madrid CF",
    "Juventus FC – Chelsea FC",
    "Dinamo Imaginaire – Liverpool FC",
  ]);
  assert.deepEqual(names(w.europe.upcomingCupFixtures(NOW + 25 * HOUR, NOW + 60 * HOUR)), ["Arsenal FC – Real Madrid CF", "Juventus FC – Chelsea FC"]);
  assert.deepEqual(w.europe.upcomingCupFixtures(NOW - 10 * HOUR, NOW), []);
  assert.ok(w.europe.upcomingCupFixtures(NOW, NOW + 100 * HOUR).every((f) => f.cup.key === "UCL"));
  assert.equal(w.europe.findFixture("PL:0", "PD:0").id, "UCL-F0");
  assert.equal(w.europe.findFixture("PD:0", "PL:0"), null, "le sens du match compte");
  assert.equal(w.europe.findFixture("PL:0", "SA:0"), null);
  assert.equal(w.europe.teamRecord("PL:0").name, "Arsenal FC");
  assert.equal(w.europe.teamRecord("inconnu"), null);
});

test("matchs servant aux statistiques : championnat et coupe des deux clubs, du plus ancien au plus récent, sans doublon", async () => {
  const w = world();
  await w.analysis.loadAll();
  const arsenal = w.europe.teamRecord("PL:0");
  const real = w.europe.teamRecord("PD:0");
  const list = w.europe.relevantFinished(arsenal, real);
  assert.ok(list.length > 100);
  assert.ok(list.every((m) => [m.home.id, m.away.id].some((id) => id === "PL:0" || id === "PD:0")));
  assert.ok(list.some((m) => m.id.startsWith("UCL-")), "matchs de coupe");
  assert.ok(list.some((m) => m.id.startsWith("PL-")) && list.some((m) => m.id.startsWith("PD-")), "matchs de championnat");
  assert.deepEqual(list.map((m) => m.kickoff), list.map((m) => m.kickoff).sort((a, b) => a - b));
  assert.equal(new Set(list.map((m) => m.id)).size, list.length);
  assert.ok(list.every((m) => m.status === "finished"));
});

test("le modèle de comparaison est gardé en mémoire tant que les données ne changent pas, et refait quand elles changent", async () => {
  const w = world();
  await w.analysis.loadAll();
  const first = w.europe.model();
  assert.equal(w.europe.model(), first);
  const before = w.data.peekLeague("PL");
  w.clock.t += 40 * 60000; // les données expirent : l'ancienne version est servie tout de suite, la nouvelle se charge en arrière-plan
  await w.data.ensureAll({ scope: "essential" });
  for (let i = 0; i < 200 && w.data.peekLeague("PL") === before; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(w.data.peekLeague("PL"), before, "championnat rechargé");
  const second = w.europe.model();
  assert.notEqual(second, first);
  assert.equal(second.builtAt, w.clock.t);
  assert.equal(w.europe.model(), second);
});

test("annuaire des clubs : les clubs de coupe seulement sont à part, sans force de championnat", async () => {
  const w = world();
  await w.analysis.loadAll();
  const teams = w.data.allTeams();
  assert.equal(teams.length, 36 + CUP_ONLY.length);
  const lonely = teams.filter((t) => !t.rated);
  assert.deepEqual(lonely.map((t) => t.name).sort(), [...CUP_ONLY].sort());
  assert.ok(lonely.every((t) => t.leagueKey === "EUR"));
  assert.ok(teams.filter((t) => t.rated).every((t) => ["PL", "PD", "SA"].includes(t.leagueKey)));
});

test("sur un monde simulé, l'erreur d'une prévision entre championnats est du même ordre que celle d'une prévision dans un championnat", async () => {
  const w = world();
  await w.analysis.loadAll();
  const teams = w.data.allTeams().filter((t) => t.rated);
  const truth = (t) => {
    const [k, i] = t.id.split(":");
    const x = w.store[k].truth.get(`T${i}`);
    return { a: x.a, d: x.d, level: TRUE_LEVEL[k] };
  };
  const errors = { same: [], cross: [] };
  for (const h of teams) {
    for (const g of teams) {
      if (h === g) continue;
      const th = truth(h);
      const tg = truth(g);
      if (h.leagueKey === g.leagueKey) {
        const real = describeMatrix(scoreMatrix(1.25 * 1.3 * th.a * tg.d, 1.25 * tg.a * th.d, { rho: -0.08, maxGoals: 9 })).outcomes;
        const model = w.analysis.computeCore(await w.data.getLeagueData(h.leagueKey), h.id, g.id).outcomes;
        errors.same.push(model.home - real.home);
      } else {
        const u = th.level - tg.level;
        const real = describeMatrix(scoreMatrix(1.1 * 1.3 * th.a * tg.d * Math.exp(u), 1.1 * tg.a * th.d * Math.exp(-u), { rho: -0.08, maxGoals: 9 })).outcomes;
        const model = w.europe.core(h, g).outcomes;
        errors.cross.push(model.home - real.home);
      }
    }
  }
  const mae = (xs) => xs.reduce((s, x) => s + Math.abs(x), 0) / xs.length;
  const bias = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.equal(errors.cross.length, 864);
  assert.ok(mae(errors.cross) < 0.09, `erreur moyenne entre championnats : ${(mae(errors.cross) * 100).toFixed(1)} points`);
  assert.ok(mae(errors.cross) < mae(errors.same) + 0.02, `entre championnats ${(mae(errors.cross) * 100).toFixed(1)} points, dans un championnat ${(mae(errors.same) * 100).toFixed(1)} points`);
  assert.ok(Math.abs(bias(errors.cross)) < 0.03, `biais ${(bias(errors.cross) * 100).toFixed(1)} points`);
});

test("mode Auto : un match entre championnats, un match avec un club de coupe seulement et un club inconnu dans le même coupon", async () => {
  const w = world();
  const r = await w.coupons.autoCoupon([
    { equipe1: "Arsenal", equipe2: "Real Madrid" },
    { equipe1: "Dinamo Imaginaire", equipe2: "Sparta Fictif" },
    { equipe1: "Juventus", equipe2: "Chelsea" },
    { equipe1: "Arsenal", equipe2: "Ailleurs" },
  ]);
  assert.deepEqual(r.resultats.map((x) => x.etat), ["ok", "ok", "ok", "equipe_inconnue"]);
  assert.equal(r.analyses, 3);
  assert.deepEqual(r.resultats.slice(0, 3).map((x) => x.competition), ["Ligue des champions", "Match entre clubs européens", "Ligue des champions"]);
  for (const x of r.resultats.slice(0, 3)) {
    assert.ok(x.comparaisonEntreChampionnats, `${x.equipe1} – ${x.equipe2}`);
    assert.ok(x.probabilite > 50 && x.probabilite <= 99, `p = ${x.probabilite}`);
    assert.ok(x.typePari);
    assert.notEqual(x.niveauConfiance, "eleve");
  }
  const joint = r.resultats.slice(0, 3).reduce((acc, x) => acc * (x.probabilite / 100), 1);
  close(r.probabiliteCombinee, joint * 100, 0.3, "probabilité combinée");
  assert.ok(Number(r.coteTotale) > 1);
});

test("mode Auto sans comparaison entre championnats : le match entre deux championnats est refusé comme avant", async () => {
  const w = world({ env: { EUROPE_ENABLED: "off" } });
  const r = await w.coupons.autoCoupon([{ equipe1: "Arsenal", equipe2: "Real Madrid" }, { equipe1: "Arsenal", equipe2: "Chelsea" }]);
  assert.deepEqual(r.resultats.map((x) => x.etat), ["ligues_differentes", "ok"]);
  assert.equal(r.analyses, 1);
});

test("Top Matchs : les matchs de Ligue des champions peuvent être proposés et sont signalés comme moins précis", async () => {
  const w = world({ fixtureHours: [] }); // aucun match de championnat : seule la coupe a des matchs à venir
  const r = await w.coupons.topMatches();
  assert.equal(r.topMatches.length, 4);
  assert.ok(r.topMatches.every((m) => m.competition === "Ligue des champions"));
  assert.deepEqual(r.donnees.coupesPretes, ["UCL"]);
  assert.deepEqual(r.donnees.championnatsPrets, ["PL", "PD", "SA"]);
  assert.equal(r.complet, true);
  for (const m of r.topMatches) {
    assert.ok(m.comparaisonEntreChampionnats, `${m.homeTeam} – ${m.awayTeam}`);
    assert.notEqual(m.niveauConfiance, "eleve");
    assert.ok(Date.parse(m.date) > NOW && Date.parse(m.date) <= NOW + 72 * HOUR);
    assert.ok(m.statsHome && m.statsAway);
    assert.ok(m.probabilite > 50 && m.probabilite <= 99);
  }
  assert.equal(new Set(r.topMatches.map((m) => m.id)).size, 4);
});

test("Top Matchs : une confrontation de coupe entre deux clubs du même championnat est calculée par le modèle du championnat, sans mention de « championnats différents »", async () => {
  const w = world({ fixtureHours: [] });
  const team = (i) => ({ id: `PL:${i}`, name: ["Arsenal FC", "Chelsea FC"][i], shortName: "" });
  // Seul match à venir : Arsenal – Chelsea en Ligue des champions (deux clubs de la Premier League).
  w.store.UCL.cur = w.store.UCL.cur.filter((m) => m.status === "finished");
  w.store.UCL.cur.push({ id: "UCL-PL", kickoff: NOW + 10 * HOUR, status: "scheduled", hg: null, ag: null, home: team(0), away: team(1) });
  const r = await w.coupons.topMatches();
  assert.equal(r.topMatches.length, 1);
  const m = r.topMatches[0];
  assert.equal(m.competition, "Ligue des champions");
  assert.equal(m.comparaisonEntreChampionnats, undefined, "les deux clubs jouent dans le même championnat");
  assert.ok(!/ne jouent pas dans le même championnat/.test(m.justification));
  const domestic = w.analysis.computeCore(await w.data.getLeagueData("PL"), "PL:0", "PL:1");
  close(m.butsAttendus.equipe1, domestic.lh, 0.006, "buts attendus du club qui reçoit");
  close(m.butsAttendus.equipe2, domestic.la, 0.006, "buts attendus du club qui se déplace");
});

test("Top Matchs : championnats et coupes ensemble, jamais plus de quatre matchs et jamais un match deux fois", async () => {
  const w = world();
  const r = await w.coupons.topMatches();
  assert.equal(r.topMatches.length, 4);
  assert.equal(new Set(r.topMatches.map((m) => m.id)).size, 4);
  assert.deepEqual(r.donnees.coupesPretes, ["UCL"]);
  const product = r.topMatches.reduce((acc, m) => acc * (100 / m.probabilite), 1);
  close(Number(r.coteTotale), product, 0.05, "cote totale");
});

test("TOP_CUPS=off : « Top Matchs » ne retient plus de match de coupe, mais le mode Auto et « Mon coupon » les analysent toujours", async () => {
  const w = world({ fixtureHours: [], env: { TOP_CUPS: "off" } });
  const top = await w.coupons.topMatches();
  assert.deepEqual(top.topMatches, []);
  assert.match(top.message, /Aucun match/);
  assert.deepEqual(top.donnees.coupesPretes, []);
  const [r] = await w.analysis.analyzeLegs([leg("Arsenal", "Real Madrid", "Victoire domicile")]);
  assert.equal(r.etat, "ok");
  assert.equal(r.competition, "Ligue des champions");
});

test("Top Matchs : une coupe en panne ne bloque pas les championnats", async () => {
  const w = world({ failing: ["UCL"] });
  const r = await w.coupons.topMatches();
  assert.equal(r.topMatches.length, 4);
  assert.ok(r.topMatches.every((m) => m.competition !== "Ligue des champions"));
  assert.deepEqual(r.donnees.coupesPretes, []);
  assert.deepEqual(r.donnees.enEchec.map((f) => f.key), ["UCL"]);
});

test("Top Matchs : un match de coupe dont les championnats ne sont pas mesurés n'est jamais proposé (qualité insuffisante)", async () => {
  // La coupe est en panne pour la comparaison des niveaux mais ses matchs à venir ne sont pas connus non plus : aucun candidat de coupe.
  const w = world({ failing: ["UCL"], fixtureHours: [] });
  const r = await w.coupons.topMatches();
  assert.deepEqual(r.topMatches, []);
});
