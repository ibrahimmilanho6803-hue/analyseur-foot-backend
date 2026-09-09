const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SPORTSDB_API_KEY = process.env.SPORTSDB_API_KEY || "0531916234";

const cache = {};
const CACHE_DURATION = 30 * 60 * 1000;

// Rechercher une équipe
async function searchTeam(teamName) {
  const cacheKey = `team_${teamName.toLowerCase()}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) return cache[cacheKey].data;
  try {
    const res = await fetch(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_API_KEY}/searchteams.php?t=${encodeURIComponent(teamName)}`);
    const data = await res.json();
    const teams = data.teams || [];
    cache[cacheKey] = { data: teams, timestamp: Date.now() };
    return teams;
  } catch (e) { return []; }
}

// Récupérer les derniers matchs d'une équipe
async function getTeamForm(teamId) {
  const cacheKey = `form_${teamId}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) return cache[cacheKey].data;
  try {
    const res = await fetch(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_API_KEY}/eventslast.php?id=${teamId}`);
    const data = await res.json();
    const matches = data.results || [];
    cache[cacheKey] = { data: matches, timestamp: Date.now() };
    return matches;
  } catch (e) { return []; }
}

// Récupérer les matchs à venir d'une équipe
async function getTeamUpcoming(teamId) {
  const cacheKey = `upcoming_${teamId}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_DURATION) return cache[cacheKey].data;
  try {
    const res = await fetch(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_API_KEY}/eventsnext.php?id=${teamId}`);
    const data = await res.json();
    const matches = data.events || [];
    cache[cacheKey] = { data: matches, timestamp: Date.now() };
    return matches;
  } catch (e) { return []; }
}

// Récupérer les matchs d'un championnat
async function getLeagueMatches(leagueId) {
  const cacheKey = `league_${leagueId}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < 15 * 60 * 1000) return cache[cacheKey].data;
  try {
    const res = await fetch(`https://www.thesportsdb.com/api/v1/json/${SPORTSDB_API_KEY}/eventsseason.php?id=${leagueId}`);
    const data = await res.json();
    const matches = data.events || [];
    cache[cacheKey] = { data: matches, timestamp: Date.now() };
    return matches;
  } catch (e) { return []; }
}

// Analyser un match avec Claude
async function analyzeMatch(matchInfo) {
  let formText = "";
  if (matchInfo.formHome) {
    formText += matchInfo.homeTeam + " forme recente: " + matchInfo.formHome + ". ";
  }
  if (matchInfo.formAway) {
    formText += matchInfo.awayTeam + " forme recente: " + matchInfo.formAway + ". ";
  }

  const prompt = "Analyse ce match de football. " + formText + " Match: " + matchInfo.homeTeam + " (domicile) vs " + matchInfo.awayTeam + " (exterieur). Championnat: " + (matchInfo.competition || "Inconnu") + ". Choisis le meilleur pari avec probabilite entre 55% et 65%. Reponds JSON: {\"meilleurPari\":\"...\",\"probabilite\":00,\"justification\":\"...\",\"niveauConfiance\":\"eleve/moyen/faible\"}";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await response.json();
  const text = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
  const match = text.match(/\{.*\}/s);
  return JSON.parse(match ? match[0] : text);
}

app.get("/api/top-matches", async (req, res) => {
  try {
    console.log("Recherche des matchs via TheSportsDB...");
    
    // Championnats : Premier League (4328), Liga (4335), Bundesliga (4331)
    const leagues = [
      { id: "4328", name: "Premier League" },
      { id: "4335", name: "Liga" },
      { id: "4331", name: "Bundesliga" },
    ];

    let allAnalyses = [];

    for (const league of leagues) {
      const matches = await getLeagueMatches(league.id);
      // Filtrer les matchs futurs
      const upcoming = matches.filter((m) => new Date(m.strTimestamp || m.dateEvent) > new Date()).slice(0, 5);
      console.log(`${league.name}: ${upcoming.length} matchs a venir`);

      const analyses = [];
      for (const match of upcoming) {
        try {
          // Récupérer la forme récente
          const formHome = await getTeamForm(match.idHomeTeam);
          const formAway = await getTeamForm(match.idAwayTeam);
          
          const lastHome = formHome.slice(0, 5).map((m) => {
            const score = parseInt(m.intHomeScore) - parseInt(m.intAwayScore);
            return score > 0 ? "V" : score < 0 ? "D" : "N";
          }).join("");

          const lastAway = formAway.slice(0, 5).map((m) => {
            const score = parseInt(m.intAwayScore) - parseInt(m.intHomeScore);
            return score > 0 ? "V" : score < 0 ? "D" : "N";
          }).join("");

          const analysis = await analyzeMatch({
            homeTeam: match.strHomeTeam,
            awayTeam: match.strAwayTeam,
            competition: league.name,
            formHome: lastHome,
            formAway: lastAway,
          });

          analyses.push({
            homeTeam: match.strHomeTeam,
            awayTeam: match.strAwayTeam,
            competition: league.name,
            date: match.dateEvent,
            ...analysis,
            formHome: lastHome,
            formAway: lastAway,
          });
        } catch (e) {
          console.log(`Erreur analyse: ${e.message}`);
        }
      }

      const best = analyses
        .filter((a) => a.probabilite >= 50 && a.probabilite <= 70)
        .sort((a, b) => a.probabilite - b.probabilite)[0] 
        || analyses[0];

      if (best) {
        best.coteImplicite = (1 / (best.probabilite / 100)).toFixed(2);
        allAnalyses.push(best);
      }
    }

    let coteTotale = 1;
    allAnalyses.forEach((a) => { coteTotale *= parseFloat(a.coteImplicite || 1.7); });
    coteTotale = coteTotale.toFixed(2);

    console.log(`${allAnalyses.length} matchs - Cote totale: ${coteTotale}`);

    res.json({ topMatches: allAnalyses, coteTotale });
  } catch (error) {
    console.error("Erreur:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { equipe1, equipe2, typePari } = req.body;
    
    const teams1 = await searchTeam(equipe1);
    const teams2 = await searchTeam(equipe2);

    let form1 = "", form2 = "";
    if (teams1.length > 0) {
      const matches = await getTeamForm(teams1[0].idTeam);
      form1 = matches.slice(0, 5).map((m) => {
        const score = parseInt(m.intHomeScore) - parseInt(m.intAwayScore);
        return score > 0 ? "V" : score < 0 ? "D" : "N";
      }).join("");
    }
    if (teams2.length > 0) {
      const matches = await getTeamForm(teams2[0].idTeam);
      form2 = matches.slice(0, 5).map((m) => {
        const score = parseInt(m.intAwayScore) - parseInt(m.intHomeScore);
        return score > 0 ? "V" : score < 0 ? "D" : "N";
      }).join("");
    }

    let formText = "";
    if (form1) formText += equipe1 + " forme: " + form1 + ". ";
    if (form2) formText += equipe2 + " forme: " + form2 + ". ";

    const prompt = "Analyse ce match. " + formText + " Match: " + equipe1 + " (domicile) vs " + equipe2 + " (exterieur). Pari: " + typePari + ". Donne probabilite (0-100). JSON: {\"probabilite\": 00, \"justification\": \"courte\"}";

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
    });

    const data = await response.json();
    const text = (data.content || []).map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
    const match = text.match(/\{.*\}/s);
    const result = JSON.parse(match ? match[0] : text);

    res.json({ ...result, equipesTrouvees1: teams1.length > 0, equipesTrouvees2: teams2.length > 0 });
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