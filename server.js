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
  const leagues = ["PL", "PD", "SA", "BL1", "FL1", "PPL", "DED", "ELC", "CL", "BSA"];
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
  const prompt = `Tu es un analyste de football professionnel avec 20 ans d'experience. Analyse ce match en profondeur.

MATCH : ${matchData.equipe1} (domicile) vs ${matchData.equipe2} (exterieur)
PARI A EVALUER : "${matchData.typePari}"

${matchData.statsEquipe1 ? `STATISTIQUES ${matchData.equipe1} :
- Championnat : ${matchData.statsEquipe1.competition || "N/A"}
- Classement : ${matchData.statsEquipe1.position || "?"}e avec ${matchData.statsEquipe1.points || 0} points
- Bilan : ${matchData.statsEquipe1.won || 0} victoires, ${matchData.statsEquipe1.draw || 0} nuls, ${matchData.statsEquipe1.lost || 0} defaites
- Buts marques/encaisses : ${matchData.statsEquipe1.goalsFor || 0}/${matchData.statsEquipe1.goalsAgainst || 0} (diff: ${matchData.statsEquipe1.goalDifference || 0})
- Moyenne buts par match : ${matchData.statsEquipe1.playedGames ? (matchData.statsEquipe1.goalsFor / matchData.statsEquipe1.playedGames).toFixed(1) : "?"}
- Forme recente (5 derniers matchs) : ${matchData.statsEquipe1.form || "N/A"} (V=Victoire, N=Nul, D=Defaite)` : `Aucune statistique pour ${matchData.equipe1}`}

${matchData.statsEquipe2 ? `STATISTIQUES ${matchData.equipe2} :
- Championnat : ${matchData.statsEquipe2.competition || "N/A"}
- Classement : ${matchData.statsEquipe2.position || "?"}e avec ${matchData.statsEquipe2.points || 0} points
- Bilan : ${matchData.statsEquipe2.won || 0} victoires, ${matchData.statsEquipe2.draw || 0} nuls, ${matchData.statsEquipe2.lost || 0} defaites
- Buts marques/encaisses : ${matchData.statsEquipe2.goalsFor || 0}/${matchData.statsEquipe2.goalsAgainst || 0} (diff: ${matchData.statsEquipe2.goalDifference || 0})
- Moyenne buts par match : ${matchData.statsEquipe2.playedGames ? (matchData.statsEquipe2.goalsFor / matchData.statsEquipe2.playedGames).toFixed(1) : "?"}
- Forme recente (5 derniers matchs) : ${matchData.statsEquipe2.form || "N/A"} (V=Victoire, N=Nul, D=Defaite)` : `Aucune statistique pour ${matchData.equipe2}`}

ANALYSE DEMANDEE :
1. Compare la force des deux equipes (classement, forme, attaque, defense)
2. Avantage domicile pour ${matchData.equipe1}
3. Probabilite que le pari "${matchData.typePari}" se realise (0-100)
4. Explique ton raisonnement en te basant UNIQUEMENT sur les stats fournies

IMPORTANT : Sois honnete. Si les stats sont insuffisantes, dis-le et donne une estimation prudente (proche de 50%). N'invente jamais de donnees.

Reponds UNIQUEMENT en JSON :
{"probabilite": 00, "justification": "analyse detaillee basee sur les stats", "confiance": "elevee/moyenne/faible"}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const text = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

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