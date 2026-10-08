"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { findTeam, canon, coreOf } = require("../src/teams");
const { GROUPS } = require("../src/team-groups");
const { pool } = require("./fixtures/thesportsdb-teams");

// Ces tests utilisent les vrais noms de TheSportsDB (voir le fichier de données) : c'est ce qui manquait quand « PSG »
// était reconnu comme « Paris FC » et « Bayern Munich » comme introuvable en production.
const TEAMS = pool();
const WITH_ALT = pool({ withAlternates: true });
const name = (q, teams = TEAMS, opts) => {
  const r = findTeam(q, teams, opts);
  return r.team ? r.team.name : r.ambiguous ? `AMBIGU(${r.alternatives.join(" / ")})` : null;
};

test("PSG, Paris Saint-Germain et leurs variantes désignent « Paris SG », jamais « Paris FC »", () => {
  for (const q of ["PSG", "psg", "Paris SG", "Paris Saint-Germain", "Paris Saint Germain", "paris st germain", "Paris Saint-Germain FC"]) {
    assert.equal(name(q), "Paris SG", q);
  }
  assert.equal(name("Paris FC"), "Paris FC");
});

test("le PSG sous l'écriture « Paris Saint-Germain » (autre saison, autre source) est reconnu aussi", () => {
  const teams = TEAMS.map((t) => (t.name === "Paris SG" ? { ...t, name: "Paris Saint-Germain" } : t));
  for (const q of ["PSG", "Paris SG", "Paris Saint-Germain", "Paris Saint Germain FC"]) assert.equal(name(q, teams), "Paris Saint-Germain", q);
  assert.equal(name("Paris FC", teams), "Paris FC");
});

test("« Paris » seul est ambigu : on demande de préciser au lieu de choisir un club au hasard", () => {
  const r = findTeam("Paris", TEAMS);
  assert.equal(r.team, null);
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.alternatives.slice().sort(), ["Paris FC", "Paris SG"]);
});

test("sans le PSG dans les données, « Paris Saint-Germain » ne tombe pas sur « Paris FC »", () => {
  const sansPsg = TEAMS.filter((t) => t.name !== "Paris SG");
  assert.equal(name("Paris Saint-Germain", sansPsg), null);
  assert.equal(name("PSG", sansPsg), null);
});

test("Marseille et Lyon : sigles et noms officiels", () => {
  for (const q of ["OM", "Olympique de Marseille", "Olympique Marseille", "Marseille"]) assert.equal(name(q), "Marseille", q);
  for (const q of ["OL", "Olympique Lyonnais", "Lyon"]) assert.equal(name(q), "Lyon", q);
  assert.equal(name("LOSC"), "Lille");
  assert.equal(name("Lille OSC"), "Lille");
});

test("Allemagne : « Bayern Munich » exact, « Bayern » et les écritures allemandes, sans jamais prendre Leverkusen", () => {
  for (const q of ["Bayern Munich", "Bayern", "FC Bayern", "FC Bayern München", "Bayern Munchen"]) assert.equal(name(q), "Bayern Munich", q);
  const sansBayern = TEAMS.filter((t) => t.name !== "Bayern Munich");
  assert.equal(name("Bayern", sansBayern), null);
  assert.equal(name("Bayern Munich", sansBayern), null);
  assert.equal(name("Bayer"), "Bayer Leverkusen");
  assert.equal(name("Bayer Leverkusen"), "Bayer Leverkusen");
  assert.equal(name("Leverkusen"), "Bayer Leverkusen");
  for (const q of ["Dortmund", "BVB", "Borussia Dortmund"]) assert.equal(name(q), "Borussia Dortmund", q);
  for (const q of ["Gladbach", "M'gladbach", "Mönchengladbach", "Borussia Monchengladbach"]) assert.equal(name(q), "Borussia Mönchengladbach", q);
  for (const q of ["Köln", "Koln", "FC Köln", "1. FC Köln", "Cologne"]) assert.equal(name(q), "Köln", q);
  for (const q of ["HSV", "Hamburger SV", "Hamburg"]) assert.equal(name(q), "Hamburg", q);
  for (const q of ["Leipzig", "RB Leipzig", "RasenBallsport Leipzig"]) assert.equal(name(q), "RB Leipzig", q);
  assert.equal(name("Mainz 05"), "Mainz");
  assert.equal(name("Werder"), "Werder Bremen");
  assert.equal(name("Eintracht"), "Eintracht Frankfurt");
});

