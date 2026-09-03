# Lumo API — API REST anonyme pour Lumo (Proton)

Pont HTTP entre votre code et le chat **Lumo** (https://lumo.proton.me/guest),
le chatbot IA de Proton — **sans compte, sans clé API, sans navigateur**.

Réalisé par rétro-ingénierie de l'application web le 2026-09-02 (mêmes méthodes
que `raphael-api` et `ezmaker-api`).

---

## Deux modes d'exécution

### A. Serveur local autonome (recommandé — sessions persistantes, stream SSE)
```bash
npm start                 # → http://localhost:3000
npm test                  # tests de bout en bout
```

### A-bis. Déploiement Docker / Render
Le repo contient un `Dockerfile` (Node 22, zéro dépendance) et un
`render.yaml` (blueprint optionnel). Render exécute `server.js` en service
web long-running — **sessions persistantes + rotation de quota + stream SSE
comme en local** (contrairement au mode serverless Vercel, sans état).

```bash
# test local de l'image
docker build -t lumo-api .
docker run -p 3000:3000 lumo-api
# → http://localhost:3000/api/chat?prompt=bonjour&uid=1
```

Sur Render :
1. `New +` → **Web Service** → connecter le repo GitHub `l_umoprotonme`
   (ou `New +` → **Blueprint** : `render.yaml` est détecté automatiquement),
2. Runtime : **Docker** (le Dockerfile est trouvé à la racine),
3. Render injecte `PORT` tout seul ; la santé est vérifiée sur `/health`.

### B. Déploiement Vercel (serverless)
Le dossier contient des fonctions serverless (`api/`) prêtes pour Vercel :
```bash
npx vercel               # à la racine du projet (ou import du repo GitHub)
```
Routes déployées : `/api/chat`, `/api/limits`, `/api/health` (`/` redirige
vers health). Chaque invocation ouvre une session Lumo anonyme neuve (quota
complet 20/20/20) — aucun état partagé entre requêtes, donc pas de compteur
par `uid` (contrairement au mode local). Budget borné à 60 s (`vercel.json`,
`maxDuration`) : les très longues réponses peuvent renvoyer un délai dépassé.

> ⚠️ Plan Hobby : le dépôt GitHub doit être **public** pour que Vercel accepte
> le déploiement (déjà constaté sur un autre projet BrunoRakotomalala62).

Test local des fonctions serverless :
```bash
npm run test:vercel       # validation + 1 vrai chat (SKIP_CHAT=1 pour valider seulement)
```

---

## Routes (mode local)


### 💬 Chat texte
```
GET /api/chat?prompt=bonjour comment ça va ?&uid=123
```
(encodage URL : `prompt=bonjour%20comment%20%C3%A7a%20va%20%3F`)

### 🖼️ Chat vision (décrire une photo)
```
GET /api/chat?prompt=décrivez cette photo&image_url=https://exemple.com/photo.jpg&uid=123
```
`image_url` accepte une URL `http(s)` **ou** une URL `data:image/...;base64,....`

