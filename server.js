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
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
    matchInfo.h2h.matches.forEach((m) => {
      h2hText += m.homeTeam + " " + m.score + " " + m.awayTeam + ", ";
    });
    h2hText += "Bilan: " + matchInfo.h2h.bilan.homeWins + "V dom - " + matchInfo.h2h.bilan.draws + "N - " + matchInfo.h2h.bilan.awayWins + "V ext.";
  }

  let homeText = matchInfo.statsHome 
    ? "STATS " + matchInfo.homeTeam + ": " + (matchInfo.statsHome.position || "?") + "e, " + matchInfo.statsHome.won + "V/" + matchInfo.statsHome.draw + "N/" + matchInfo.statsHome.lost + "D, Buts: " + matchInfo.statsHome.goalsFor + "/" + matchInfo.statsHome.goalsAgainst + ", Forme: " + matchInfo.statsHome.form
    : "Pas de stats pour " + matchInfo.homeTeam;

  let awayText = matchInfo.statsAway
    ? "STATS " + matchInfo.awayTeam + ": " + (matchInfo.statsAway.position || "?") + "e, " + matchInfo.statsAway.won + "V/" + matchInfo.statsAway.draw + "N/" + matchInfo.statsAway.lost + "D, Buts: " + matchInfo.statsAway.goalsFor + "/" + matchInfo.statsAway.goalsAgainst + ", Forme: " + matchInfo.statsAway.form
    : "Pas de stats pour " + matchInfo.awayTeam;

  const prompt = "Analyse ce match. " + homeText + ". " + awayText + ". " + h2hText + " Match: " + matchInfo.homeTeam + " (domicile) vs " + matchInfo.awayTeam + " (exterieur). Choisis le meilleur pari parmi: Victoire domicile, Victoire exterieur, Match nul, Victoire ou nul domicile, Victoire ou nul exterieur, Plus de 2.5 buts, Moins de 2.5 buts, Total buts 1.5 plus, Equipe domicile 0.5 buts plus, Equipe exterieur 0.5 buts plus, Victoire/nul domicile + 0.5 buts plus, Victoire/nul exterieur + 0.5 buts plus, Victoire/nul domicile + 1.5 buts plus, Victoire/nul exterieur + 1.5 buts plus, Les deux equipes marquent. JSON: {\"meilleurPari\":\"...\",\"probabilite\":00,\"justification\":\"...\",\"niveauConfiance\":\"eleve/moyen/faible\"}";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await response.json();
  const text = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