test("Angleterre : surnoms usuels vers les noms de TheSportsDB", () => {
  const cas = {
    "Man City": "Manchester City",
    "Man Utd": "Manchester United",
    "Man United": "Manchester United",
    "Manchester Utd": "Manchester United",
    Spurs: "Tottenham Hotspur",
    Tottenham: "Tottenham Hotspur",
    Wolves: "Wolverhampton Wanderers",
    Brighton: "Brighton and Hove Albion",
    "Brighton & Hove Albion": "Brighton and Hove Albion",
    Newcastle: "Newcastle United",
    "West Ham": "West Ham United",
    Forest: "Nottingham Forest",
    "Nottm Forest": "Nottingham Forest",
    Villa: "Aston Villa",
    Palace: "Crystal Palace",
    Leeds: "Leeds United",
    "AFC Bournemouth": "Bournemouth",
    "Chelsea FC": "Chelsea",
  };
  for (const [q, attendu] of Object.entries(cas)) assert.equal(name(q), attendu, q);
});

test("Espagne : surnoms usuels, et « Real » seul reste ambigu", () => {
  const cas = {
    Atleti: "Atlético Madrid",
    Atletico: "Atlético Madrid",
    "Atletico Madrid": "Atlético Madrid",
    "Atlético de Madrid": "Atlético Madrid",
    "Athletic Club": "Athletic Bilbao",
    Athletic: "Athletic Bilbao",
    "Barça": "Barcelona",
    Barca: "Barcelona",
    "FC Barcelona": "Barcelona",
    Betis: "Real Betis",
    Sociedad: "Real Sociedad",
    Celta: "Celta Vigo",
    Alaves: "Deportivo Alavés",
    Rayo: "Rayo Vallecano",
    Villareal: "Villarreal",
    "Real Madrid CF": "Real Madrid",
    Espanol: "Espanyol",
  };
  for (const [q, attendu] of Object.entries(cas)) assert.equal(name(q), attendu, q);
  assert.match(name("Real"), /^AMBIGU/);
  assert.match(name("Madrid"), /^(AMBIGU|Real Madrid|Atlético Madrid)/); // jamais un autre championnat
});

test("Italie : « Inter » est l'Inter Milan (pas Internacional), « Milan » est l'AC Milan", () => {
  for (const q of ["Inter", "Internazionale", "Inter Milan", "FC Internazionale Milano", "Inter Milano"]) assert.equal(name(q), "Inter Milan", q);
  for (const q of ["Milan", "AC Milan", "A.C. Milan"]) assert.equal(name(q), q === "A.C. Milan" ? null : "AC Milan", q);
  assert.equal(name("Juve"), "Juventus");
  assert.equal(name("Juventus FC"), "Juventus");
  assert.equal(name("SS Lazio"), "Lazio");
  assert.equal(name("AS Roma"), "Roma");
  assert.equal(name("SSC Napoli"), "Napoli");
  assert.equal(name("Atalanta BC"), "Atalanta");
});

test("Portugal, Pays-Bas, Belgique, Écosse, Brésil", () => {
  const cas = {
    Sporting: "Sporting CP",
    "Sporting Lisbon": "Sporting CP",
    "SL Benfica": "Benfica",
    "FC Porto": "Porto",
    "SC Braga": "Braga",
    "Sporting Braga": "Braga",
    "Vitoria SC": "Vitória de Guimarães",
    Guimaraes: "Vitória de Guimarães",
    PSV: "PSV Eindhoven",
    "Ajax Amsterdam": "Ajax",
    "AFC Ajax": "Ajax",
    AZ: "AZ Alkmaar",
    "Feyenoord Rotterdam": "Feyenoord",
    "Club Bruges": "Club Brugge",
    Bruges: "Club Brugge",
    "Union SG": "Union Saint-Gilloise",
    "Royale Union Saint-Gilloise": "Union Saint-Gilloise",
    Standard: "Standard Liège",
    "Standard Liege": "Standard Liège",
    "KRC Genk": "Genk",
    "Royal Antwerp": "Antwerp",
    Hearts: "Heart of Midlothian",
    Hibs: "Hibernian",
    "Celtic FC": "Celtic",
    "Saint Mirren": "St Mirren",
    "Dundee Utd": "Dundee United",
    "Atletico MG": "Atlético Mineiro",
    "Athletico-PR": "Athletico Paranaense",
    "Sao Paulo": "São Paulo",
    Gremio: "Grêmio",
    "CR Flamengo": "Flamengo",
    Vasco: "Vasco da Gama",
    "Red Bull Bragantino": "Bragantino",
    "Inter de Porto Alegre": "Internacional",
  };
  for (const [q, attendu] of Object.entries(cas)) assert.equal(name(q), attendu, q);
});