> ⚠️ **Vision = backend aléatoire chez Lumo.** Le modèle multimodal est attribué
> au hasard par requête : une partie des réponses « ne voit pas » l'image
> (backend texte seul). Le proxy ajoute une **consigne système** qui force le
> modèle aveugle à répondre `NO_IMAGE` (au lieu d'inventer un contenu), détecte
> ces réponses et **réessaie automatiquement** (jusqu'à 5 tentatives,
> dispositions alternées). Il expose `vision: {attempts, perceived}` et un
> `warning` quand l'image n'a pas été perçue. Coût constaté : ~1 message de
> quota par requête réussie.

### 📊 Quota restant d'un uid
```
GET /api/limits?uid=123
```

### 🩺 Divers
```
GET /health        → état du pool de sessions
GET /              → page d'aide HTML
```

### Paramètres de `/api/chat`

| Paramètre   | Défaut      | Description |
|-------------|-------------|-------------|
| `prompt`    | —           | Texte du message (requis sauf si `image_url` seul) |
| `uid`       | `default`   | Identifiant de « session » : chaque uid dispose de son propre quota de 20 messages. Changez d'uid (ou laissez la rotation automatique) pour dépasser le quota. |
| `image_url` | —           | Image à analyser (≤ 10 Mo par défaut, variable d'env `MAX_IMAGE_BYTES`) |
| `model`     | `lumo-max`  | `lumo-max` (puissant) ou `lumo` (léger/rapide, quota "lite") |
| `reasoning` | `fast`      | `fast` ou `think` (mode raisonnement, champ `reasoning` dans la réponse) |
| `stream`    | —           | `stream=1` → réponse en SSE (`type: chunk / reasoning / done / error`) |

### Exemple de réponse (JSON)

```json
{
  "ok": true,
  "reply": "Bonjour ! Ça va très bien, merci — et vous ?",
  "model": "lumo-max",
  "uid": "123",
  "limits": { "lite": 20, "max": 19, "images": 20 },
  "rotations": 0
}
```

Erreurs : `400` paramètres invalides · `413` image trop grosse · `429` quota
Lumo épuisé (retentative automatique avec une session neuve) · `502` amont.

---

## Limitation de requêtes (constat vérifié le 2026-09-02)

| Constat | Détail |
|---|---|
| Endpoint | `POST https://lumo.proton.me/api/ai/v1/chat/completions` (SSE, format OpenAI) |
| Quota guest | **20 messages par catégorie et par session anonyme** — catégories `lite` (model `lumo`), `max` (model `lumo-max`), `images` |
| Clé du quota | Le **cookie `Session-Id`** posé à la 1ʳᵉ réponse. Pas de lien avec l'adresse IP (vérifié : deux sessions distinctes depuis la même IP ont chacune 20). |
| Indication du reste | Chaque réponse SSE contient `usage.remaining_limits` + `usage.applied_limit_category` ; endpoint `GET /api/ai/v1/limits` → `{"limits":{lite,max,images}}` |
| Reset | Nouvelle session (cookie neuf) = quota neuf. Fenêtre de reset journalière non confirmée. |

### « Requêtes illimitées »

Le proxy applique la **rotation automatique de session** : quand le quota d'un
uid tombe à 0 pour la catégorie utilisée (ou en cas de `429`), la session est
jetée et remplacée par une session anonyme neuve (quota 20). Résultat : un uid
peut enchaîner autant de requêtes que nécessaire ; le champ `rotations`
compte les sessions consommées par cet uid.

Tests réels effectués le 2026-09-02 depuis une IP datacenter :
- **21 requêtes en rafale** (une toutes les ~2 s) : 10 OK puis `429` → rotation
  automatique → 10 OK puis `429` → rotation → OK. Aucune erreur exposée.
- **12 requêtes espacées de ~8 s** sur une seule session : 12/12 OK (aucune
  rotation nécessaire).
- Conclusion : au-delà de ~10 requêtes/minute la session est temporairement
  limitée (`429`) — la rotation transparente du proxy lève la contrainte ;
  espacez de quelques secondes si vous voulez préserver les sessions.

> ⚠️ Limite honnête : Proton peut appliquer des garde-fous *non documentés*
> (anti-abus par IP). À ~60 requêtes cumulées en test rapide, aucun blocage IP
> observé — mais pour un usage massif, répartissez sur plusieurs uid et gardez
> un délai raisonnable.

---

## Comment ça marche (résumé du reverse)

1. L'app guest crée une session anonyme Proton (cookie `Session-Id`).
2. Le vrai produit chiffre chaque message en AES-256-GCM avec une clé jetable
   wrappée en OpenPGP vers la clé publique *« Proton Lumo (Prod Key 0002) »*,
   envoyée dans `lumo.request_key` (E2EE, confidential computing).
3. **Découverte clé** : l'endpoint accepte aussi les messages **non marqués
   `encrypted`** → le contenu part en clair (TLS) et les chunks de réponse
   arrivent en clair. C'est ce mode « plaintext » qu'utilise ce proxy : plus
   simple, fiable, et la vision fonctionne (testé : description d'images).
4. Payload minimal : `{model, messages:[{role:"user",content}], stream:true,
   stream_options:{include_usage:true}, reasoning_effort:"none"|"high",
   lumo:{client_type:"frontend"}}`. Pour la vision : `content` = tableau de
   parts `{type:"text"|"image_url"}` avec l'image en `data:<mime>;base64,...`.

### Fiabilité constatée de la vision (2026-09-02)
À 19h00–19h10 la vision en clair (texte+image) fonctionnait parfaitement ;
à 19h35+ le backend assigné aux sessions anonymes est devenu majoritairement
non-multimodal (réponses « je ne vois pas l'image »), avec ~1 requête sur 3
qui voit réellement. La détection + retries du proxy (jusqu'à 5 essais) est la
parade ; le champ `vision.perceived` dit la vérité sur la tentative finale.
Le mode chiffré E2E (exact comme l'app) présente le même aléa.

## Architecture du code

```
lib/lumo.js    client cœur : LumoSession (cookie + quota), SessionPool
               (rotation par uid), fetchImage (URL→base64), parseur SSE,
               retries vision (réponses "aveugles")
server.js      serveur local zéro-dépendance : /api/chat, /api/limits, /health,
               page d’aide sur /, stream SSE optionnel
api/*.js       fonctions serverless Vercel (mode sans état par requête)
vercel.json    config Vercel : maxDuration 60 s, rewrite / → health
test.js        tests de bout en bout du serveur local
test-vercel.mjs  harnais de test des fonctions serverless
package.json   `npm start`, `npm test`, `npm run test:vercel`
```


```
lib/lumo.js    client cœur : LumoSession (cookie + quota), SessionPool
               (rotation par uid), fetchImage (URL→base64), parseur SSE
server.js      serveur HTTP zéro-dépendance : /api/chat, /api/limits, /health
test.js        suite de tests bout-en-bout (lance server.js d'abord)
package.json   `npm start`, `npm test`
```

## Fichiers du projet
- `server.js` — serveur HTTP local (routes complètes, stream SSE)
- `Dockerfile` — image Docker (Node 22) pour Render / tout hôte Docker
- `render.yaml` — blueprint Render optionnel (service web `lumo-api`)
- `api/` — fonctions serverless Vercel (`chat.js`, `limits.js`, `health.js`)
- `vercel.json` — config Vercel (`maxDuration` 60 s, rewrite `/` → health)
- `lib/lumo.js` — client cœur (voir plus haut)
- `tools/lumo-pubkey.bin|.asc` — clé publique PGP « Proton Lumo (Prod Key 0002) »
  (nécessaire uniquement pour reproduire le mode E2E chiffré du site)
- `tools/test-e2e.mjs`, `tools/test-vision.mjs` — preuves E2E du mode chiffré
  (texte et vision ; `cd tools && npm i openpgp@6` pour les relancer)
