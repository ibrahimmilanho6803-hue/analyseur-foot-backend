"use strict";

// Noms de clubs tels que TheSportsDB les écrit (relevés sur le service réel en octobre 2026 : événements des saisons
// 2025-2026 et 2026-2027 de chaque championnat, et champ « strTeamAlternate » de quelques clubs).
// Sert à vérifier que la reconnaissance des noms tape juste avec les vraies écritures, et pas seulement avec celles
// qu'on imagine. Le PSG y figure sous « Paris SG » (écriture constatée sur le serveur de production).
const NAMES = {
  PL: ["Arsenal", "Aston Villa", "Bournemouth", "Brighton and Hove Albion", "Burnley", "Chelsea", "Coventry City", "Crystal Palace", "Everton", "Fulham", "Hull City", "Ipswich Town", "Leeds United", "Liverpool", "Manchester City", "Manchester United", "Newcastle United", "Nottingham Forest", "Sunderland", "Tottenham Hotspur", "West Ham United", "Wolverhampton Wanderers"],
  PD: ["Athletic Bilbao", "Atlético Madrid", "Barcelona", "Celta Vigo", "Deportivo Alavés", "Deportivo de A Coruña", "Elche", "Espanyol", "Getafe", "Girona", "Levante", "Mallorca", "Málaga", "Racing de Santander", "Rayo Vallecano", "Real Betis", "Real Madrid", "Real Oviedo", "Real Sociedad", "Sevilla", "Valencia", "Villarreal"],
  SA: ["AC Milan", "Atalanta", "Bologna", "Cagliari", "Como", "Cremonese", "Fiorentina", "Frosinone", "Genoa", "Inter Milan", "Juventus", "Lazio", "Lecce", "Monza", "Napoli", "Parma", "Pisa", "Roma", "Sassuolo", "Torino", "Udinese", "Venezia"],
  BL1: ["Augsburg", "Bayer Leverkusen", "Bayern Munich", "Borussia Dortmund", "Borussia Mönchengladbach", "Eintracht Frankfurt", "Elversberg", "FC Heidenheim", "Freiburg", "Hamburg", "Hoffenheim", "Köln", "Mainz", "Paderborn", "RB Leipzig", "Schalke 04", "Stuttgart", "Union Berlin", "Werder Bremen", "Wolfsburg"],
  FL1: ["Angers", "Auxerre", "Brest", "Le Havre", "Le Mans", "Lens", "Lille", "Lorient", "Lyon", "Marseille", "Monaco", "Nice", "Paris FC", "Paris SG", "Rennes", "Strasbourg", "Toulouse", "Troyes"],
  PPL: ["AVS", "Académico de Viseu", "Arouca", "Benfica", "Braga", "Casa Pia", "Estoril Praia", "Estrela Amadora", "Famalicao", "Gil Vicente", "Marítimo", "Nacional de Madeira", "Porto", "Santa Clara", "Sporting CP", "Tondela", "Vitória de Guimarães"],
  DED: ["ADO Den Haag", "AZ Alkmaar", "Ajax", "Cambuur", "Excelsior", "FC Volendam", "Feyenoord", "Fortuna Sittard", "Go Ahead Eagles", "Groningen", "Heerenveen", "NAC Breda", "NEC Nijmegen", "PEC Zwolle", "PSV Eindhoven", "Sparta Rotterdam", "Telstar", "Twente", "Utrecht", "Willem II"],
  SPL: ["Aberdeen", "Celtic", "Dundee", "Dundee United", "Falkirk", "Heart of Midlothian", "Hibernian", "Kilmarnock", "Livingston", "Motherwell", "Rangers", "St Johnstone", "St Mirren"],
  BJL: ["Anderlecht", "Antwerp", "Cercle Brugge", "Charleroi", "Club Brugge", "Dender", "Genk", "Gent", "Kortrijk", "Lommel", "Mechelen", "Oud-Heverlee Leuven", "RAAL La Louvière", "Sint-Truiden", "Standard Liège", "Union Saint-Gilloise", "Westerlo", "Zulte Waregem"],
  BSA: ["Athletico Paranaense", "Atlético Mineiro", "Bahia", "Botafogo", "Bragantino", "Chapecoense", "Corinthians", "Coritiba", "Cruzeiro", "Flamengo", "Fluminense", "Fortaleza", "Grêmio", "Internacional", "Juventude", "Mirassol", "Palmeiras", "Remo", "Santos", "Sport Club do Recife", "São Paulo", "Vasco da Gama", "Vitória"],
};

