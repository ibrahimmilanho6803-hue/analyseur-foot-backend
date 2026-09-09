const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;

const cache = {};
const CACHE_DURATION = 30 * 60 * 1000;

const LEAGUES = [
  { code: "PL", name: "Premier League" },
  { code: "PD", name: "Liga" },
  { code: "SA", name: "Serie A" },
  { code: "BL1", name: "Bundesliga" },
  { code: "FL1", name: "Ligue 1" },
  { code: "PPL", name: "Liga Portugal" },
  { code: "DED", name: "Eredivisie" },
  { code: "BSA", name: "Brasileirao" },
  { code: "SPL", name: "Scottish Premiership" },
  { code: "BPL", name: "Jupiler Pro League" },
];

async function searchTeam(teamName) {
  const cacheKey = `team_${teamName.toLowerCase()}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) return cache[cacheKey].data;
  let teams = [];
  for (const league of LEAGUES) {
    try {
      const res = await fetch(`https://api.football-data.org/v4/competitions/${league.code}/teams`, {
        headers: { "X-Auth-Token": FOOTBALL_API_KEY },
      });
      if (res.ok) {
        const data = await res.json();
        const found = data.teams?.filter((t) => t.name.toLowerCase().includes(teamName.toLowerCase()));
        teams = [...teams, ...(found || [])];
      }
    } catch (e) {}
  }
  cache[cacheKey] = { data: teams, timestamp: Date.now() };
  return teams;
}

async function getTeamForm(teamId) {
  const cacheKey = `form_${teamId}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) return cache[cacheKey].data;
  try {
    const res = await fetch(`https://api.football-data.org/v4/teams/${teamId}/matches?limit=10&status=FINISHED`, {
      headers: { "X-Auth-Token": FOOTBALL_API_KEY },
    });
    const data = await res.json();
    cache[cacheKey] = { data, timestamp: Date.now() };
    return data;
  } catch (e) { return null; }
}

async function getTeamStanding(teamId) {
  const cacheKey = `standing_${teamId}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) return cache[cacheKey].data;
  for (const league of LEAGUES) {
    try {
      const res = await fetch(`https://api.football-data.org/v4/competitions/${league.code}/standings`, {
        headers: { "X-Auth-Token": FOOTBALL_API_KEY },
      });
      if (res.ok) {
        const data = await res.json();
        for (const standing of data.standings || []) {
          const team = standing.table?.find((t) => t.team.id === teamId);
          if (team) {
            const result = {
              position: team.position, playedGames: team.playedGames,
              won: team.won, draw: team.draw, lost: team.lost, points: team.points,
              goalsFor: team.goalsFor, goalsAgainst: team.goalsAgainst,
              goalDifference: team.goalDifference, competition: data.competition?.name,
            };
            cache[cacheKey] = { data: result, timestamp: Date.now() };
            return result;
          }
        }
      }
    } catch (e) {}
  }
  return null;
}

async function getHomeAwayStats(teamId) {
  const cacheKey = `homeaway_${teamId}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) return cache[cacheKey].data;
  try {
    const res = await fetch(`https://api.football-data.org/v4/teams/${teamId}/matches?limit=60&status=FINISHED`, {
      headers: { "X-Auth-Token": FOOTBALL_API_KEY },
    });
    if (res.ok) {
      const data = await res.json();
      const matches = data.matches || [];
      
      const homeMatches = matches.filter((m) => m.homeTeam?.id === teamId);
      let homeWins = 0, homeDraws = 0, homeLosses = 0, homeGoalsFor = 0, homeGoalsAgainst = 0;
      homeMatches.forEach((m) => {
        homeGoalsFor += m.score?.fullTime?.home || 0;
        homeGoalsAgainst += m.score?.fullTime?.away || 0;
        if (m.score?.winner === "HOME_TEAM") homeWins++;
        else if (m.score?.winner === "AWAY_TEAM") homeLosses++;
        else homeDraws++;
      });

      const awayMatches = matches.filter((m) => m.awayTeam?.id === teamId);
      let awayWins = 0, awayDraws = 0, awayLosses = 0, awayGoalsFor = 0, awayGoalsAgainst = 0;
      awayMatches.forEach((m) => {
        awayGoalsFor += m.score?.fullTime?.away || 0;
        awayGoalsAgainst += m.score?.fullTime?.home || 0;
        if (m.score?.winner === "AWAY_TEAM") awayWins++;
        else if (m.score?.winner === "HOME_TEAM") awayLosses++;
        else awayDraws++;
      });

      const result = {
        home: {
          played: homeMatches.length, won: homeWins, draw: homeDraws, lost: homeLosses,
          goalsFor: homeGoalsFor, goalsAgainst: homeGoalsAgainst,
          avgGoalsFor: homeMatches.length > 0 ? (homeGoalsFor / homeMatches.length).toFixed(1) : 0,
        },
        away: {
          played: awayMatches.length, won: awayWins, draw: awayDraws, lost: awayLosses,
          goalsFor: awayGoalsFor, goalsAgainst: awayGoalsAgainst,
          avgGoalsFor: awayMatches.length > 0 ? (awayGoalsFor / awayMatches.length).toFixed(1) : 0,
        },
      };
      cache[cacheKey] = { data: result, timestamp: Date.now() };
      return result;
    }
  } catch (e) {}
  return null;
}

