"use strict";

// fd = code football-data.org ; tsdb = identifiant TheSportsDB ; tsdbName = nom exact du championnat chez TheSportsDB
// (sert à lister ses équipes ; vérifié : la recherche par ce nom renvoie bien le championnat d'identifiant `tsdb`).
// style "split" : saison août-mai ("2026-2027") ; "calendar" : saison sur l'année civile.
//
// kind "league" (par défaut) : championnat national ; kind "cup" : compétition entre clubs de pays différents (coupes d'Europe).
// tier "core" (par défaut) : suivi principal, chargé en premier, utilisé par « Top Matchs » et par le réglage automatique du modèle ;
//      tier "extra" : championnat complémentaire, chargé ensuite en arrière-plan. Il sert à analyser un match saisi à la main
//      (« Mon coupon », « Auto »), mais jamais à choisir le « Top Matchs » (moins de recul sur la qualité de ses données).
// strength : niveau moyen a priori du championnat, en écart de log-buts par équipe par rapport à la Premier League (0).
//      Environ 0,23 pour 100 points Elo d'écart moyen entre deux championnats. Ce n'est qu'un point de départ : pour les championnats
//      dont les clubs jouent les coupes d'Europe, il est corrigé par les résultats réels (voir cross.js).
const LEAGUES = [
  { key: "PL", name: "Premier League", country: "Angleterre", fd: "PL", tsdb: "4328", tsdbName: "English Premier League", style: "split", strength: 0 },
  { key: "PD", name: "Liga", country: "Espagne", fd: "PD", tsdb: "4335", tsdbName: "Spanish La Liga", style: "split", strength: -0.14 },
  { key: "SA", name: "Serie A", country: "Italie", fd: "SA", tsdb: "4332", tsdbName: "Italian Serie A", style: "split", strength: -0.16 },
  { key: "BL1", name: "Bundesliga", country: "Allemagne", fd: "BL1", tsdb: "4331", tsdbName: "German Bundesliga", style: "split", strength: -0.18 },
  { key: "FL1", name: "Ligue 1", country: "France", fd: "FL1", tsdb: "4334", tsdbName: "French Ligue 1", style: "split", strength: -0.3 },
  { key: "PPL", name: "Primeira Liga", country: "Portugal", fd: "PPL", tsdb: "4344", tsdbName: "Portuguese Primeira Liga", style: "split", strength: -0.48 },
  { key: "DED", name: "Eredivisie", country: "Pays-Bas", fd: "DED", tsdb: "4337", tsdbName: "Dutch Eredivisie", style: "split", strength: -0.46 },
  { key: "BSA", name: "Brasileirão", country: "Brésil", fd: "BSA", tsdb: "4351", tsdbName: "Brazilian Serie A", style: "calendar", strength: -0.39 },
  { key: "SPL", name: "Premiership écossaise", country: "Écosse", fd: null, tsdb: "4330", tsdbName: "Scottish Premier League", style: "split", strength: -0.71 },
  { key: "BJL", name: "Pro League belge", country: "Belgique", fd: null, tsdb: "4338", tsdbName: "Belgian Pro League", style: "split", strength: -0.53 },

  // ---- Coupes d'Europe : leurs matchs relient les championnats entre eux (voir cross.js) ----
  { key: "UCL", name: "Ligue des champions", country: "Europe", fd: "CL", tsdb: "4480", tsdbName: "UEFA Champions League", style: "split", kind: "cup" },
  { key: "UEL", name: "Ligue Europa", country: "Europe", fd: null, tsdb: "4481", tsdbName: "UEFA Europa League", style: "split", kind: "cup" },
  { key: "UECL", name: "Ligue Conférence", country: "Europe", fd: null, tsdb: "5071", tsdbName: "UEFA Conference League", style: "split", kind: "cup" },

  // ---- Championnats complémentaires (analyse d'un match saisi à la main) ----
  { key: "ELC", name: "Championship", country: "Angleterre (2e division)", fd: "ELC", tsdb: "4329", tsdbName: "English League Championship", style: "split", tier: "extra", strength: -0.32 },
  { key: "BL2", name: "2. Bundesliga", country: "Allemagne (2e division)", fd: null, tsdb: "4399", tsdbName: "German 2. Bundesliga", style: "split", tier: "extra", strength: -0.44 },
  { key: "SD", name: "Liga 2", country: "Espagne (2e division)", fd: null, tsdb: "4400", tsdbName: "Spanish La Liga 2", style: "split", tier: "extra", strength: -0.53 },
  { key: "SB", name: "Serie B", country: "Italie (2e division)", fd: null, tsdb: "4394", tsdbName: "Italian Serie B", style: "split", tier: "extra", strength: -0.55 },
  { key: "FL2", name: "Ligue 2", country: "France (2e division)", fd: null, tsdb: "4401", tsdbName: "French Ligue 2", style: "split", tier: "extra", strength: -0.58 },
  { key: "TSL", name: "Süper Lig", country: "Turquie", fd: null, tsdb: "4339", tsdbName: "Turkish Super Lig", style: "split", tier: "extra", strength: -0.55 },
  { key: "GSL", name: "Super League grecque", country: "Grèce", fd: null, tsdb: "4336", tsdbName: "Greek Super League 1", style: "split", tier: "extra", strength: -0.62 },
  { key: "ABL", name: "Bundesliga autrichienne", country: "Autriche", fd: null, tsdb: "4621", tsdbName: "Austrian Bundesliga", style: "split", tier: "extra", strength: -0.67 },
  { key: "SSL", name: "Super League suisse", country: "Suisse", fd: null, tsdb: "4675", tsdbName: "Swiss Super League", style: "split", tier: "extra", strength: -0.67 },
  { key: "DSL", name: "Superliga danoise", country: "Danemark", fd: null, tsdb: "4340", tsdbName: "Danish Superliga", style: "split", tier: "extra", strength: -0.67 },
  { key: "NOR", name: "Eliteserien", country: "Norvège", fd: null, tsdb: "4358", tsdbName: "Norwegian Eliteserien", style: "calendar", tier: "extra", strength: -0.74 },
  { key: "SWE", name: "Allsvenskan", country: "Suède", fd: null, tsdb: "4347", tsdbName: "Swedish Allsvenskan", style: "calendar", tier: "extra", strength: -0.8 },
  { key: "POL", name: "Ekstraklasa", country: "Pologne", fd: null, tsdb: "4422", tsdbName: "Polish Ekstraklasa", style: "split", tier: "extra", strength: -0.78 },
  { key: "UPL", name: "Premier-liga ukrainienne", country: "Ukraine", fd: null, tsdb: "4354", tsdbName: "Ukrainian Premier League", style: "split", tier: "extra", strength: -0.74 },
  { key: "HNL", name: "HNL croate", country: "Croatie", fd: null, tsdb: "4629", tsdbName: "Croatian First Football League", style: "split", tier: "extra", strength: -0.76 },
  { key: "SRB", name: "SuperLiga serbe", country: "Serbie", fd: null, tsdb: "4671", tsdbName: "Serbian Super Liga", style: "split", tier: "extra", strength: -0.76 },
  { key: "ISR", name: "Ligat ha'Al", country: "Israël", fd: null, tsdb: "4644", tsdbName: "Israeli Premier League", style: "split", tier: "extra", strength: -0.78 },
  { key: "RPL", name: "Premier-Liga russe", country: "Russie", fd: null, tsdb: "4355", tsdbName: "Russian Football Premier League", style: "split", tier: "extra", strength: -0.67 },
  { key: "KSA", name: "Saudi Pro League", country: "Arabie saoudite", fd: null, tsdb: "4668", tsdbName: "Saudi-Arabian Pro League", style: "split", tier: "extra", strength: -0.67 },
  { key: "ARG", name: "Liga Profesional argentine", country: "Argentine", fd: null, tsdb: "4406", tsdbName: "Argentinian Primera Division", style: "calendar", tier: "extra", strength: -0.46 },
].map((l) => ({ kind: "league", tier: "core", ...l }));

const byKey = new Map(LEAGUES.map((l) => [l.key, l]));

const isCup = (league) => Boolean(league) && league.kind === "cup";

// Clé réservée aux clubs qui ne jouent dans aucun des championnats suivis mais qu'une coupe d'Europe a fait connaître
// (par exemple un club tchèque, chypriote ou kazakh). Niveau a priori et incertitude : voir cross.js.
const OTHER_KEY = "EUR";
const OTHER = { key: OTHER_KEY, name: "Autres clubs européens", country: "Europe", kind: "other", tier: "extra", strength: -0.85 };

// Année de début de la saison en cours pour un championnat.
function seasonStartYear(league, nowMs) {
  const d = new Date(nowMs);
  if (league.style === "calendar") return d.getUTCFullYear();
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

module.exports = { LEAGUES, byKey, isCup, seasonStartYear, OTHER_KEY, OTHER };
