"use strict";

// Groupes de noms équivalents : chaque ligne désigne UN SEUL club sous plusieurs écritures
// (nom officiel, nom court, abréviation, surnom courant, écriture d'une autre source de données).
//
// Pourquoi des groupes plutôt qu'un simple « surnom → nom officiel » ?
//  - TheSportsDB et football-data.org n'écrivent pas les noms de la même façon (« Paris SG » ou
//    « Paris Saint-Germain » ou « Paris Saint-Germain FC »), et une même source peut changer d'une saison à l'autre ;
//  - chaque club reçoit toutes les écritures du groupe où figure son nom, et la saisie de l'utilisateur est comparée telle
//    quelle à ces écritures : un surnom ne remplace jamais ce qui a été tapé (voir namesOf dans teams.js).
//
// Règles pour ajouter une ligne :
//  - uniquement des écritures dont le sens habituel est ce club (« Inter » = Inter Milan) ; jamais « City », « United » ou
//    « Real » seuls, qui désignent plusieurs clubs ;
//  - une écriture ne doit figurer que dans UN groupe (vérifié par un test) ;
//  - inutile d'ajouter ce que la comparaison gère déjà : majuscules, accents, tirets, « FC », « AC », « SL »…
//    (voir NOISE dans teams.js), ni les noms identiques sans ces mots.
const GROUPS = [
  // ---- Angleterre ----
  ["Manchester City", "Man City", "MCFC"],
  ["Manchester United", "Man United", "Man Utd", "Man U", "MUFC"],
  ["Tottenham Hotspur", "Tottenham", "Spurs"],
  ["Wolverhampton Wanderers", "Wolves", "Wolverhampton"],
  ["Nottingham Forest", "Nottm Forest", "Nott'm Forest", "Forest"],
  ["West Ham United", "West Ham", "WHU"],
  ["Newcastle United", "Newcastle", "NUFC"],
  ["Brighton and Hove Albion", "Brighton & Hove Albion", "Brighton Hove Albion", "Brighton"],
  ["Leeds United", "Leeds"],
  ["Crystal Palace", "Palace"],
  ["Aston Villa", "Villa"],
  ["Sheffield United", "Sheff Utd"],
  ["West Bromwich Albion", "West Brom"],

  // ---- Espagne ----
  ["Atlético Madrid", "Club Atlético de Madrid", "Atlético de Madrid", "Atleti", "Atletico", "ATM"],
  ["Athletic Bilbao", "Athletic Club", "Athletic Club Bilbao", "Ath Bilbao", "Athletic"],
  ["Real Sociedad", "Real Sociedad de Fútbol", "Sociedad", "La Real"],
  ["Real Betis", "Real Betis Balompié", "Betis"],
  ["Celta Vigo", "Celta de Vigo", "RC Celta", "Celta"],
  ["Deportivo Alavés", "Alavés", "Alaves"],
  ["Rayo Vallecano", "Rayo Vallecano de Madrid", "Rayo"],
  ["Barcelona", "FC Barcelona", "Barça", "Barca"],
  ["Villarreal", "Villareal"],
  ["Espanyol", "Espanol", "RCD Espanyol de Barcelona"],

  // ---- Italie ----
  ["Inter Milan", "Internazionale", "Internazionale Milano", "FC Internazionale Milano", "Inter Milano", "Inter"],
  ["AC Milan", "Milan"],
  ["Juventus", "Juve"],
  ["Hellas Verona", "Verona"],

  // ---- Allemagne ----
  ["Bayern Munich", "Bayern München", "Bayern Munchen", "FC Bayern München", "FC Bayern Munich", "FC Bayern", "Bayern"],
  ["Borussia Dortmund", "Dortmund", "BVB"],
  ["Borussia Mönchengladbach", "Mönchengladbach", "Monchengladbach", "Gladbach", "M'gladbach", "Borussia M'gladbach"],
  ["Bayer Leverkusen", "Bayer 04 Leverkusen", "Bayer 04", "Bayer", "Leverkusen"],
  ["RB Leipzig", "RasenBallsport Leipzig", "Leipzig"],
  ["Eintracht Frankfurt", "Frankfurt", "Eintracht"],
  ["Köln", "1. FC Köln", "FC Köln", "Cologne"],
  ["Hamburg", "Hamburger SV", "HSV"],
  ["Werder Bremen", "SV Werder Bremen", "Bremen", "Werder"],
  ["Union Berlin", "1. FC Union Berlin"],
  ["Mainz", "Mainz 05", "1. FSV Mainz 05"],

  // ---- France ----
  ["Paris Saint-Germain", "Paris SG", "Paris Saint-Germain FC", "PSG"],
  ["Marseille", "Olympique de Marseille", "Olympique Marseille", "OM"],
  ["Lyon", "Olympique Lyonnais", "Olympique Lyon", "OL"],
  ["Lille", "LOSC", "LOSC Lille", "Lille OSC"],
  ["Saint-Étienne", "AS Saint-Étienne", "ASSE"],
  ["Rennes", "Stade Rennais", "Stade Rennais FC"],
  ["Brest", "Stade Brestois", "Stade Brestois 29"],
  ["Strasbourg", "RC Strasbourg Alsace"],
  ["Montpellier", "Montpellier HSC", "MHSC"],
  ["Reims", "Stade de Reims"],

  // ---- Portugal ----
  ["Sporting CP", "Sporting", "Sporting Lisbon", "Sporting Lisboa", "Sporting Clube de Portugal"],
  ["Benfica", "SL Benfica", "SLB", "Sport Lisboa e Benfica"],
  ["Braga", "SC Braga", "Sporting Braga", "Sporting de Braga"],
  ["Vitória de Guimarães", "Vitoria Guimaraes", "Guimarães", "Vitória SC"],

  // ---- Pays-Bas ----
  ["PSV Eindhoven", "PSV"],
  ["Ajax", "AFC Ajax", "Ajax Amsterdam"],
  ["AZ Alkmaar", "AZ"],
  ["Feyenoord", "Feyenoord Rotterdam"],
  ["Sparta Rotterdam", "Sparta"],
  ["Go Ahead Eagles", "GA Eagles"],

  // ---- Belgique ----
  ["Club Brugge", "Club Bruges", "Brugge", "Bruges", "FC Bruges"],
  ["Anderlecht", "RSC Anderlecht"],
  ["Union Saint-Gilloise", "Royale Union Saint-Gilloise", "Union SG", "USG"],
  ["Standard Liège", "Standard de Liège", "Standard"],
  ["Genk", "KRC Genk"],
  ["Gent", "KAA Gent", "La Gantoise"],
  ["Antwerp", "Royal Antwerp", "Royal Antwerp FC"],

  // ---- Écosse ----
  ["Heart of Midlothian", "Heart of Midlothian FC", "Hearts"],
  ["Hibernian", "Hibernian FC", "Hibs"],
  ["Celtic", "Celtic FC", "Celtic Glasgow"],
  ["Rangers", "Rangers FC", "Glasgow Rangers"],

  // ---- Brésil ----
  ["Atlético Mineiro", "Atlético-MG", "Atletico MG", "Galo"],
  ["Athletico Paranaense", "Athletico-PR", "Athletico PR", "Atlético Paranaense"],
  ["São Paulo", "São Paulo FC", "SPFC"],
  ["Grêmio", "Grêmio FBPA"],
  ["Flamengo", "CR Flamengo", "Mengão"],
  ["Palmeiras", "SE Palmeiras"],
  ["Vasco da Gama", "CR Vasco da Gama", "Vasco"],
  ["Internacional", "SC Internacional", "Inter de Porto Alegre", "Inter Porto Alegre"],
  ["Bragantino", "Red Bull Bragantino", "RB Bragantino"],
  ["Corinthians", "SC Corinthians Paulista", "Corinthians Paulista"],
  ["Botafogo", "Botafogo FR"],
  ["Sport Club do Recife", "Sport Recife"],
];

module.exports = { GROUPS };
