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

// Chercher une équipe
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

// Forme récente
async function getTeamForm(teamId) {
  const cacheKey = `form_${teamId}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) return cache[cacheKey].data;

  const res = await fetch(`https://api.football-data.org/v4/teams/${teamId}/matches?limit=10&status=FINISHED`, {
    headers: { "X-Auth-Token": FOOTBALL_API_KEY },
  });
  const data = await res.json();
  cache[cacheKey] = { data, timestamp: Date.now() };
  return data;
}

// Classement
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
              position: team.position, team: team.team, playedGames: team.playedGames,
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

// Récupérer les matchs du jour pour un championnat
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

// Analyser un match avec Claude
async function analyzeMatch(matchInfo) {
  const prompt = `Tu es un analyste de football expert. Analyse ce match avec les statistiques reelles fournies.

MATCH : ${matchInfo.homeTeam} (DOMICILE) vs ${matchInfo.awayTeam} (EXTERIEUR)
Championnat : ${matchInfo.competition || "Inconnu"}
Date : ${matchInfo.date || "Non precisee"}

STATISTIQUES ${matchInfo.homeTeam} :
${matchInfo.statsHome ? `
- Classement : ${matchInfo.statsHome.position || "?"}e (${matchInfo.statsHome.points || 0} pts)
- Bilan : ${matchInfo.statsHome.won || 0}V ${matchInfo.statsHome.draw || 0}N ${matchInfo.statsHome.lost || 0}D
- Buts : ${matchInfo.statsHome.goalsFor || 0} marques / ${matchInfo.statsHome.goalsAgainst || 0} encaisses
- Forme : ${matchInfo.statsHome.form || "N/A"}
` : 'Aucune statistique trouvee'}

STATISTIQUES ${matchInfo.awayTeam} :
${matchInfo.statsAway ? `
- Classement : ${matchInfo.statsAway.position || "?"}e (${matchInfo.statsAway.points || 0} pts)
- Bilan : ${matchInfo.statsAway.won || 0}V ${matchInfo.statsAway.draw || 0}N ${matchInfo.statsAway.lost || 0}D
- Buts : ${matchInfo.statsAway.goalsFor || 0} marques / ${matchInfo.statsAway.goalsAgainst || 0} encaisses
- Forme : ${matchInfo.statsAway.form || "N/A"}
` : 'Aucune statistique trouvee'}

Donne UNIQUEMENT un JSON :
{
  "meilleurPari": "un parmi: Victoire domicile, Victoire exterieur, Match nul, Plus de 2.5 buts, Moins de 2.5 buts, Les deux equipes marquent",
  "probabilite": 00,
  "justification": "analyse courte basee sur les stats",
  "niveauConfiance": "eleve/moyen/faible"
}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const text = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

// ENDPOINT : Top matchs du jour
app.get("/api/top-matches", async (req, res) => {
  try {
    console.log("Recherche des matchs du jour...");
    let allMatches = [];

    for (const league of LEAGUES) {
      const matches = await getTodayMatches(league.code);
      const matchList = matches.slice(0, 5).map((m) => ({
        id: m.id,
        homeTeam: m.homeTeam?.name || "Inconnu",
        awayTeam: m.awayTeam?.name || "Inconnu",
        homeTeamId: m.homeTeam?.id,
        awayTeamId: m.awayTeam?.id,
        date: m.utcDate,
        competition: league.name,
      }));
      allMatches = [...allMatches, ...matchList];
    }

    console.log(`${allMatches.length} matchs trouves`);

    // Analyser chaque match
    const analyses = [];
    for (const match of allMatches.slice(0, 15)) {
      try {
        let statsHome = null, statsAway = null;

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

        const analysis = await analyzeMatch({ ...match, statsHome, statsAway });
        analyses.push({ ...match, ...analysis, statsHome, statsAway });
      } catch (e) {
        console.log(`Erreur analyse ${match.homeTeam} vs ${match.awayTeam}: ${e.message}`);
      }
    }

    // Trier par probabilité et niveau de confiance
    const sorted = analyses
      .filter((a) => a.probabilite >= 60 && a.niveauConfiance !== "faible")
      .sort((a, b) => b.probabilite - a.probabilite)
      .slice(0, 3);

    console.log(`Top 3 matchs selectionnes`);
    res.json({ topMatches: sorted, totalAnalyse: analyses.length });
  } catch (error) {
    console.error("Erreur:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint analyse simple
app.post("/api/analyze", async (req, res) => {
  try {
    const { equipe1, equipe2, typePari } = req.body;

    let statsHome = null, statsAway = null;

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
    }

    const prompt = `Tu es un analyste de football expert.

MATCH : ${equipe1} (DOMICILE) vs ${equipe2} (EXTERIEUR)
PARI A EVALUER : "${typePari}"

${statsHome ? `STATS ${equipe1} : ${statsHome.position || "?"}e, ${statsHome.won}V/${statsHome.draw}N/${statsHome.lost}D, Buts: ${statsHome.goalsFor}/${statsHome.goalsAgainst}, Forme: ${statsHome.form}` : `Aucune stat pour ${equipe1}`}
${statsAway ? `STATS ${equipe2} : ${statsAway.position || "?"}e, ${statsAway.won}V/${statsAway.draw}N/${statsAway.lost}D, Buts: ${statsAway.goalsFor}/${statsAway.goalsAgainst}, Forme: ${statsAway.form}` : `Aucune stat pour ${equipe2}`}

Estime la probabilite (0-100) que ce pari se realise. Base-toi sur les stats.
JSON: {"probabilite": 00, "justification": "courte"}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
    });

    const data = await response.json();
    const text = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
    const result = JSON.parse(text);

    res.json({ ...result, statsEquipe1: statsHome, statsEquipe2: statsAway });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint simple (generation auto)
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