async function getH2H(teamId1, teamId2) {
  const cacheKey = `h2h_${teamId1}_${teamId2}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) return cache[cacheKey].data;
  try {
    const res = await fetch(
  `https://api.football-data.org/v4/teams/${teamId1}/matches?limit=60&status=FINISHED`,
      { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
    );
    if (res.ok) {
      const data = await res.json();
      const h2hMatches = (data.matches || []).filter(
        (m) => m.homeTeam?.id === teamId2 || m.awayTeam?.id === teamId2
      ).slice(0, 5);
      
      const matches = h2hMatches.map((m) => ({
        date: m.utcDate?.slice(0, 10),
        homeTeam: m.homeTeam?.name,
        awayTeam: m.awayTeam?.name,
        score: (m.score?.fullTime?.home ?? "-") + "-" + (m.score?.fullTime?.away ?? "-"),
        winner: m.score?.winner === "HOME_TEAM" ? "HOME" : m.score?.winner === "AWAY_TEAM" ? "AWAY" : "DRAW",
      }));
      
      let homeWins = 0, awayWins = 0, draws = 0;
      matches.forEach((m) => {
        if (m.winner === "HOME") homeWins++;
        else if (m.winner === "AWAY") awayWins++;
        else draws++;
      });
      
      const result = { matches, bilan: { homeWins, awayWins, draws, total: matches.length } };
      cache[cacheKey] = { data: result, timestamp: Date.now() };
      return result;
    }
  } catch (e) { console.log("Erreur H2H:", e.message); }
  return null;
}

async function getTodayMatches(leagueCode) {
  const cacheKey = `matches_${leagueCode}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < 15 * 60 * 1000) return cache[cacheKey].data;
  const today = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    const res = await fetch(
      `https://api.football-data.org/v4/competitions/${leagueCode}/matches?dateFrom=${today}&dateTo=${nextWeek}&status=SCHEDULED`,
      { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
    );
    if (res.ok) {
      const data = await res.json();
      cache[cacheKey] = { data: data.matches || [], timestamp: Date.now() };
      return data.matches || [];
    }
  } catch (e) {}
  return [];
}