app.get("/api/top-matches", async (req, res) => {
  try {
    console.log("Recherche des matchs du jour...");
    let allMatches = [];
    for (const league of LEAGUES) {
      const matches = await getTodayMatches(league.code);
      const matchList = matches.slice(0, 5).map((m) => ({
        id: m.id, homeTeam: m.homeTeam?.name || "Inconnu", awayTeam: m.awayTeam?.name || "Inconnu",
        homeTeamId: m.homeTeam?.id, awayTeamId: m.awayTeam?.id, date: m.utcDate, competition: league.name,
      }));
      allMatches = [...allMatches, ...matchList];
    }
    console.log(allMatches.length + " matchs trouves");
    const analyses = [];
    for (const match of allMatches.slice(0, 15)) {
      try {
        let statsHome = null, statsAway = null, h2h = null;
        if (match.homeTeamId) {
          const standing = await getTeamStanding(match.homeTeamId);
          const form = await getTeamForm(match.homeTeamId);
          const lastResults = form?.matches?.slice(0, 5).map((m2) =>
            m2.homeTeam?.id === match.homeTeamId
              ? (m2.score?.winner === "HOME_TEAM" ? "V" : m2.score?.winner === "AWAY_TEAM" ? "D" : "N")
              : (m2.score?.winner === "AWAY_TEAM" ? "V" : m2.score?.winner === "HOME_TEAM" ? "D" : "N")
          ).join("") || "N/A";
          statsHome = { ...standing, form: lastResults };
        }
        if (match.awayTeamId) {
          const standing = await getTeamStanding(match.awayTeamId);
          const form = await getTeamForm(match.awayTeamId);
          const lastResults = form?.matches?.slice(0, 5).map((m2) =>
            m2.homeTeam?.id === match.awayTeamId
              ? (m2.score?.winner === "HOME_TEAM" ? "V" : m2.score?.winner === "AWAY_TEAM" ? "D" : "N")
              : (m2.score?.winner === "AWAY_TEAM" ? "V" : m2.score?.winner === "HOME_TEAM" ? "D" : "N")
          ).join("") || "N/A";
          statsAway = { ...standing, form: lastResults };
        }
        if (match.homeTeamId && match.awayTeamId) {
          h2h = await getH2H(match.homeTeamId, match.awayTeamId);
        }
        const analysis = await analyzeMatch({ ...match, statsHome, statsAway, h2h });
        analyses.push({ ...match, ...analysis, statsHome, statsAway, h2h });
      } catch (e) {
        console.log("Erreur analyse " + match.homeTeam + " vs " + match.awayTeam + ": " + e.message);
      }
    }
    const sorted = analyses.filter((a) => a.probabilite >= 60 && a.niveauConfiance !== "faible").sort((a, b) => b.probabilite - a.probabilite).slice(0, 3);
    res.json({ topMatches: sorted, totalAnalyse: analyses.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { equipe1, equipe2, typePari } = req.body;
    let statsHome = null, statsAway = null, h2h = null, homeAway1 = null, homeAway2 = null;
    const [teams1, teams2] = await Promise.all([searchTeam(equipe1), searchTeam(equipe2)]);

    if (teams1.length > 0) {
      const standing = await getTeamStanding(teams1[0].id);
      const form = await getTeamForm(teams1[0].id);
      const lastResults = form?.matches?.slice(0, 5).map((m) =>
        m.homeTeam?.id === teams1[0].id
          ? (m.score?.winner === "HOME_TEAM" ? "V" : m.score?.winner === "AWAY_TEAM" ? "D" : "N")
          : (m.score?.winner === "AWAY_TEAM" ? "V" : m.score?.winner === "HOME_TEAM" ? "D" : "N")
      ).join("") || "N/A";
      statsHome = { ...standing, form: lastResults };
      homeAway1 = await getHomeAwayStats(teams1[0].id);
    }
    if (teams2.length > 0) {
      const standing = await getTeamStanding(teams2[0].id);
      const form = await getTeamForm(teams2[0].id);
      const lastResults = form?.matches?.slice(0, 5).map((m) =>
        m.homeTeam?.id === teams2[0].id
          ? (m.score?.winner === "HOME_TEAM" ? "V" : m.score?.winner === "AWAY_TEAM" ? "D" : "N")
          : (m.score?.winner === "AWAY_TEAM" ? "V" : m.score?.winner === "HOME_TEAM" ? "D" : "N")
      ).join("") || "N/A";
      statsAway = { ...standing, form: lastResults };
      homeAway2 = await getHomeAwayStats(teams2[0].id);
    }
    if (teams1.length > 0 && teams2.length > 0) {
      h2h = await getH2H(teams1[0].id, teams2[0].id);
    }

    let h2hText = "";
    if (h2h && h2h.matches && h2h.matches.length > 0) {
      h2hText = "H2H: ";
      h2h.matches.forEach((m) => { h2hText += m.homeTeam + " " + m.score + " " + m.awayTeam + ", "; });
      h2hText += "Bilan: " + h2h.bilan.homeWins + "V dom - " + h2h.bilan.draws + "N - " + h2h.bilan.awayWins + "V ext.";
    }

    let ha1Text = "", ha2Text = "";
    if (homeAway1) {
      ha1Text = equipe1 + " A DOMICILE: " + homeAway1.home.won + "V/" + homeAway1.home.draw + "N/" + homeAway1.home.lost + "D, Buts: " + homeAway1.home.goalsFor + "/" + homeAway1.home.goalsAgainst + ". ";
    }
    if (homeAway2) {
      ha2Text = equipe2 + " A L'EXTERIEUR: " + homeAway2.away.won + "V/" + homeAway2.away.draw + "N/" + homeAway2.away.lost + "D, Buts: " + homeAway2.away.goalsFor + "/" + homeAway2.away.goalsAgainst + ". ";
    }

    let homeText = statsHome 
      ? "STATS " + equipe1 + ": " + (statsHome.position || "?") + "e, " + statsHome.won + "V/" + statsHome.draw + "N/" + statsHome.lost + "D, Buts: " + statsHome.goalsFor + "/" + statsHome.goalsAgainst + ", Forme: " + statsHome.form
      : "Pas de stats pour " + equipe1;

    let awayText = statsAway
      ? "STATS " + equipe2 + ": " + (statsAway.position || "?") + "e, " + statsAway.won + "V/" + statsAway.draw + "N/" + statsAway.lost + "D, Buts: " + statsAway.goalsFor + "/" + statsAway.goalsAgainst + ", Forme: " + statsAway.form
      : "Pas de stats pour " + equipe2;

    const prompt = "Analyse ce match. " + homeText + ". " + awayText + ". " + ha1Text + ha2Text + h2hText + " Match: " + equipe1 + " (DOMICILE) vs " + equipe2 + " (EXTERIEUR). Pari: " + typePari + ". Donne probabilite (0-100). JSON: {\"probabilite\": 00, \"justification\": \"courte\"}";

    console.log("Prompt:", prompt.substring(0, 250));

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
    });

    const data = await response.json();
    const text = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
    console.log("Texte:", text);
    
    const result = JSON.parse(text);
    res.json({ ...result, statsEquipe1: statsHome, statsEquipe2: statsAway, h2h, homeAway1, homeAway2, equipesTrouvees1: teams1.length > 0, equipesTrouvees2: teams2.length > 0 });
  } catch (error) {
    console.error("Erreur:", error.message);
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