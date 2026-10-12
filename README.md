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
   Les totaux de buts sont corrigés à la source (rythme des équipes et niveau de buts, voir « Correction des totaux de buts »),
   donc tous les paris restent cohérents entre eux.
3. **IA (Claude Sonnet 5.5)** : elle reçoit les chiffres du modèle, la forme, les bilans domicile/extérieur et les
   confrontations directes. Elle rédige la justification, indique son niveau de confiance et peut corriger la
   probabilité **de 4 points au maximum** si elle connaît un facteur concret. Si l'IA est indisponible, le résultat
   du modèle est renvoyé quand même (champ `ia.statut`).
4. **Contrôle de fiabilité** : le serveur rejoue les matchs récents semaine par semaine (en n'utilisant que ce qui
   était connu à l'époque) et compare ses probabilités à la réalité et à une référence simple. Il règle lui-même
   le modèle, ajuste chaque jour le niveau de buts attendu d'après l'écart observé et abaisse les probabilités des
   paris automatiques si elles se sont révélées trop optimistes. Le détail est consultable sur `/api/backtest`.

> Les **cotes affichées** sont des cotes « équitables » (1 ÷ probabilité). Un bookmaker applique une marge :
> ses cotes réelles seront plus basses. Cette application n'a pas accès aux cotes des opérateurs.

## Routes

| Route | Rôle |
|---|---|
| `GET /health` | Sonde de santé (pour Render). |
| `GET /api/status` | État des sources de données, de l'IA, des réglages du modèle (dont la correction des totaux de buts, `modele.correctionDesButs`) et alertes éventuelles. |
| `GET /api/leagues` | Championnats suivis. |
| `GET /api/teams` | Liste des clubs des championnats chargés, avec leurs écritures courantes (« PSG », « Man City »…) : sert aux suggestions de saisie du site. `complet: false` tant qu'un championnat n'est pas chargé. Mise en cache 5 minutes par le navigateur. |
| `POST /api/analyze` | Analyse d'une sélection `{ equipe1, equipe2, typePari }` ou de plusieurs `{ legs: [...] }` (12 maximum). Avec `"ia": false` dans le corps, réponse **rapide du seul modèle statistique** (aucun appel à l'IA, quota IA intact, `ia.statut: "non_demandee"`) : le site peut l'afficher tout de suite, puis relancer la demande avec l'IA. |
| `GET /api/top-matches` | Les 3 meilleurs paris (3 matchs différents) des prochaines 72 h (jusqu'à 7 jours si besoin). |
| `POST /api/auto-coupon` | `{ matches: [{ equipe1, equipe2 }] }` : meilleur pari par match. |
| `GET /api/backtest?jours=120&championnat=PL` | Rapport de fiabilité sur les matchs récents (voir « Contrôle de fiabilité » plus bas). |
| `/api/analyze-simple` | **Supprimée** (410) : elle permettait à n'importe qui d'utiliser votre clé Anthropic. |

Si une équipe ou un type de pari n'est pas reconnu, la réponse contient `probabilite: null`, un `etat`
(`equipe_inconnue`, `ambigu`, `ligues_differentes`, `marche_inconnu`…) et un `message` : aucune probabilité n'est inventée.

### Reconnaissance des noms d'équipes

On peut taper un nom officiel, un nom court, une abréviation ou un surnom courant, avec ou sans majuscules, accents
et tirets : « PSG », « Paris Saint-Germain », « Bayern », « Man City », « Spurs », « Inter », « OM », « Barça »…
Le serveur compare la saisie aux écritures **de la source de données** (TheSportsDB écrit « Paris SG » et
« Bayern Munich », football-data.org « Paris Saint-Germain FC »), à une liste d'écritures équivalentes et, pour
TheSportsDB, aux **noms alternatifs de chaque club** (lus automatiquement, un appel par championnat, gardés 24 h).

- **Mieux vaut demander que se tromper** : « Paris » (Paris FC ou Paris SG ?), « Real », « United » ou « Manchester »
  renvoient `etat: "ambigu"` avec les clubs possibles dans `suggestions`, jamais une probabilité calculée pour le mauvais
  club. Quand le nom existe dans plusieurs championnats (« Union » : Berlin ou Saint-Gilloise), l'autre équipe de la
  sélection tranche : « Union » contre Genk désigne le club belge.
- **Ajouter un surnom** : une ligne dans `src/team-groups.js` (toutes les écritures d'un même club, une seule fois dans le fichier).
  Les majuscules, accents, « FC », « AC », « SL »… n'ont pas besoin d'y figurer.
- `test/teams-reels.test.js` vérifie la reconnaissance avec les écritures réelles de TheSportsDB (relevées en octobre 2026).

## Variables d'environnement (à saisir dans Render → Environment)

| Variable | Rôle | Par défaut |
|---|---|---|
| `ANTHROPIC_API_KEY` | Clé de l'API Anthropic. Sans elle, l'IA est désactivée (le modèle répond seul). | — |
| `FOOTBALL_DATA_API_KEY` | Clé football-data.org (gratuite). Alias accepté : `FOOTBALL_API_KEY`. | — |
| `ANTHROPIC_MODEL` | Modèle utilisé (retour arrière possible : `claude-sonnet-5`). | `claude-sonnet-5-5` |
| `AI_EFFORT` | `low`, `medium` ou `high`. | `medium` |
| `AI_ENABLED` | `false` pour couper l'IA sans toucher à la clé. | `true` |
| `AI_DAILY_BUDGET_CALLS` | Nombre maximal d'appels à l'IA par jour (protège votre facture). | `400` |
| `AI_MAX_PARALLEL` | Nombre d'appels à l'IA en même temps (de 1 à 12). Plus haut = coupon plus rapide, mais plus de risque d'atteindre la limite de débit de votre compte Anthropic. | `6` |
| `AI_MAX_ADJUST_POINTS` | Correction maximale de l'IA, en points de pourcentage. | `4` |
| `AI_TIMEOUT_MS` | Délai maximal d'un appel à l'IA. | `40000` |
| `ALLOWED_ORIGINS` | Adresses de sites autorisées, séparées par des virgules (s'ajoutent au site officiel, aux aperçus Vercel, à l'application mobile et à `localhost`). | — |
| `SPORTSDB_API_KEY` | Clé TheSportsDB. **Payante** pour être utile : la clé gratuite ne renvoie qu'une partie de la saison (15 matchs), elle est détectée et ignorée. Source de secours de football-data.org, et seule source pour l'Écosse et la Belgique. Peut aussi servir **seule** (voir « Couverture »). | — |
| `DATA_PROVIDER` | Ordre des sources, ex. `footballdata,thesportsdb`. | selon les clés présentes |
| `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_AI_PER_MIN` | Demandes par minute et par adresse IP (général / analyses). | `90` / `30` |
| `TOP_WINDOW_HOURS` / `TOP_MAX_WINDOW_HOURS` / `TOP_TARGET_ODDS` | Fenêtre du Top 3 et cote totale visée. | `72` / `168` / `2.5` |
| `MODEL_AUTOTUNE` | `false` pour désactiver le réglage automatique du modèle. | `true` |
| `MODEL_HALF_LIFE_DAYS` / `MODEL_PRIOR_MATCHES` | Réglages de départ du modèle (affinés ensuite automatiquement). | `300` / `10` |
| `MODEL_CALIBRATION` | **Interrupteur de sécurité** : `off` coupe la correction des totaux de buts (rythme des équipes et niveau de buts, voir plus bas) et redonne le modèle d'avant. À poser dans Render → Environment ; le service redémarre. | actif |
| `MODEL_RHYTHM_EXPONENT` | Intensité de la correction du rythme des équipes, de 0,2 (très forte) à 1 (aucune correction du rythme ; le niveau de buts reste ajusté chaque jour). | `0.5` |
| `SPORTSDB_MIN_INTERVAL_MS` | Écart minimal entre deux appels à TheSportsDB. **Ne le baissez pas si la même clé sert à une autre application** : les limites (30 appels/min en gratuit, 100 en Premium) sont communes à toutes les applications qui utilisent la clé. Si le service répond « trop de requêtes » (429), le serveur le laisse tranquille pendant environ une minute au lieu d'insister. | `2100` |
| `FOOTBALL_DATA_MIN_INTERVAL_MS` | Écart minimal entre deux appels à football-data.org (10 appels/min en gratuit). | `6500` |
| `PORT` | Port d'écoute (fourni par Render). | `3001` |

## Correction des totaux de buts

Le contrôle de fiabilité sur 365 jours a montré que « plus de 1.5 buts », « plus de 2.5 buts » et « les deux équipes marquent »
étaient annoncés **trop bas** (par exemple 50,9 % annoncé pour 55,3 % réalisé sur « plus de 2.5 »), alors que le 1-N-2 était
juste. Deux causes, deux corrections, appliquées **à la source** (aux buts attendus de chaque équipe) pour que tous les paris
restent cohérents entre eux :

1. **Rythme des équipes.** Chaque équipe a une *force* (attaque ÷ défense : meilleure ou moins bonne que son adversaire, ce qui
   décide du 1-N-2) et un *rythme* (attaque × défense : ses matchs comptent-ils beaucoup de buts, ce qui décide des totaux). Le
   rythme est bien plus bruité que la force : le modèle le prenait trop au sérieux (probabilités de totaux deux fois trop
   dispersées d'un match à l'autre). Il est donc rapproché de la moyenne (exposant `MODEL_RHYTHM_EXPONENT`, 0,5 par défaut :
   l'écart de rythme d'une équipe avec la moyenne est réduit de moitié, en proportion). La force n'est pas touchée : le 1-N-2 ne change pas.
2. **Niveau de buts.** Le modèle prévoyait en moyenne 2,75 buts par match pour 2,84 marqués. Au démarrage puis chaque jour, le serveur
   rejoue les 180 derniers jours **sans coefficient** et compare les buts prévus et marqués. L'écart est exprimé en marges d'erreur
   (z) et seule la fraction `1 − 1/z²` de l'écart est corrigée (aucune correction sous 1 marge d'erreur, 75 % à 2, 91 % à 3,3) :
   un écart incertain est peu corrigé, un écart net presque entièrement. Le coefficient obtenu multiplie les buts attendus de
   toutes les équipes ; il est borné à ± 8 %, il peut monter comme baisser, et faute de 600 matchs récents il reste à 1.

Où le voir : `/api/status` → `modele.correctionDesButs` (interrupteur, exposant du rythme, coefficient de niveau en service) et
`modele.reglageAutomatique.niveauDeButs` (matchs mesurés, buts prévus et réels, écart en marges d'erreur, coefficient, raison).
Après un redémarrage le coefficient repart de 1 et est recalculé dès que les championnats sont chargés (environ une minute).

**Revenir en arrière** : `MODEL_CALIBRATION=off` dans Render → Environment (le service redémarre) redonne exactement le modèle
d'avant. `MODEL_RHYTHM_EXPONENT=1` ne coupe que la correction du rythme.

**Comparer avant / après** : sans paramètre, `/api/backtest` utilise les réglages en service, correction comprise ; le modèle d'avant
s'obtient avec `/api/backtest?exposantRythme=1&echelle=1` (mêmes matchs, mêmes dates).

## Contrôle de fiabilité (`/api/backtest`)

Le serveur rejoue les matchs des derniers mois, semaine par semaine, avec ce qu'il savait à l'époque, et compare ses
probabilités à ce qui s'est réellement passé. Pour chaque type de pari, le rapport donne la probabilité moyenne
annoncée et la fréquence réelle, la note de Brier et la log-perte (comparées à une référence qui ne connaîtrait que la
fréquence moyenne du championnat) et la **pente de calibrage** (`pente` : 1 = parfait, moins de 1 = probabilités trop
tranchées). `butsParMatch` compare le total de buts annoncé et réel (avec l'écart-type des buts réels), par championnat aussi.
Les huit premiers marchés (1-N-2, double chance, plus de 1.5 / 2.5 buts, les deux équipes marquent) alimentent aussi les
tranches de calibrage ; cinq marchés de plus (plus de 3.5 buts, un ou deux buts de chaque équipe) servent à vérifier
qu'un réglage n'en abîme pas d'autres.

Le rapport est en lecture seule et sans effet sur les réponses du serveur. Sans paramètre, il utilise les réglages en service
(`reglages` dans la réponse), correction des totaux de buts comprise. Pour comparer des réglages **sur exactement les
mêmes matchs**, ajoutez des paramètres facultatifs (bornés, valeurs illisibles ignorées ; 6 appels par minute au plus,
résultat gardé 6 h, et jamais conservé au-delà d'un changement de réglage du serveur) :

| Paramètre | Rôle |
|---|---|
| `pas` | Jours entre deux ré-ajustements du modèle (3 à 28, défaut 7). |
| `demiVie`, `prior` | Demi-vie des matchs (30 à 1500 jours) et nombre de matchs fictifs ramenant vers la moyenne (0 à 60). |
| `rho` | Correction de Dixon-Coles sur les petits scores (−0,3 à 0,1). |
| `niveauDemiVie`, `niveauPrior` | Réestime le niveau de buts du championnat avec une mémoire plus courte que les forces d'équipes (0 = désactivé). |
| `exposant` | Rapproche toutes les forces des équipes de la moyenne (0,3 à 1,3 ; moins de 1 = moins tranché). |
| `exposantForce`, `exposantRythme` | Même chose, séparément (0,2 à 1,3) pour deux composantes de chaque équipe : sa **force** (attaque ÷ défense : meilleure ou moins bonne que l'adversaire, ce qui décide du 1-N-2) et son **rythme** (attaque × défense : ses matchs comptent-ils beaucoup de buts, ce qui décide des totaux et de « les deux équipes marquent »). Chacun vaut `exposant` quand il n'est pas précisé. |
| `echelle` | Coefficient appliqué au niveau de buts (0,8 à 1,3). |

La réponse reprend les réglages essayés (`essai`) et ceux du serveur (`reglages`).

## Surveillance

`scripts/controle-sante.js` contrôle l'API en production : serveur joignable, tous les championnats chargés et rafraîchis
depuis moins de 3 h, aucun avertissement dans `/api/status`, IA ni en pause ni bloquée (clé refusée, crédit épuisé, modèle
introuvable), budget quotidien d'appels non épuisé, et une vraie analyse d'essai (deux clubs, pari « Score exact » : sans
IA, donc gratuite). Le premier essai raté est suivi de deux autres, à une minute d'écart, pour ne pas donner l'alerte lors
d'un simple redémarrage.

```bash
node scripts/controle-sante.js                              # production (https://analyseur-foot-api.onrender.com)
node scripts/controle-sante.js http://localhost:3001 --sans-test
```

Code de sortie 0 = tout va bien, 1 = problème (affiché en clair). Le fichier `.github/workflows/surveillance.yml` le lance
**toutes les 6 heures** sur GitHub (onglet « Actions », aussi à la demande) : en cas de problème, l'exécution échoue et GitHub
envoie un e-mail au propriétaire du dépôt. Une sonde externe gratuite (par exemple UptimeRobot) sur `/health` reste un bon
complément pour être prévenu en quelques minutes d'une panne complète.

## Lancer en local

```bash
npm ci
cp .env.example .env     # puis renseignez les clés
npm start                # http://localhost:3001/api/status
npm test                 # 200+ tests automatiques (sans réseau)
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
championnats, un appel toutes les 2 secondes). La liste des clubs de chaque championnat (noms alternatifs) est lue
ensuite, sans retarder les matchs, et gardée 24 h. Avec une clé gratuite, aucun championnat ne se charge ; `/api/status`
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
Pour chaque championnat, `equipes` donne le nombre de clubs connus et `equipesAvecNomsAlternatifs` le nombre de clubs
dont TheSportsDB a fourni des noms alternatifs. Un `0` partout signifie seulement que cette liste n'a pas été reçue
(l'analyse fonctionne, avec les écritures de la liste `src/team-groups.js`) ; elle est redemandée au bout d'une heure.
Juste après un redémarrage, tant que les championnats se chargent, une équipe encore inconnue donne `etat: "chargement"`
(« Les données des championnats sont en cours de chargement, réessayez dans une minute. ») et non « équipe introuvable ». Si une source est en panne, le
message le dit (« Données momentanément indisponibles pour : Liga »).
Les clés n'apparaissent jamais dans les journaux ni dans les réponses.