async function analyzeMatch(matchInfo) {
  let h2hText = "";
  if (matchInfo.h2h && matchInfo.h2h.matches && matchInfo.h2h.matches.length > 0) {
    h2hText = "H2H: ";
    matchInfo.h2h.matches.forEach((m) => { h2hText += m.homeTeam + " " + m.score + " " + m.awayTeam + ", "; });
    h2hText += "Bilan: " + matchInfo.h2h.bilan.homeWins + "V dom - " + matchInfo.h2h.bilan.draws + "N - " + matchInfo.h2h.bilan.awayWins + "V ext. ";
  }

  let ha1Text = "", ha2Text = "";
  if (matchInfo.homeAway1) {
    ha1Text = matchInfo.homeTeam + " A DOMICILE: " + matchInfo.homeAway1.home.won + "V/" + matchInfo.homeAway1.home.draw + "N/" + matchInfo.homeAway1.home.lost + "D, Buts: " + matchInfo.homeAway1.home.goalsFor + "/" + matchInfo.homeAway1.home.goalsAgainst + ". ";
  }
  if (matchInfo.homeAway2) {
    ha2Text = matchInfo.awayTeam + " A L'EXTERIEUR: " + matchInfo.homeAway2.away.won + "V/" + matchInfo.homeAway2.away.draw + "N/" + matchInfo.homeAway2.away.lost + "D, Buts: " + matchInfo.homeAway2.away.goalsFor + "/" + matchInfo.homeAway2.away.goalsAgainst + ". ";
  }

  const prompt = "Analyse ce match. " + ha1Text + ha2Text + h2hText + " Match: " + matchInfo.homeTeam + " (domicile) vs " + matchInfo.awayTeam + " (exterieur). Championnat: " + (matchInfo.competition || "Inconnu") + ". Choisis le meilleur pari avec une probabilite d'au moins 55%. Reponds JSON: {\"meilleurPari\":\"...\",\"probabilite\":00,\"justification\":\"...\",\"niveauConfiance\":\"eleve/moyen/faible\"}";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await response.json();
  const text = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
    // Nettoyer le JSON
  let cleanText = text;
  // Supprimer tout ce qui n'est pas entre { et }
  const match = cleanText.match(/\{.*\}/s);
  if (match) cleanText = match[0];
  // Remplacer les guillemets français par des guillemets anglais
  cleanText = cleanText.replace(/"/g, '"').replace(/"/g, '"');
  
  return JSON.parse(cleanText);
}

app.get("/api/top-matches", async (req, res) => {
  try {
    console.log("Recherche des matchs...");
    
    const selectedLeagues = [
      { code: "PL", name: "Premier League" },
      { code: "PD", name: "Liga" },
      { code: "BL1", name: "Bundesliga" },
    ];

    let allAnalyses = [];

    for (const league of selectedLeagues) {
      const matches = await getTodayMatches(league.code);
      console.log(`${league.name}: ${matches.length} matchs`);

      const analyses = [];
      for (const match of matches.slice(0, 8)) {
        try {
          let statsHome = null, statsAway = null, h2h = null, homeAway1 = null, homeAway2 = null;

          if (match.homeTeam?.id) {
            const standing = await getTeamStanding(match.homeTeam.id);
            const form = await getTeamForm(match.homeTeam.id);
            const lastResults = form?.matches?.slice(0, 5).map((m2) =>
              m2.homeTeam?.id === match.homeTeam.id
                ? (m2.score?.winner === "HOME_TEAM" ? "V" : m2.score?.winner === "AWAY_TEAM" ? "D" : "N")
                : (m2.score?.winner === "AWAY_TEAM" ? "V" : m2.score?.winner === "HOME_TEAM" ? "D" : "N")
            ).join("") || "N/A";
            statsHome = { ...standing, form: lastResults };
            homeAway1 = await getHomeAwayStats(match.homeTeam.id);
          }

          if (match.awayTeam?.id) {
            const standing = await getTeamStanding(match.awayTeam.id);
            const form = await getTeamForm(match.awayTeam.id);
            const lastResults = form?.matches?.slice(0, 5).map((m2) =>
              m2.homeTeam?.id === match.awayTeam.id
                ? (m2.score?.winner === "HOME_TEAM" ? "V" : m2.score?.winner === "AWAY_TEAM" ? "D" : "N")
                : (m2.score?.winner === "AWAY_TEAM" ? "V" : m2.score?.winner === "HOME_TEAM" ? "D" : "N")
            ).join("") || "N/A";
            statsAway = { ...standing, form: lastResults };
            homeAway2 = await getHomeAwayStats(match.awayTeam.id);
          }

          if (match.homeTeam?.id && match.awayTeam?.id) {
            h2h = await getH2H(match.homeTeam.id, match.awayTeam.id);
          }

          const analysis = await analyzeMatch({
            homeTeam: match.homeTeam?.name || "Inconnu",
            awayTeam: match.awayTeam?.name || "Inconnu",
            competition: league.name,
            statsHome,
            statsAway,
            h2h,
            homeAway1,
            homeAway2,
          });

          analyses.push({
            homeTeam: match.homeTeam?.name || "Inconnu",
            awayTeam: match.awayTeam?.name || "Inconnu",
            competition: league.name,
            date: match.utcDate,
            ...analysis,
            statsHome,
            statsAway,
            h2h,
            homeAway1,
            homeAway2,
          });
        } catch (e) {
          console.log(`Erreur: ${e.message}`);
        }
      }

      // Sélectionner avec probabilité entre 55% et 65% pour une cote de ~1.6-1.8 par match
      // 3 matchs à 1.6-1.8 = cote totale de ~2.5-4
      let best = analyses.filter((a) => a.probabilite >= 55 && a.probabilite <= 65)[0];
      
      // Si pas dans cette fourchette, prendre le plus proche de 60%
      if (!best) {
        best = analyses.sort((a, b) => Math.abs(a.probabilite - 60) - Math.abs(b.probabilite - 60))[0];
      }

      if (best) {
        best.coteImplicite = (1 / (best.probabilite / 100)).toFixed(2);
        allAnalyses.push(best);
      }
    }

    // Si moins de 3 matchs, compléter avec d'autres championnats
    if (allAnalyses.length < 3) {
      const extraLeagues = [
        { code: "SA", name: "Serie A" },
        { code: "FL1", name: "Ligue 1" },
      ];
      for (const league of extraLeagues) {
        if (allAnalyses.length >= 3) break;
        const matches = await getTodayMatches(league.code);
        for (const match of matches.slice(0, 5)) {
          if (allAnalyses.length >= 3) break;
          try {
            let statsHome = null, statsAway = null, h2h = null, homeAway1 = null, homeAway2 = null;
            if (match.homeTeam?.id) {
              const standing = await getTeamStanding(match.homeTeam.id);
              const form = await getTeamForm(match.homeTeam.id);
              const lastResults = form?.matches?.slice(0, 5).map((m2) =>
                m2.homeTeam?.id === match.homeTeam.id
                  ? (m2.score?.winner === "HOME_TEAM" ? "V" : m2.score?.winner === "AWAY_TEAM" ? "D" : "N")
                  : (m2.score?.winner === "AWAY_TEAM" ? "V" : m2.score?.winner === "HOME_TEAM" ? "D" : "N")
              ).join("") || "N/A";
              statsHome = { ...standing, form: lastResults };
              homeAway1 = await getHomeAwayStats(match.homeTeam.id);
            }
            if (match.awayTeam?.id) {
              const standing = await getTeamStanding(match.awayTeam.id);
              const form = await getTeamForm(match.awayTeam.id);
              const lastResults = form?.matches?.slice(0, 5).map((m2) =>
                m2.homeTeam?.id === match.awayTeam.id
                  ? (m2.score?.winner === "HOME_TEAM" ? "V" : m2.score?.winner === "AWAY_TEAM" ? "D" : "N")
                  : (m2.score?.winner === "AWAY_TEAM" ? "V" : m2.score?.winner === "HOME_TEAM" ? "D" : "N")
              ).join("") || "N/A";
              statsAway = { ...standing, form: lastResults };
              homeAway2 = await getHomeAwayStats(match.awayTeam.id);
            }
            if (match.homeTeam?.id && match.awayTeam?.id) {
              h2h = await getH2H(match.homeTeam.id, match.awayTeam.id);
            }
            const analysis = await analyzeMatch({
              homeTeam: match.homeTeam?.name || "Inconnu",
              awayTeam: match.awayTeam?.name || "Inconnu",
              competition: league.name,
              statsHome, statsAway, h2h, homeAway1, homeAway2,
            });
            const item = {
              homeTeam: match.homeTeam?.name || "Inconnu",
              awayTeam: match.awayTeam?.name || "Inconnu",
              competition: league.name,
              date: match.utcDate,
              ...analysis,
              statsHome, statsAway, h2h, homeAway1, homeAway2,
            };
            if (item.probabilite >= 50 && item.probabilite <= 70) {
              item.coteImplicite = (1 / (item.probabilite / 100)).toFixed(2);
              allAnalyses.push(item);
            }
          } catch (e) {}
        }
      }
    }

    // Calculer la cote totale
    let coteTotale = 1;
    allAnalyses.forEach((a) => { coteTotale *= parseFloat(a.coteImplicite || 1.7); });
    coteTotale = coteTotale.toFixed(2);

    console.log(`${allAnalyses.length} matchs - Cote totale: ${coteTotale}`);

    res.json({ topMatches: allAnalyses, coteTotale });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/analyze-simple", async (req, res) => {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3001, () => {
  console.log("Serveur demarre sur http://localhost:3001");
});