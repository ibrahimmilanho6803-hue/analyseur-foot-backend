"use strict";

// fd = code football-data.org ; tsdb = identifiant TheSportsDB.
// style "split" : saison août-mai ("2026-2027") ; "calendar" : saison sur l'année civile.
const LEAGUES = [
  { key: "PL", name: "Premier League", country: "Angleterre", fd: "PL", tsdb: "4328", style: "split" },
  { key: "PD", name: "Liga", country: "Espagne", fd: "PD", tsdb: "4335", style: "split" },
  { key: "SA", name: "Serie A", country: "Italie", fd: "SA", tsdb: "4332", style: "split" },
  { key: "BL1", name: "Bundesliga", country: "Allemagne", fd: "BL1", tsdb: "4331", style: "split" },
  { key: "FL1", name: "Ligue 1", country: "France", fd: "FL1", tsdb: "4334", style: "split" },
  { key: "PPL", name: "Primeira Liga", country: "Portugal", fd: "PPL", tsdb: "4344", style: "split" },
  { key: "DED", name: "Eredivisie", country: "Pays-Bas", fd: "DED", tsdb: "4337", style: "split" },
  { key: "BSA", name: "Brasileirão", country: "Brésil", fd: "BSA", tsdb: "4351", style: "calendar" },
  { key: "SPL", name: "Premiership écossaise", country: "Écosse", fd: null, tsdb: "4330", style: "split" },
  { key: "BJL", name: "Pro League belge", country: "Belgique", fd: null, tsdb: "4338", style: "split" },
];

const byKey = new Map(LEAGUES.map((l) => [l.key, l]));

// Année de début de la saison en cours pour un championnat.
function seasonStartYear(league, nowMs) {
  const d = new Date(nowMs);
  if (league.style === "calendar") return d.getUTCFullYear();
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

module.exports = { LEAGUES, byKey, seasonStartYear };
