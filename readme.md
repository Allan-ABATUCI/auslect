# TTS Reader

> Extension Firefox (desktop + Android) qui lit à voix haute le contenu d'un article web, avec lecture en arrière-plan et contrôles sur l'écran verrouillé.

TTS Reader extrait le texte propre de la page en cours (sans les menus, pubs ni navigation), le synthétise en audio et le joue comme le ferait une application de podcast : le son continue quand l'écran est éteint ou que le navigateur passe en arrière-plan, et les boutons play / pause s'affichent sur l'écran de verrouillage.

Le moteur de synthèse est **interchangeable** : le projet démarre avec la synthèse intégrée du navigateur (rapide à mettre en place), puis bascule vers un modèle neuronal léger exécuté entièrement sur l'appareil, sans aucun serveur.

---

## Sommaire

- [Pourquoi ce projet](#pourquoi-ce-projet)
- [Fonctionnalités](#fonctionnalités)
- [Architecture](#architecture)
- [Design patterns](#design-patterns)
- [Stack technique](#stack-technique)
- [Prérequis](#prérequis)
- [Installation](#installation)
- [Utilisation en développement](#utilisation-en-développement)
- [Structure du projet](#structure-du-projet)
- [Détails techniques et pièges](#détails-techniques-et-pièges)
- [Feuille de route](#feuille-de-route)
- [Limitations connues](#limitations-connues)
- [Compatibilité navigateur](#compatibilité-navigateur)
- [Licence et crédits](#licence-et-crédits)

---

## Pourquoi ce projet

Lire de longs articles au téléphone n'est pas toujours pratique : en marchant, en cuisinant, ou pour reposer les yeux. Les solutions existantes imposent souvent une application dédiée, un compte, ou du contenu à copier-coller manuellement.

L'objectif de TTS Reader est de rester **dans le flux de lecture** : on est sur un article dans le navigateur, on appuie sur un bouton, et l'article est lu à voix haute — écran éteint si besoin.

### Pourquoi une extension plutôt qu'une application Android native

Une application native capable de lire n'importe quel texte à l'écran devrait passer par un `AccessibilityService`, dont la publication est quasiment interdite hors des vraies applications d'accessibilité, et qui ne renvoie qu'un texte « aplati » mélangé aux éléments d'interface.

Une extension de navigateur, elle, s'exécute _dans le contexte de la page_ : elle a un accès direct au DOM, donc à une extraction de texte propre. Le compromis assumé est que la lecture ne fonctionne **que dans le navigateur** (pas dans les autres applications), ce qui couvre l'essentiel du besoin ici.

---

## Fonctionnalités

- **Extraction de contenu propre** — isole le corps de l'article via le moteur du mode Lecture de Firefox.
- **Lecture en arrière-plan** — le son ne s'interrompt pas quand l'écran s'éteint ou que Firefox passe en tâche de fond.
- **Contrôles sur l'écran de verrouillage** — play / pause / titre de l'article via la Media Session API, comme une application audio.
- **Pause / reprise fiables** — gestion par segments plutôt que par le `pause()` natif (notoirement instable sur mobile).
- **Moteur de synthèse remplaçable** — synthèse intégrée du navigateur ou modèle neuronal local, sans changer le reste du code.
- **100 % local** (à terme) — aucune donnée ni URL envoyée à un serveur externe.

---

## Architecture

Le traitement est un pipeline vertical : le texte entre en haut, l'audio sort en bas. Chaque étage est indépendant du suivant, et un seul étage — le moteur — change quand on fait évoluer la synthèse.

```
┌──────────────────────────────────────────┐
│  Content script  (dans la page)          │
│  Readability → texte propre de l'article │
└───────────────────┬──────────────────────┘
                    │  { titre, texte, html }
                    ▼
┌──────────────────────────────────────────┐
│  Service TTS  (Facade)                   │
│  Une API unique : load / speak / pause   │
└───────────────────┬──────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│  Fabrique de moteur  (Factory)           │
│  Instancie le moteur demandé             │
└───────────────────┬──────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│  Moteur ONNX  (Strategy + Adapter)       │
│  Piper (VITS) / Web Speech (secours)     │
│  texte → Blob audio                      │
└───────────────────┬──────────────────────┘
                    │  segments audio
                    ▼
┌──────────────────────────────────────────┐
│  Lecteur audio  (State machine)          │
│  idle → generating → playing → paused    │
└───────────────────┬──────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│  <audio> + Media Session API             │
│  Lecture en arrière-plan + lockscreen    │
└──────────────────────────────────────────┘
```

### Flux de données

1. L'utilisateur appuie sur le bouton de l'extension sur une page d'article.
2. Le **content script** clone le DOM, le passe à Readability, et renvoie le contenu nettoyé.
3. Le contenu est **segmenté** en blocs (paragraphes, titres) puis en phrases.
4. Le **Service TTS** demande au moteur courant de synthétiser les segments en audio.
5. Le **lecteur** assemble les segments en un fichier audio unique, le donne à un élément `<audio>` et publie l'état à la Media Session.
6. Les événements de lecture (début de segment, progression, fin) remontent à l'interface pour le surlignage et les boutons.

---

## Design patterns

Les patterns ne sont pas décoratifs : chacun répond à une contrainte concrète du projet.

| Pattern       | Où                             | Pourquoi                                                                                                                                                  |
| ------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Strategy**  | `TTSEngine` + moteurs concrets | Rendre le moteur de synthèse interchangeable sans toucher au reste. C'est ce qui permet de commencer avec un modèle puis de le remplacer par un meilleur. |
| **Adapter**   | Chaque moteur concret          | `onnxruntime-web` et `speechSynthesis` ont des API incompatibles — l'un rend du PCM, l'autre parle tout seul ; chaque moteur les adapte à l'interface commune.  |
| **Factory**   | `TTSEngineFactory`             | Instancier le bon moteur selon ce qui est possible ici et maintenant : langue supportée ? modèle chargeable ? sinon repli sur la voix du navigateur.       |
| **Facade**    | `TTSService`                   | Cacher toute la complexité (choix du moteur, chargement du modèle, découpage, cache) derrière quelques méthodes simples.                                  |
| **State**     | `AudioPlayer`                  | Rendre chaque action légale ou impossible selon l'état courant, au lieu d'empiler des conditions ingérables. Règle les bugs de pause / reprise.           |
| **Observer**  | Messagerie de l'extension      | Le lecteur émet des événements auxquels s'abonnent l'interface et la Media Session. Câblage fourni nativement par le `runtime messaging`.                 |
| **Singleton** | `TTSService` (onglet lecteur)  | Le modèle ONNX (~63 Mo) ne doit être chargé qu'une fois, et la session de synthèse survivre d'un article au suivant.                                       |

Principe directeur : **seul l'étage « Moteur » change** quand la synthèse évolue. Extraction, segmentation, machine à états, lecture et Media Session sont agnostiques du modèle.

---

## Stack technique

| Domaine               | Choix                                                                 |
| --------------------- | --------------------------------------------------------------------- |
| Langage               | JavaScript (ES modules), HTML, CSS                                    |
| Plateforme            | Extension WebExtension, Manifest V3                                   |
| Extraction de contenu | [`@mozilla/readability`](https://github.com/mozilla/readability)      |
| Synthèse (v1)         | Web Speech API (`speechSynthesis`), intégrée au navigateur            |
| Synthèse (v2)         | Piper (VITS) en ONNX via `onnxruntime-web`, phonèmes par `phonemizer`  |
| Lecture arrière-plan  | Élément `<audio>` + Media Session API                                 |
| Bundler               | esbuild                                                               |
| Outil de dev          | [`web-ext`](https://github.com/mozilla/web-ext) (officiel Mozilla)    |

Aucun backend, aucun framework front. Le poids et la complexité vivent dans le modèle de synthèse, pas dans l'infrastructure.

---

## Prérequis

- **Node.js** 18 ou plus récent
- **Firefox** (desktop) pour le développement
- **Firefox pour Android** + un téléphone en débogage USB pour la validation mobile (optionnel, étape finale)

> Chrome pour Android ne prend pas en charge les extensions — voir [Compatibilité navigateur](#compatibilité-navigateur).

---

## Installation

```bash
# Cloner puis installer les dépendances
git clone <url-du-repo> tts-reader
cd tts-reader
npm install

# Construire le bundle
npm run build

# Lancer Firefox desktop avec l'extension chargée et rechargée à chaud
npm run dev
```

Exemple de scripts `package.json` :

```json
{
  "scripts": {
    "build": "node build.js",
    "dev": "web-ext run --source-dir ./dist",
    "dev:android": "web-ext run --source-dir ./dist --target=firefox-android"
  }
}
```

---

## Utilisation en développement

Le cycle de développement se fait **sur Firefox desktop**, pas sur le téléphone : DevTools complets, rechargement à chaud, itération rapide.

1. `npm run dev` ouvre un Firefox de test avec l'extension chargée.
2. Aller sur un article, ouvrir le popup de l'extension, appuyer sur « Lire ».
3. Modifier le code : `web-ext` recharge automatiquement.

Le déploiement sur **Firefox Android** n'intervient qu'une fois la logique validée sur desktop :

```bash
# Téléphone branché, débogage USB activé, Firefox pour Android installé
npm run dev:android
```

---

## Tests

```bash
npm test    # suite unitaire, sans navigateur ni réseau
```

La suite couvre les trois endroits où une erreur est difficile à diagnostiquer à l'oreille :

| Fichier                  | Ce qui est vérifié                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `wav.test.js`            | Entête PCM octet par octet, round-trip d'un signal connu, écrêtage des valeurs hors bornes.       |
| `segmenter.test.js`      | Ordre des blocs, découpage en phrases, titres marqués, blocs vides ignorés.                      |
| `audio-player.test.js`   | Machine à états : aucun segment sauté ni rejoué après pause/reprise, dans les deux modes de rendu. Lecture par lots : le son sort avant la fin de la génération, le fichier s'allonge sans perdre la position, une lecture qui rattrape la génération attend au lieu de terminer l'article. |

Chaque test de la lecture par lots a été validé en y injectant le bug qu'il prétend attraper — retour au « tout générer puis jouer », position non restaurée après l'échange de source, fin de fichier traitée comme fin d'article, garde-fou de republication retiré. Un test qui ne tombe pas sous le bug qu'il vise ne teste rien.

### Diagnostic audio

Trois outils de mesure, à lancer hors navigateur :

```bash
node tests/piper-bench.js [voix]   # RTF + un WAV écoutable dans diagnostic/
node tests/piper-profile.js        # part de la phonémisation vs l'inférence
node tests/batch-sim.js [rtf...]   # ordonnancement de la lecture par lots
```

`piper-bench` affiche un verdict basé sur le taux de passages par zéro (une voix tourne autour de 0,02–0,20 ; un bruit blanc approche 0,5) : de quoi trancher entre modèle, backend d'inférence et encodage sans avoir à écouter.

`batch-sim` ne sollicite aucun moteur : il rejoue la chronologie d'un chapitre de 369 segments sur horloge virtuelle, pour un RTF donné, et compte les republications du fichier. C'est lui qui a révélé le coût quadratique d'une republication par segment quand la synthèse ne suit pas (voir plus bas).

## Structure du projet

```
auslect/
├── manifest.json              # Déclaration de l'extension (permissions, CSP)
├── package.json
├── build.js                   # Script de build esbuild
├── src/
│   ├── content/
│   │   └── content-script.js  # Extraction Readability (tourne dans la page)
│   ├── background/
│   │   └── background.js       # Coordination : extraction → onglet lecteur
│   ├── player-page/
│   │   ├── player.html         # Onglet lecteur : c'est lui qui produit le son
│   │   ├── player.js           # Héberge le Service TTS
│   │   └── player.css
│   ├── popup/
│   │   ├── popup.html          # Télécommande : lance et pilote le lecteur
│   │   ├── popup.js
│   │   └── popup.css
│   ├── tts/
│   │   ├── TTSEngine.js         # Interface commune (Strategy)
│   │   ├── TTSEngineFactory.js  # Sélection du moteur (Factory)
│   │   ├── TTSService.js        # Point d'entrée unique (Facade + Singleton)
│   │   ├── engines/
│   │   │   ├── WebSpeechEngine.js  # mode SPEAK
│   │   │   └── PiperEngine.js      # mode SYNTHESIZE (pilote le worker)
│   │   └── workers/
│   │       └── piper-worker.js     # Inférence ONNX isolée du thread principal
│   ├── player/
│   │   ├── AudioPlayer.js       # Machine à états + enchaînement audio
│   │   └── mediaSession.js      # Contrôles système / écran verrouillé
│   └── lib/
│       ├── segmenter.js         # Découpage blocs → phrases
│       └── wav.js               # Assemblage des segments PCM en un WAV unique
└── dist/                        # Sortie de build (chargée par web-ext)
    └── ort/                     # Runtime ONNX embarqué (voir « CSP » plus bas)
```

---

## Détails techniques et pièges

### Readability est destructif

`@mozilla/readability` **modifie** le document qu'on lui passe pendant l'analyse. Lui donner le `document` réel casse la page sous les yeux de l'utilisateur. Il faut donc toujours travailler sur un clone :

```js
import { Readability, isProbablyReaderable } from "@mozilla/readability";

function extractArticle() {
  if (!isProbablyReaderable(document)) return null; // page qui ressemble à un article ?
  const clone = document.cloneNode(true); // clone obligatoire
  const article = new Readability(clone).parse();
  if (!article) return null;
  return {
    title: article.title,
    text: article.textContent, // texte brut
    html: article.content, // HTML nettoyé (garde les frontières de paragraphes)
    lang: document.documentElement.lang || article.lang,
  };
}
```

Préférer `article.content` (HTML nettoyé) à `article.textContent` (texte aplati) : conserver les blocs `<p>` et `<h*>` permet d'insérer des pauses naturelles entre paragraphes et donne les points d'ancrage pour le surlignage.

### La Web Speech API ne fonctionne pas en arrière-plan

`speechSynthesis` n'est pas une session média au sens du système : elle ne s'enregistre pas comme « de l'audio en cours de lecture », ne survit pas au verrouillage de l'écran, et ne peut pas être capturée dans un fichier. Elle est parfaite pour un premier prototype (v1), mais **incompatible avec la lecture en arrière-plan**.

### La lecture en arrière-plan exige un vrai fichier audio

Pour que le système respecte la lecture (écran éteint, contrôles sur le lockscreen), il faut un **élément `<audio>` qui joue un Blob audio réel**, couplé à la **Media Session API**. C'est ce qui fait fonctionner les lecteurs de podcast web — et ce que la Web Speech API ne peut pas offrir.

### WebGPU n'est pas encore actif sur Firefox Android

Au moment d'écrire ces lignes (septembre 2026), WebGPU est disponible sur Firefox desktop (Windows, macOS) mais **pas encore sur Firefox Android** : le support est en développement, visé par Mozilla pour fin 2026. L'inférence du modèle tourne donc en **WebAssembly (CPU)**, ce qui est plus lent.

Conséquence sur l'architecture : la génération est lente, et Firefox throttle les minuteurs des onglets inactifs (1 s sur desktop, **15 min sur Android**). D'où la lecture par lots, voir plus bas.

**WebGPU est désactivé volontairement, même là où il est disponible.** Firefox desktop expose `navigator.gpu` depuis la version 141, mais le backend WebGPU d'ONNX Runtime y produit une sortie incohérente : un grésillement continu au lieu de la voix. Le banc (`node tests/piper-bench.js`) a montré que le modèle et l'encodage WAV étaient corrects, ce qui isole le backend comme seul responsable. Un audio qui grésille en continu vient de là, pas du modèle.

Le build ne copie donc que la variante **sans JSEP** du runtime : embarquer le support WebGPU coûterait 7 Mo pour du code jamais exécuté. Le jour où ce backend sera fiable sur Gecko, ce sont `build.js` et le worker qui changent — le moteur reste derrière la même interface `synthesize()`.

### Le runtime ONNX doit être embarqué dans l'extension

Par défaut, `onnxruntime-web` va chercher ses binaires WebAssembly sur un CDN. La CSP d'une extension MV3 (`script-src 'self'`) l'interdit : le chargement échoue silencieusement. Les fichiers `ort-wasm-simd-threaded.{mjs,wasm}` sont donc copiés dans `dist/ort/` au build, et le worker repointe `wasmPaths` dessus :

```js
ort.env.wasm.wasmPaths = wasmPath; // browser.runtime.getURL("ort/")
ort.env.wasm.numThreads = 1; // pas de SharedArrayBuffer sans COOP/COEP
```

Le manifest doit aussi autoriser `wasm-unsafe-eval` dans sa CSP, sans quoi rien ne s'instancie.

Le manifest doit par ailleurs autoriser explicitement l'exécution WebAssembly :

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
}
```

Conséquence : le dossier `dist/` pèse une vingtaine de mégaoctets même sans le modèle, qui est lui téléchargé à la demande depuis Hugging Face (CORS ouvert, donc aucune `host_permission` nécessaire) puis mis en cache par le navigateur.

### Le son est produit par un onglet, pas par la page de fond

C'est le choix d'architecture qui conditionne toute la lecture en arrière-plan. En Manifest V3, le script de fond est une **event page** : Firefox la suspend après une trentaine de secondes d'inactivité, et throttle les contextes inactifs (1 s sur desktop, **15 min sur Android**, avec déchargement possible). Y héberger l'audio revient à parier sur un maintien en vie artificiel — un minuteur qui appelle une API toutes les 20 secondes, ce que rien ne garantit.

Un onglet qui joue du son, lui, échappe à ce traitement : Firefox le considère comme n'importe quel lecteur web. Le lecteur est donc une véritable page d'extension ouverte dans un onglet — comportement vérifié sur Firefox Android 158, notification média comprise.

Répartition des rôles :

| Contexte | Rôle |
| --- | --- |
| `content-script.js` | Extraction Readability, dans la page de l'article |
| `background.js` | Coordination seule : extraire, puis acheminer vers le lecteur |
| `player.html` | Héberge le Service TTS, l'élément `<audio>` et la session média |
| `popup.html` | Télécommande ; l'état vit dans le lecteur |

L'onglet lecteur est ouvert **actif** : l'ouverture suit un geste de l'utilisateur, ce qui évite le blocage de la lecture automatique, et cet écran devient la surface de contrôle — ce qu'on veut sur téléphone, où le popup est étroit. Les préférences passent par `storage`, que le lecteur observe, plutôt que par des relais de messages.

### La lecture par lots : un fichier qui grandit, pas des lots enchaînés

Attendre la génération complète coûtait **6 minutes de silence** avant le premier mot sur un chapitre de 28 minutes. La génération et la lecture se recouvrent désormais : dès 45 secondes d'audio en réserve, `<audio>` démarre ; le reste est synthétisé pendant l'écoute.

La solution évidente — découper l'article en lots indépendants et enchaîner sur `ended` — est précisément celle qu'il ne faut pas prendre ici. Sur Android le JS est gelé écran éteint : chaque frontière de lot exigerait un réveil du code, au pire moment. À la place, **chaque publication réécrit un seul fichier contenant tout ce qui est généré**, et la position de lecture est restaurée à la seconde près. Le moteur générant environ 4,5× plus vite que le temps réel, les publications se concentrent au début, et la dernière contient l'article entier : passé ce point, plus aucun code n'a besoin d'être réveillé.

Mesuré par `node tests/batch-sim.js`, sur le profil du chapitre réel (369 segments, 27 min d'audio) :

| RTF | Attente avant le son | Publications | Autonome à partir de | Écoute sans JS |
| --- | --- | --- | --- | --- |
| 0,05 (natif) | 2 s | 3 | 1:21 | 25:48 |
| **0,22 (WASM, émulateur)** | **10 s** | **4** | **5:58** | **21:19** |
| 1,20 (appareil trop lent) | 53 s | 15 | — | — |

Une publication réécrit **tout** le fichier, pas seulement la nouveauté. La première version republiait dès qu'un segment était disponible : à RTF 1,2 la simulation a compté **331 publications**, soit un coût quadratique sur l'appareil qui peinait déjà. Une publication n'a donc lieu que si la nouveauté atteint `max(30 s, 25 % de l'existant)` — croissance géométrique, nombre de publications borné quel que soit le RTF : 331 → 15.

Quand la synthèse ne suit pas la lecture (**RTF > 1**), le son s'arrête en fin de fichier au lieu de terminer l'article : le lecteur se reconstitue une réserve avant de repartir, comme un lecteur vidéo. Ces coupures sont comptées (`underruns`) et affichées, plutôt que de laisser des blancs inexpliqués.

Les échanges de fichier sont déclenchés par `timeupdate`, **avant** que la tête de lecture n'atteigne la fin, et non sur `ended` : l'élément `<audio>` ne s'arrête jamais, donc la notification média Android ne perd pas sa session.

### C'est le phonémiseur, pas le modèle, qui limite à l'anglais

Piper propose des voix françaises, mais la chaîne s'arrête avant : `phonemizer`, embarqué ici, ne contient que les données eSpeak anglaises. `PiperEngine.supportedLanguages` vaut donc `["en"]`, et sur un article non anglophone le service bascule sur la voix du navigateur en l'expliquant dans le popup — plutôt que de faire lire du français par un phonémiseur anglais.

Le français demanderait `piper_phonemize` (`.data` de 18,1 Mo + `.wasm` de 0,6 Mo). Son `locateFile` étant configurable, il s'embarque comme l'a été le runtime ONNX.

### Le PCM est concaténé en un seul fichier

Chaque segment synthétisé donne un `Float32Array`, immédiatement quantifié en PCM 16 bits et conservé sous cette forme : le fichier étant réécrit à chaque publication, garder du Float32 doublerait la mémoire et requantifierait à chaque passage les minutes déjà produites. Tous les morceaux sont assemblés en **un seul WAV**. Un fichier unique (plutôt qu'un blob par segment) donne à `<audio>` une vraie timeline : durée totale, seek, et donc une Media Session complète sur l'écran verrouillé. Les bornes temporelles de chaque segment sont conservées pour suivre la progression et sauter d'un paragraphe à l'autre.

### `browser_specific_settings.gecko.id` est obligatoire

Sans un identifiant d'extension explicite dans le manifest, le test sur Firefox Android échoue. Source classique de blocage.

---

## Feuille de route

- [x] **v0 — Extraction** : bouton qui extrait l'article et l'affiche dans la console (valide Readability).
- [x] **v1 — Chaîne complète** : lecture via Web Speech API pour entendre un résultat de bout en bout.
- [x] **v2 — Moteur neuronal local** : Piper (VITS, ONNX) derrière l'interface `synthesize()`, exécuté dans un worker.
- [x] **v2.1 — Arrière-plan** : `<audio>` + Media Session, pré-génération, contrôles lockscreen.
- [x] **v2.2 — Lecture par lots** : le son sort après ~10 s au lieu de ~6 min, sans sacrifier l'autonomie de la session média.
- [ ] **v3 — Français** : `piper_phonemize` embarqué (le `phonemizer` actuel n'a que les données eSpeak anglaises).
- [ ] **v3 — Optimisation** : quantification du modèle (int8 / fp16), test de modèles mono-voix plus légers.
- [ ] **Confort** : réglage de la vitesse, choix de la voix, surlignage du passage lu, file de lecture.
- [ ] **Accélération** : bascule automatique sur WebGPU dès qu'il est disponible sur Firefox Android.

> Ordre volontaire : obtenir un résultat qui _parle_ (même avec une voix médiocre) avant d'attaquer le modèle neuronal — pour garder la motivation et disposer d'un point de comparaison.

---

## Limitations connues

- Fonctionne **uniquement dans le navigateur** (pas dans les autres applications du téléphone).
- La voix neuronale **ne lit que l'anglais** (voir plus haut) ; le français passe par la voix du navigateur.
- Sur Firefox Android, la synthèse neuronale a une **latence de génération** au démarrage (~10 s pour constituer la réserve initiale) tant que WebGPU n'est pas disponible.
- Pendant la génération de fond, la durée affichée est celle du fichier déjà produit, pas celle de l'article : l'interface la marque d'un `+` tant qu'elle n'est pas définitive.
- Le modèle neuronal représente un **téléchargement conséquent** (~63 Mo pour `en_US-lessac-medium`), mis en cache après le premier usage.
- La **lecture en arrière-plan n'est possible qu'avec le moteur neuronal** : `speechSynthesis` ne produit pas de fichier audio, donc pas de session média.
- La qualité d'extraction dépend de la structure de la page : les articles bien balisés fonctionnent mieux que les mises en page atypiques.

---

## Compatibilité navigateur

| Navigateur                     | Extensions | Remarque                                                                |
| ------------------------------ | ---------- | ----------------------------------------------------------------------- |
| **Firefox pour Android**       | ✅         | Cible principale du projet.                                             |
| Firefox desktop                | ✅         | Environnement de développement.                                         |
| Chrome pour Android            | ❌         | N'a jamais pris en charge les extensions, par choix de Google.          |
| Kiwi Browser                   | ⚠️         | Arrêté en 2025 ; son moteur d'extensions a été repris dans Edge Canary. |
| Edge Canary / Yandex (Android) | ⚠️         | Support partiel / expérimental.                                         |

La cible assumée est **Firefox pour Android**.

---

## Licence et crédits

- **Licence** : MIT (à confirmer).
- [`@mozilla/readability`](https://github.com/mozilla/readability) — extraction de contenu (moteur du mode Lecture de Firefox).
- [Piper](https://github.com/rhasspy/piper) — modèles de synthèse vocale VITS ; les voix sont servies par [`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices).
- [`onnxruntime-web`](https://github.com/microsoft/onnxruntime) — exécution de modèles ONNX dans le navigateur.
- [`phonemizer`](https://github.com/xenova/phonemizer.js) — eSpeak compilé en WebAssembly, pour les phonèmes IPA.
- [`web-ext`](https://github.com/mozilla/web-ext) — outillage de développement d'extensions Mozilla.

---

_Projet personnel — développeur : Aln._
