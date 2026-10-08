# Analyseur Foot Pro — API

Serveur Node.js (Express) de l'application **Analyseur Foot Pro**. Il calcule des probabilités de paris
à partir des résultats réels des championnats, puis fait relire chaque analyse par **Claude Sonnet 5.5**.

## Comment sont calculées les probabilités

1. **Données** : tous les matchs de la saison en cours et de la précédente sont récupérés (football-data.org),
   gardés en mémoire et rafraîchis automatiquement.
2. **Modèle statistique** (type Maher / Dixon-Coles) : pour chaque équipe, une force d'attaque et une force de
   défense sont estimées sur les matchs passés (un match récent compte plus qu'un match ancien ; une équipe avec
   peu de matchs, comme un promu, est ramenée vers la moyenne). On en déduit le nombre de buts attendus de chaque
   équipe, puis la probabilité de **chaque score**, et enfin celle de chaque type de pari. Toutes les probabilités
   viennent de la même matrice de scores : elles sont cohérentes entre elles (« plus de 2.5 » + « moins de 2.5 » = 100 %).
3. **IA (Claude Sonnet 5.5)** : elle reçoit les chiffres du modèle, la forme, les bilans domicile/extérieur et les
   confrontations directes. Elle rédige la justification, indique son niveau de confiance et peut corriger la
   probabilité **de 4 points au maximum** si elle connaît un facteur concret. Si l'IA est indisponible, le résultat
   du modèle est renvoyé quand même (champ `ia.statut`).