test("« Dundee » (exact) l'emporte sur « Dundee United » ; « Union » seul est ambigu ; « United » seul aussi", () => {
  assert.equal(name("Dundee"), "Dundee");
  assert.match(name("Union"), /^AMBIGU/);
  assert.match(name("United"), /^AMBIGU/);
  assert.match(name("City"), /^AMBIGU/);
  assert.match(name("Manchester"), /^AMBIGU/);
});

test("un club inconnu ne devient jamais un autre club à cause d'un mot en commun", () => {
  for (const q of ["Paris Football Club Imaginaire", "Real Imaginaire", "Manchester Imaginaire", "Équipe Imaginaire XYZ", "Zzz", "FC"]) {
    const r = findTeam(q, TEAMS);
    assert.equal(r.team, null, `${q} -> ${r.team && r.team.name}`);
  }
});

test("les noms alternatifs fournis par TheSportsDB sont utilisés (surnoms, sigles, écritures longues)", () => {
  const cas = {
    "La Vecchia Signora": "Juventus",
    "Ein Frankfurt": "Eintracht Frankfurt",
    SGE: "Eintracht Frankfurt",
    "Atléti": "Atlético Madrid",
    "Ath Bilbao": "Athletic Bilbao",
    BHAFC: "Brighton and Hove Albion",
    "Brighton & Hove Albion Football Club": "Brighton and Hove Albion",
    CPFC: "Crystal Palace",
    "Olympique Lyon": "Lyon",
    "Sport Lisboa e Benfica": "Benfica",
    "FC Bayern München": "Bayern Munich",
  };
  for (const [q, attendu] of Object.entries(cas)) assert.equal(name(q, WITH_ALT), attendu, q);
});

test("deux clubs qui portent exactement le même nom alternatif : on demande de préciser", () => {
  const teams = [
    { id: 1, name: "Club A", aliases: ["Les Rouges"], leagueKey: "X" },
    { id: 2, name: "Club B", aliases: ["Les Rouges"], leagueKey: "X" },
  ];
  const r = findTeam("Les Rouges", teams);
  assert.equal(r.team, null);
  assert.equal(r.ambiguous, true);
});

test("dans un même championnat, une saisie ambiguë se résout grâce à l'adversaire (comme le fait l'analyse)", () => {
  assert.equal(name("Inter", TEAMS, { leagueKey: "SA" }), "Inter Milan");
  assert.equal(name("Internacional", TEAMS, { leagueKey: "BSA" }), "Internacional");
  assert.equal(name("Paris", TEAMS, { leagueKey: "FL1" }).startsWith("AMBIGU"), true);
});

test("chaque écriture d'un groupe n'appartient qu'à un seul groupe (sinon deux clubs seraient confondus)", () => {
  const owner = new Map();
  GROUPS.forEach((group, i) => {
    for (const nom of group) {
      for (const forme of new Set([canon(nom)])) {
        if (!forme) continue;
        if (owner.has(forme) && owner.get(forme) !== i) assert.fail(`« ${forme} » figure dans les groupes ${owner.get(forme)} et ${i} (${group[0]})`);
        owner.set(forme, i);
      }
    }
  });
  assert.ok(owner.size > 200);
});

test("chaque groupe désigne bien un club présent dans les données réelles (aucune ligne orpheline)", () => {
  const forms = new Set(TEAMS.flatMap((t) => [canon(t.name), coreOf(t.name)]));
  const orphelins = GROUPS.filter((g) => !g.some((nom) => forms.has(canon(nom)) || forms.has(coreOf(nom)))).map((g) => g[0]);
  // Quelques clubs n'ont pas été relevés dans l'échantillon de noms (autres divisions ou autres saisons) : on en tolère peu.
  assert.ok(orphelins.length <= 20, `groupes sans club correspondant : ${orphelins.join(", ")}`);
});

// ---- Contrôles systématiques sur l'ensemble des clubs réels ----

const decorations = (nom) => [nom, nom.toLowerCase(), nom.toUpperCase(), canon(nom), `FC ${nom}`, `${nom} FC`];

test("chaque club réel est retrouvé par son propre nom : tel quel, en majuscules, sans accents, avec « FC » devant ou derrière", () => {
  const ecarts = [];
  for (const teams of [TEAMS, WITH_ALT]) {
    for (const t of teams) {
      for (const q of decorations(t.name)) {
        const r = findTeam(q, teams);
        if (!r.team || r.team.id !== t.id) ecarts.push(`${t.leagueKey} « ${q} » -> ${r.team ? r.team.name : r.ambiguous ? "ambigu" : "introuvable"}`);
      }
    }
  }
  assert.deepEqual(ecarts, []);
});

