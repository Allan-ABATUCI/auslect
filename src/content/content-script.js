// Extraction de l'article de la page courante via Readability.
// S'exécute dans le contexte de la page : ne jamais modifier le DOM réel.
import { Readability, isProbablyReaderable } from "@mozilla/readability";

function extractArticle() {
  if (!isProbablyReaderable(document)) return null;

  const clone = document.cloneNode(true); // Readability est destructif : on clone avant parse().
  const article = new Readability(clone).parse();
  if (!article) return null;

  return {
    title: article.title,
    html: article.content, // HTML nettoyé : garde les frontières de paragraphes/titres.
    text: article.textContent,
    lang: document.documentElement.lang || article.lang || "fr",
  };
}

// Effet de bord volontaire : le résultat est relu ensuite par le background via
// scripting.executeScript({ func: () => window.__auslectArticle }).
window.__auslectArticle = extractArticle();