4. **Contrôle de fiabilité** : le serveur rejoue les matchs récents semaine par semaine (en n'utilisant que ce qui
   était connu à l'époque) et compare ses probabilités à la réalité et à une référence simple. Il règle lui-même
   le modèle et abaisse les probabilités des paris automatiques si elles se sont révélées trop optimistes.
   Le détail est consultable sur `/api/backtest`.

> Les **cotes affichées** sont des cotes « équitables » (1 ÷ probabilité). Un bookmaker applique une marge :
> ses cotes réelles seront plus basses. Cette application n'a pas accès aux cotes des opérateurs.

## Routes

| Route | Rôle |
|---|---|
| `GET /health` | Sonde de santé (pour Render). |
| `GET /api/status` | État des sources de données, de l'IA, des réglages du modèle et alertes éventuelles. |
| `GET /api/leagues` | Championnats suivis. |
| `POST /api/analyze` | Analyse d'une sélection `{ equipe1, equipe2, typePari }` ou de plusieurs `{ legs: [...] }` (12 maximum). |
| `GET /api/top-matches` | Les 3 meilleurs paris (3 matchs différents) des prochaines 72 h (jusqu'à 7 jours si besoin). |
| `POST /api/auto-coupon` | `{ matches: [{ equipe1, equipe2 }] }` : meilleur pari par match. |
| `GET /api/backtest?jours=120&championnat=PL` | Rapport de fiabilité sur les matchs récents. |
| `/api/analyze-simple` | **Supprimée** (410) : elle permettait à n'importe qui d'utiliser votre clé Anthropic. |

Si une équipe ou un type de pari n'est pas reconnu, la réponse contient `probabilite: null`, un `etat`
(`equipe_inconnue`, `ambigu`, `ligues_differentes`, `marche_inconnu`…) et un `message` : aucune probabilité n'est inventée.

## Variables d'environnement (à saisir dans Render → Environment)

| Variable | Rôle | Par défaut |
|---|---|---|
| `ANTHROPIC_API_KEY` | Clé de l'API Anthropic. Sans elle, l'IA est désactivée (le modèle répond seul). | — |
| `FOOTBALL_DATA_API_KEY` | Clé football-data.org (gratuite). Alias accepté : `FOOTBALL_API_KEY`. | — |
| `ANTHROPIC_MODEL` | Modèle utilisé (retour arrière possible : `claude-sonnet-5`). | `claude-sonnet-5-5` |
| `AI_EFFORT` | `low`, `medium` ou `high`. | `medium` |
| `AI_ENABLED` | `false` pour couper l'IA sans toucher à la clé. | `true` |
| `AI_DAILY_BUDGET_CALLS` | Nombre maximal d'appels à l'IA par jour (protège votre facture). | `400` |
| `AI_MAX_ADJUST_POINTS` | Correction maximale de l'IA, en points de pourcentage. | `4` |
| `AI_TIMEOUT_MS` | Délai maximal d'un appel à l'IA. | `40000` |
| `ALLOWED_ORIGINS` | Adresses de sites autorisées, séparées par des virgules (s'ajoutent au site officiel, aux aperçus Vercel, à l'application mobile et à `localhost`). | — |
| `SPORTSDB_API_KEY` | Clé TheSportsDB. **Payante** pour être utile : la clé gratuite ne renvoie qu'une partie de la saison (15 matchs), elle est détectée et ignorée. Source de secours de football-data.org, et seule source pour l'Écosse et la Belgique. Peut aussi servir **seule** (voir « Couverture »). | — |
| `DATA_PROVIDER` | Ordre des sources, ex. `footballdata,thesportsdb`. | selon les clés présentes |
| `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_AI_PER_MIN` | Demandes par minute et par adresse IP (général / analyses). | `90` / `30` |
| `TOP_WINDOW_HOURS` / `TOP_MAX_WINDOW_HOURS` / `TOP_TARGET_ODDS` | Fenêtre du Top 3 et cote totale visée. | `72` / `168` / `2.5` |
| `MODEL_AUTOTUNE` | `false` pour désactiver le réglage automatique du modèle. | `true` |
| `MODEL_HALF_LIFE_DAYS` / `MODEL_PRIOR_MATCHES` | Réglages de départ du modèle (affinés ensuite automatiquement). | `300` / `10` |
| `FOOTBALL_DATA_MIN_INTERVAL_MS` | Écart minimal entre deux appels à football-data.org (10 appels/min en gratuit). | `6500` |
| `PORT` | Port d'écoute (fourni par Render). | `3001` |

## Lancer en local

```bash
npm ci
cp .env.example .env     # puis renseignez les clés
npm start                # http://localhost:3001/api/status
npm test                 # 160+ tests automatiques (sans réseau)
npm run e2e              # démarre le vrai serveur avec de faux services et vérifie les routes
```

Au démarrage, le chargement des 8 championnats de football-data.org prend environ **deux minutes**
(limite de 10 appels par minute de l'offre gratuite). Pendant ce temps, `/api/status` indique l'avancement
et les routes répondent avec les championnats déjà prêts.

## Couverture des championnats

football-data.org (offre gratuite) : Premier League, Liga, Serie A, Bundesliga, Ligue 1, Primeira Liga,
Eredivisie, Brasileirão. L'Écosse et la Belgique ne sont pas incluses dans cette offre : elles ne sont
analysées que si une clé TheSportsDB payante est fournie (`SPORTSDB_API_KEY`).

Sans clé football-data.org, le serveur peut fonctionner avec **TheSportsDB seul** (10 championnats), à condition que
la clé soit payante : le chargement des 10 championnats prend alors environ 45 secondes au démarrage (2 saisons × 10
championnats, un appel toutes les 2 secondes). Avec une clé gratuite, aucun championnat ne se charge ; `/api/status`
l'indique (voir ci-dessous) et les analyses répondent « données indisponibles ».

## Ce que l'application ne sait pas

- Aucune information sur les blessures, suspensions, compositions ou le contexte du jour : les probabilités
  reposent sur les résultats passés. L'IA ne peut pas non plus les connaître en temps réel.
- Les sélections de plusieurs matchs sont multipliées comme si les matchs étaient indépendants.
- Un modèle statistique ne « prédit » pas : il estime des fréquences. Aucun pari n'est sûr.

## Dépannage

Ouvrez `/api/status` : il indique, championnat par championnat, son état (`etat` : `pret`, `chargement` ou `echec`),
sa source, l'âge des données et la dernière erreur (pour un championnat en échec : la raison, par exemple
« TheSportsDB : données incomplètes (15 matchs reçus : clé gratuite ?) »), ainsi que l'état de l'IA (dernier succès,
dernière erreur, appels du jour). La liste `avertissements` est **vide seulement quand tout est chargé et à jour** :
elle signale aussi les championnats encore en chargement, ceux qui ont échoué (avec la raison) et ceux dont la dernière
actualisation a échoué.
Les clés n'apparaissent jamais dans les journaux ni dans les réponses.