test("chaque nom alternatif réel désigne son club, sauf s'il est partagé par un club d'un autre championnat (alors : ambigu)", () => {
  const ecarts = [];
  for (const t of WITH_ALT) {
    for (const alt of t.aliases) {
      const r = findTeam(alt, WITH_ALT);
      if (r.team && r.team.id === t.id) continue;
      // Seule exception connue : « Atlético » est un nom alternatif du club brésilien, alors que « Atletico » désigne aussi Madrid.
      if (!r.team && r.ambiguous && canon(alt) === "atletico") {
        assert.equal(name(alt, WITH_ALT, { leagueKey: t.leagueKey }), t.name, `${alt} dans son championnat`);
        continue;
      }
      ecarts.push(`${t.leagueKey} alt « ${alt} » de ${t.name} -> ${r.team ? r.team.name : r.ambiguous ? "ambigu" : "introuvable"}`);
    }
  }
  assert.deepEqual(ecarts, []);
});

test("chaque écriture des groupes désigne son club ou reste ambiguë, jamais un autre club", () => {
  for (const teams of [TEAMS, WITH_ALT]) {
    const parNom = new Map();
    for (const t of teams) parNom.set(canon(t.name), [...(parNom.get(canon(t.name)) || []), t]);
    const mauvais = [];
    const ambigus = new Set();
    for (const g of GROUPS) {
      const proprietaires = new Set(g.flatMap((m) => (parNom.get(canon(m)) || []).map((t) => t.id)));
      if (!proprietaires.size) continue;
      for (const ecriture of g) {
        const r = findTeam(ecriture, teams);
        if (r.team && !proprietaires.has(r.team.id)) mauvais.push(`« ${ecriture} » (groupe ${g[0]}) -> ${r.team.name}`);
        if (!r.team) ambigus.add(canon(ecriture));
      }
    }
    assert.deepEqual(mauvais, []);
    // Avec les noms alternatifs réels, seul « Atletico » seul (Madrid, Mineiro ou Paranaense ?) demande de préciser.
    assert.deepEqual([...ambigus], teams === WITH_ALT ? ["atletico"] : []);
  }
});

test("« Atlético Madrid » reste reconnu même si le club brésilien a « Atlético » pour nom alternatif ; « Atlético » seul demande de préciser", () => {
  for (const q of ["Atlético Madrid", "Atletico Madrid", "Atleti", "Club Atlético de Madrid"]) assert.equal(name(q, WITH_ALT), "Atlético Madrid", q);
  assert.match(name("Atlético", WITH_ALT), /^AMBIGU/);
  assert.equal(name("Atlético", WITH_ALT, { leagueKey: "PD" }), "Atlético Madrid");
  assert.equal(name("Atlético", WITH_ALT, { leagueKey: "BSA" }), "Atlético Mineiro");
});

test("la saisie contient le nom complet d'un club avec des mots sans importance : « Angers FC », « FC Dundee »…", () => {
  assert.equal(name("Angers FC"), "Angers");
  assert.equal(name("FC Angers"), "Angers");
  assert.equal(name("Dundee FC"), "Dundee");
  assert.equal(name("FC Dundee"), "Dundee");
  assert.equal(name("Dundee United FC"), "Dundee United");
  assert.equal(name("Vitória FC", TEAMS, { leagueKey: "BSA" }), "Vitória");
});

test("fautes de frappe : acceptées sur les noms longs, jamais sur les noms courts", () => {
  for (const [q, attendu] of Object.entries({ Liverpol: "Liverpool", "Manchster City": "Manchester City", "Tottenam Hotspur": "Tottenham Hotspur", "Borusia Dortmund": "Borussia Dortmund", Juventis: "Juventus" })) {
    assert.equal(name(q), attendu, q);
  }
  // « Bayern » absent des données ne devient pas « Bayer » (Leverkusen), « Angers » absent ne devient pas « Rangers ».
  const sansBayern = TEAMS.filter((t) => t.name !== "Bayern Munich");
  assert.equal(name("Bayern", sansBayern), null);
  const sansAngers = TEAMS.filter((t) => t.name !== "Angers");
  assert.equal(name("Angers", sansAngers), null);
  assert.equal(name("Lens", TEAMS.filter((t) => t.name !== "Lens")), null);
});
