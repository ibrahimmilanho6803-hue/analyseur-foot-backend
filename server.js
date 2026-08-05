const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const ANTHROPIC_API_KEY = "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";

// Test avec le bon modèle
(async () => {
  try {
    console.log("🔍 Test avec claude-sonnet-5...");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 50,
        messages: [{ role: "user", content: "Réponds juste OK" }],
      }),
    });

    if (response.ok) {
      const data = await response.json();
      console.log("✅ Clé API valide !");
    } else {
      const error = await response.text();
      console.log("❌ Erreur:", response.status, error.substring(0, 200));
    }
  } catch (e) {
    console.log("❌ Erreur:", e.message);
  }
})();

app.post("/api/analyze", async (req, res) => {
  try {
    console.log("📨 Requête reçue...");
    
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Erreur:", response.status);
      return res.status(response.status).json({ error: `Erreur ${response.status}` });
    }

    const data = await response.json();
    console.log("✅ Succès");
    res.json(data);
    
  } catch (error) {
    console.error("❌ Erreur:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3001, () => {
  console.log("🚀 Serveur sur http://localhost:3001");
});