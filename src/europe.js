"use strict";

const { byKey, isCup, OTHER, OTHER_KEY } = require("./leagues");
const { fitCross, crossMatrix } = require("./cross");
const { describeMatrix } = require("./markets");
const { round } = require("./util");

// Matchs entre clubs de championnats différents : branche le modèle de cross.js sur les données chargées.
//  - les matchs de coupes d'Europe (Ligue des champions, Ligue Europa, Ligue Conférence) relient les championnats entre eux ;
//  - la force de chaque club dans son championnat vient du modèle de championnat (data.js) ;
//  - un club connu seulement par une coupe d'Europe (ni dans l'un des championnats suivis) est évalué d'après ses seuls matchs de coupe.
// Tout est recalculé quand les données d'un championnat changent (le calcul est léger : quelques dizaines de millisecondes).
function createEurope({ config, data, now = Date.now, log = console }) {
  const cfg = config.europe || {};
  const enabled = Boolean(cfg.enabled);
  const domesticLeagues = data.leagues.filter((l) => !isCup(l));
  const cupLeagues = data.leagues.filter(isCup);
  const leagueName = (key) => (key === OTHER_KEY ? OTHER.name : (byKey.get(key) || {}).name || key);

  let memo = null;

  function build() {
    const teams = data.allTeams();
    const byId = new Map(teams.map((t) => [t.id, t]));
    const alias = data.teamAliasMap();
    const canon = (id) => alias.get(id) || id;
    const domestic = new Map();
    for (const l of domesticLeagues) {
      const v = data.peekLeague(l.key);
      if (v) domestic.set(l.key, v);
    }
    const cups = cupLeagues.map((l) => ({ league: l, value: data.peekLeague(l.key) })).filter((c) => c.value);

    const normTeam = (t) => ({ ...t, id: canon(t.id) });
    const cupFinished = [];
    const cupFixtures = [];
    const matches = [];
    for (const c of cups) {
      for (const m of c.value.finished) {
        const home = normTeam(m.home);
        const away = normTeam(m.away);
        if (!byId.has(home.id) || !byId.has(away.id)) continue;
        cupFinished.push({ ...m, home, away });
        matches.push({ id: m.id, h: home.id, g: away.id, hg: m.hg, ag: m.ag, kickoff: m.kickoff });
      }
      for (const f of c.value.fixtures) {
        const home = normTeam(f.home);
        const away = normTeam(f.away);
        if (byId.has(home.id) && byId.has(away.id)) cupFixtures.push({ ...f, home, away, cup: c.league });
      }
    }
    cupFinished.sort((a, b) => a.kickoff - b.kickoff);

    const describeTeam = (t) => {
      if (!t.rated) return { id: t.id, leagueKey: OTHER_KEY, a: 1, d: 1, rated: false };
      const ld = domestic.get(t.leagueKey);
      const f = ld && ld.fit ? ld.fit.teams.get(t.id) : null;
      return { id: t.id, leagueKey: t.leagueKey, a: f ? f.a : 1, d: f ? f.d : 1, rated: true };
    };

    const priors = [...domesticLeagues.map((l) => ({ key: l.key, mean: Number.isFinite(l.strength) ? l.strength : -0.7 })), { key: OTHER_KEY, mean: OTHER.strength }];
    const fit = fitCross({
      matches,
      describe: (id) => (byId.has(id) ? describeTeam(byId.get(id)) : null),
      leagues: priors,
      now: now(),
      halfLifeDays: cfg.halfLifeDays,
    });

    // Quantité de matchs derrière chaque club : en championnat pour un club suivi, en coupe pour les autres.
    const weights = (d) => {
      if (d.rated) {
        const ld = domestic.get(d.leagueKey);
        const f = ld && ld.fit ? ld.fit.teams.get(d.id) : null;
        return { w: f ? f.w : 0, n: f ? f.n : 0 };
      }
      return fit.team(d.id) || { w: 0, n: 0 };
    };

    return { teams, byId, alias, domestic, cups, cupFinished, cupFixtures, fit, describeTeam, weights, builtAt: now() };
  }

  // Modèle courant (null si les coupes sont coupées) ; reconstruit seulement si une donnée source a changé.
  function model() {
    if (!enabled) return null;
    const refs = [data.allTeams(), ...domesticLeagues.map((l) => data.peekLeague(l.key)), ...cupLeagues.map((l) => data.peekLeague(l.key))];
    if (memo && memo.refs.length === refs.length && memo.refs.every((r, i) => r === refs[i])) return memo.value;
    const value = build();
    memo = { refs, value };
    return value;
  }

  // Qualité des données d'un match entre championnats : jamais meilleure que « moyenne » (la comparaison entre championnats reste
  // une estimation) et « faible » quand le niveau relatif des deux championnats n'est pas mesuré par des matchs de coupe.
  function qualityFor(m, dh, dg) {
    const wh = m.weights(dh);
    const wg = m.weights(dg);
    const weakest = Math.min(wh.w, wg.w);
    let level = Math.min(1, weakest >= 12 ? 2 : weakest >= 6 ? 1 : 0);
    const lh = m.fit.league(dh.leagueKey);
    const lg = m.fit.league(dg.leagueKey);
    const measured = dh.leagueKey === dg.leagueKey || Boolean(lh && lg && lh.calibrated && lg.calibrated);
    if (!measured) level = 0;
    return { weakest, level, nHome: wh.n, nAway: wg.n, measured };
  }

  // Calcul complet d'un match entre deux clubs (enregistrements de data.allTeams()) : même forme que analysis.computeCore.
  function core(home, away) {
    const m = model();
    if (!m) return null;
    const dh = m.describeTeam(home);
    const dg = m.describeTeam(away);
    const pred = m.fit.predict(dh, dg);
    const matrix = crossMatrix(pred, { rho: config.model.rho, maxGoals: config.model.maxGoals });
    const quality = qualityFor(m, dh, dg);
    return {
      lh: pred.lh,
      la: pred.la,
      matrix,
      quality,
      ...describeMatrix(matrix),
      cross: {
        championnat1: leagueName(dh.leagueKey),
        championnat2: leagueName(dg.leagueKey),
        etalonne: quality.measured,
        // Un club connu seulement par les coupes d'Europe : aucun championnat suivi ne situe son niveau.
        sansChampionnat1: dh.leagueKey === OTHER_KEY,
        sansChampionnat2: dg.leagueKey === OTHER_KEY,
        ecartDeForce: round(pred.delta, 2),
        incertitude: round(pred.sd, 2),
        coupesChargees: m.cups.length,
      },
    };
  }

  // Matchs joués par l'un ou l'autre des deux clubs (leur championnat et les coupes), du plus ancien au plus récent :
  // sert aux statistiques affichées (forme, confrontations directes).
  function relevantFinished(home, away) {
    const m = model();
    if (!m) return [];
    const ids = new Set([home.id, away.id]);
    const out = new Map();
    for (const t of [home, away]) {
      const ld = t.rated ? m.domestic.get(t.leagueKey) : null;
      if (!ld) continue;
      for (const x of ld.finished) if (ids.has(x.home.id) || ids.has(x.away.id)) out.set(x.id, x);
    }
    for (const x of m.cupFinished) if (ids.has(x.home.id) || ids.has(x.away.id)) out.set(x.id, x);
    return [...out.values()].sort((a, b) => a.kickoff - b.kickoff);
  }

  // Match à venir d'une coupe entre ces deux clubs (le premier dans l'ordre du calendrier), ou null.
  function findFixture(homeId, awayId) {
    const m = model();
    if (!m) return null;
    const hit = m.cupFixtures.filter((f) => f.home.id === homeId && f.away.id === awayId).sort((a, b) => a.kickoff - b.kickoff)[0];
    return hit || null;
  }

  // Matchs de coupe programmés dans la fenêtre donnée (les deux clubs sont connus).
  function upcomingCupFixtures(fromMs, untilMs) {
    const m = model();
    if (!m) return [];
    return m.cupFixtures.filter((f) => f.kickoff > fromMs && f.kickoff <= untilMs).sort((a, b) => a.kickoff - b.kickoff);
  }

  function teamRecord(id) {
    const m = model();
    return m ? m.byId.get(m.alias.get(id) || id) || null : null;
  }

  function status() {
    if (!enabled) return { actif: false };
    const m = model();
    const unrated = m.teams.filter((t) => !t.rated).length;
    const rows = m.fit.leagues
      .filter((l) => l && (l.weight > 0 || m.domestic.has(l.key) || l.key === OTHER_KEY))
      .map((l) => ({
        key: l.key,
        nom: leagueName(l.key),
        niveauAPriori: round(l.prior, 2),
        niveauEstime: round(l.value, 2),
        matchsDeCoupe: round(l.weight, 1),
        mesure: l.calibrated,
      }))
      .sort((a, b) => b.niveauEstime - a.niveauEstime);
    return {
      actif: true,
      coupesChargees: m.cups.map((c) => c.league.key),
      matchsDeCoupeUtilises: m.fit.nMatches,
      clubsSansChampionnatSuivi: unrated,
      butsParEquipeExterieur: round(m.fit.mu, 2),
      avantageDomicile: round(m.fit.home, 2),
      niveauxDesChampionnats: rows,
      calculeLe: new Date(m.builtAt).toISOString(),
    };
  }

  return { enabled, model, core, relevantFinished, findFixture, upcomingCupFixtures, teamRecord, leagueName, status };
}

module.exports = { createEurope };
