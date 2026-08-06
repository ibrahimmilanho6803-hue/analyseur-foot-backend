const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;

// Cache pour les données (évite de rappeler l'API trop souvent)
const cache = {};
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Récupérer les compétitions disponibles
async function getCompetitions() {
  const cacheKey = "competitions";
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) {
    return cache[cacheKey].data;
  }

  const res = await fetch("https://api.football-data.org/v4/competitions", {
    headers: { "X-Auth-Token": FOOTBALL_API_KEY },
  });
  const data = await res.json();
  cache[cacheKey] = { data, timestamp: Date.now() };
  return data;
}

// Chercher une équipe par son nom
async function searchTeam(teamName) {
  const cacheKey = `team_${teamName.toLowerCase()}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) {
    return cache[cacheKey].data;
  }

  // Chercher dans les grands championnats
  const leagues = ["PL", "PD", "SA", "BL1", "FL1"]; // Premier League, Liga, Serie A, Bundesliga, Ligue 1
  let teams = [];

  for (const league of leagues) {
    try {
      const res = await fetch(`https://api.football-data.org/v4/competitions/${league}/teams`, {
        headers: { "X-Auth-Token": FOOTBALL_API_KEY },
      });
      if (res.ok) {
        const data = await res.json();
        const found = data.teams?.filter((t) =>
          t.name.toLowerCase().includes(teamName.toLowerCase())
        );
        teams = [...teams, ...(found || [])];
      }
    } catch (e) {
      // skip
    }
  }

  cache[cacheKey] = { data: teams, timestamp: Date.now() };
  return teams;
}

// Récupérer les derniers matchs d'une équipe
async function getTeamForm(teamId) {
  const cacheKey = `form_${teamId}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) {
    return cache[cacheKey].data;
  }

  const res = await fetch(
    `https://api.football-data.org/v4/teams/${teamId}/matches?limit=10&status=FINISHED`,
    { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
  );
  const data = await res.json();
  cache[cacheKey] = { data, timestamp: Date.now() };
  return data;
}