// Noms alternatifs (« strTeamAlternate »), copiés tels que le service les renvoie, y compris les espaces superflus.
const ALTERNATES = {
  "Bayern Munich": "FC Bayern München, FC Bayern, FC Bayern Munich, Bayern",
  "Borussia Dortmund": "Dortmund",
  "Borussia Mönchengladbach": "Mönchengladbach, Gladbach",
  "Eintracht Frankfurt": "Ein Frankfurt, Frankfurt, SGE",
  Hamburg: "Hamburger SV, HSV",
  "Inter Milan": "Inter, Internazionale Milano, Internazionale",
  "AC Milan": "Milan",
  Juventus: "Juve, Juventus FC, La Vecchia Signora, The Old Lady, Bianconeri",
  "Atlético Madrid": "Club Atlético de Madrid, Atlético de Madrid, Atléti",
  "Athletic Bilbao": "Ath Bilbao, Athletic Club, Athletic",
  Barcelona: "FC Barcelona",
  "Brighton and Hove Albion": "Brighton & Hove Albion Football Club, Brighton , BHAFC, Brighton & Hove Albion",
  "Crystal Palace": "Palace, CPFC",
  Lyon: "Olympique Lyonnais, Olympique Lyon, OL",
  Marseille: "Olympique de Marseille, Olympique Marseille",
  Braga: "SC Braga",
  Benfica: "SL Benfica, Sport Lisboa e Benfica",
  // Relevés sur le service réel (recherche des équipes de chaque championnat) :
  "Atlético Mineiro": "Atlético",
  "Athletico Paranaense": "Club Athletico Paranaense, ",
  Celtic: "Glasgow Celtic, The Celtic Football Club, Celtic FC",
  Dundee: "Dundee FC",
  "Dundee United": "Dundee Utd",
  "Heart of Midlothian": "Heart of Midlothian Football Club, Hearts",
  Anderlecht: "RSCA, Royal Sporting Club Anderlecht",
  Antwerp: "Royal Antwerp Football Club, Royal Antwerp",
  Augsburg: "Fußball-Club Augsburg 1907 e. V., FC Augsburg",
  "Bayer Leverkusen": "Bayer, Bayer 04 Leverkusen, Bayer Leverkusen",
  Bournemouth: "AFC Bournemouth, Athletic Football Club Bournemouth",
  Arsenal: "Arsenal Football Club, AFC, Arsenal FC",
  "Aston Villa": "Aston Villa FC",
  Atalanta: "Orobici, Atalanta BC",
  Bologna: "Bologna FC, Bologna FC 1909",
  Angers: "Angers SCO",
  Auxerre: "AJ Auxerre, Association de la Jeunesse Auxerroise, AJA",
  Brest: "Stade Brestois 29",
  Ajax: "AFC Ajax, Ajax Amsterdam",
  "AZ Alkmaar": "Alkmaar Zaanstreek, AZ",
  "ADO Den Haag": "Den Haag",
  "Académico de Viseu": "Académico de Viseu Futebol Clube",
  Arouca: "Futebol Clube de Arouca, FC Arouca",
};

const splitAlternates = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

// Les clubs comme le serveur les garde en mémoire : { id, name, shortName, aliases, leagueKey }.
function pool({ withAlternates = false, only } = {}) {
  const out = [];
  let n = 0;
  for (const [leagueKey, names] of Object.entries(NAMES)) {
    if (only && !only.includes(leagueKey)) continue;
    for (const name of names) {
      out.push({ id: `ts:${++n}`, name, shortName: "", aliases: withAlternates ? splitAlternates(ALTERNATES[name]) : [], leagueKey });
    }
  }
  return out;
}

module.exports = { NAMES, ALTERNATES, splitAlternates, pool };
