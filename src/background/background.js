// Coordination : extraire l'article de l'onglet actif et l'acheminer vers
// l'onglet lecteur.
//
// L'audio ne vit délibérément pas ici. Une page de fond MV3 est une event page,
// suspendue après une trentaine de secondes d'inactivité, et Firefox throttle
// lourdement les contextes inactifs sur Android (15 minutes). Un onglet qui joue
// du son échappe à tout cela, comme n'importe quel lecteur web.
const PLAYER_PAGE = "player.html";

let playerTabId = null;
let pendingArticle = null;

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function extractArticleFromTab(tabId) {
  // Injection : le content script fait l'extraction et pose le résultat sur window.
  await browser.scripting.executeScript({
    target: { tabId },
    files: ["content-script.js"],
  });
  // Second appel : on relit la valeur, avec un vrai retour de fonction (fiable).
  const [{ result }] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => window.__auslectArticle,
  });
  return result;
}

function reportError(message) {
  browser.runtime.sendMessage({ type: "PLAYER_EVENT", event: { type: "error", message } }).catch(() => {});
}

async function ensurePlayerTab() {
  if (playerTabId !== null) {
    try {
      await browser.tabs.get(playerTabId);
      await browser.tabs.update(playerTabId, { active: true });
      return;
    } catch {
      playerTabId = null; // onglet fermé entre-temps
    }
  }

  // Onglet actif : l'ouverture suit un geste de l'utilisateur, ce qui évite le
  // blocage de la lecture automatique, et le lecteur devient l'écran courant —
  // c'est la surface de contrôle attendue sur téléphone.
  const tab = await browser.tabs.create({ url: browser.runtime.getURL(PLAYER_PAGE), active: true });
  playerTabId = tab.id;
}

async function handlePlayRequest() {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  if (tab.id === playerTabId) {
    reportError("Ouvrez un article dans un onglet, puis relancez la lecture.");
    return;
  }

  let article;
  try {
    article = await extractArticleFromTab(tab.id);
  } catch {
    article = null;
  }

  if (!article) {
    reportError("Article introuvable sur cette page.");
    return;
  }

  pendingArticle = article;
  await ensurePlayerTab();

  // Un lecteur déjà ouvert vient chercher l'article ; celui qui vient d'être
  // créé le fera à son initialisation. Les deux passent par le même retrait.
  browser.runtime.sendMessage({ type: "NEW_ARTICLE" }).catch(() => {});
}

browser.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case "PLAY_REQUEST":
      handlePlayRequest();
      return;
    case "TAKE_PENDING_ARTICLE": {
      const article = pendingArticle;
      pendingArticle = null; // servi une seule fois : pas de double chargement
      return Promise.resolve(article);
    }
    default:
      return;
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (tabId === playerTabId) playerTabId = null;
});