// Récupérer le classement d'une équipe
async function getTeamStanding(teamId) {
  const cacheKey = `standing_${teamId}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) {
    return cache[cacheKey].data;
  }

  // Chercher dans les ligues
  const leagues = ["PL", "PD", "SA", "BL1", "FL1"];
  for (const league of leagues) {
    try {
      const res = await fetch(
        `https://api.football-data.org/v4/competitions/${league}/standings`,
        { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
      );
      if (res.ok) {
        const data = await res.json();
        for (const standing of data.standings || []) {
          const team = standing.table?.find((t) => t.team.id === teamId);
          if (team) {
            const result = {
              position: team.position,
              team: team.team,
              playedGames: team.playedGames,
              won: team.won,
              draw: team.draw,
              lost: team.lost,
              points: team.points,
              goalsFor: team.goalsFor,
              goalsAgainst: team.goalsAgainst,
              goalDifference: team.goalDifference,
              competition: data.competition?.name,
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

// Analyser les données et faire le pronostic avec Claude
async function analyzeWithStats(matchData) {
  const prompt = `Tu es un analyste de football professionnel. Voici les statistiques reelles et recentes des equipes. Base-toi UNIQUEMENT sur ces donnees pour faire ton analyse. N'invente rien.

MATCH A ANALYSER : ${matchData.equipe1} vs ${matchData.equipe2}
Type de pari demande : ${matchData.typePari}

${matchData.statsEquipe1 ? `STATISTIQUES ${matchData.equipe1} :
- Classement : ${matchData.statsEquipe1.position || "N/A"}e (${matchData.statsEquipe1.points || 0} pts)
- Matchs joues : ${matchData.statsEquipe1.playedGames || "N/A"}
- Victoires/Nuls/Defaites : ${matchData.statsEquipe1.won || 0}/${matchData.statsEquipe1.draw || 0}/${matchData.statsEquipe1.lost || 0}
- Buts marques/encaisses : ${matchData.statsEquipe1.goalsFor || 0}/${matchData.statsEquipe1.goalsAgainst || 0}
- Difference de buts : ${matchData.statsEquipe1.goalDifference || 0}
- Forme recente : ${matchData.statsEquipe1.form || "N/A"}
- Competition : ${matchData.statsEquipe1.competition || "N/A"}` : `Aucune statistique trouvee pour ${matchData.equipe1}`}

${matchData.statsEquipe2 ? `STATISTIQUES ${matchData.equipe2} :
- Classement : ${matchData.statsEquipe2.position || "N/A"}e (${matchData.statsEquipe2.points || 0} pts)
- Matchs joues : ${matchData.statsEquipe2.playedGames || "N/A"}
- Victoires/Nuls/Defaites : ${matchData.statsEquipe2.won || 0}/${matchData.statsEquipe2.draw || 0}/${matchData.statsEquipe2.lost || 0}
- Buts marques/encaisses : ${matchData.statsEquipe2.goalsFor || 0}/${matchData.statsEquipe2.goalsAgainst || 0}
- Difference de buts : ${matchData.statsEquipe2.goalDifference || 0}
- Forme recente : ${matchData.statsEquipe2.form || "N/A"}
- Competition : ${matchData.statsEquipe2.competition || "N/A"}` : `Aucune statistique trouvee pour ${matchData.equipe2}`}

Donne :
1. Une estimation de probabilite (0-100) que le pari "${matchData.typePari}" se realise
2. Une justification courte basee sur les statistiques ci-dessus

Reponds UNIQUEMENT en JSON :
{"probabilite": 00, "justification": "phrase courte basee sur les stats"}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const text = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

// Endpoint principal : analyse avec stats réelles
app.post("/api/analyze", async (req, res) => {
  try {
    const { equipe1, equipe2, typePari } = req.body;

    console.log(`Analyse : ${equipe1} vs ${equipe2} - ${typePari}`);

    // Chercher les équipes
    const [teams1, teams2] = await Promise.all([
      searchTeam(equipe1),
      searchTeam(equipe2),
    ]);

    let statsEquipe1 = null;
    let statsEquipe2 = null;

    if (teams1.length > 0) {
      const standing = await getTeamStanding(teams1[0].id);
      const form = await getTeamForm(teams1[0].id);
      const lastResults = form?.matches?.slice(0, 5).map((m) =>
        m.homeTeam.id === teams1[0].id
          ? (m.score?.winner === "HOME_TEAM" ? "V" : m.score?.winner === "AWAY_TEAM" ? "D" : "N")
          : (m.score?.winner === "AWAY_TEAM" ? "V" : m.score?.winner === "HOME_TEAM" ? "D" : "N")
      ).join("") || "N/A";

      statsEquipe1 = { ...standing, form: lastResults };
    }

    if (teams2.length > 0) {
      const standing = await getTeamStanding(teams2[0].id);
      const form = await getTeamForm(teams2[0].id);
      const lastResults = form?.matches?.slice(0, 5).map((m) =>
        m.homeTeam.id === teams2[0].id
          ? (m.score?.winner === "HOME_TEAM" ? "V" : m.score?.winner === "AWAY_TEAM" ? "D" : "N")
          : (m.score?.winner === "AWAY_TEAM" ? "V" : m.score?.winner === "HOME_TEAM" ? "D" : "N")
      ).join("") || "N/A";

      statsEquipe2 = { ...standing, form: lastResults };
    }

    // Analyser avec Claude
    const result = await analyzeWithStats({
      equipe1,
      equipe2,
      typePari,
      statsEquipe1,
      statsEquipe2,
    });

    console.log(`Resultat : ${result.probabilite}% - ${result.justification}`);
    res.json({
      ...result,
      statsEquipe1,
      statsEquipe2,
      equipesTrouvees1: teams1.length > 0,
      equipesTrouvees2: teams2.length > 0,
    });

  } catch (error) {
    console.error("Erreur:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint simple (sans stats, pour la generation auto)
app.post("/api/analyze-simple", async (req, res) => {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
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