// Découpe le HTML nettoyé d'un article en segments lisibles un par un :
// bloc (paragraphe, titre, item de liste...) puis phrases regroupées.
//
// Un segment est l'unité de synthèse : chaque appel au moteur paie un coût fixe
// (phonémisation, préparation des tenseurs). Une phrase par segment rend ce coût
// dominant — mesuré à 26 % du temps total — d'où le regroupement des phrases
// voisines d'un même bloc, plafonné pour ne pas donner au modèle une entrée
// démesurée ni rendre la pause paresseuse.

const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote";
const SENTENCE_SPLIT_REGEX = /(?<=[.!?…])\s+(?=[A-ZÀ-Ö0-9«"])/;
const MAX_SEGMENT_CHARS = 250;

export function segmentArticle(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks = doc.querySelectorAll(BLOCK_SELECTOR);

  const segments = [];
  let blockIndex = 0;

  for (const block of blocks) {
    const text = block.textContent.trim().replace(/\s+/g, " ");
    if (!text) continue;

    const isHeading = /^H[1-6]$/.test(block.tagName);
    // Le regroupement ne franchit jamais une frontière de bloc : un titre ne
    // doit pas être prononcé d'un trait avec le paragraphe qui le suit.
    for (const group of groupSentences(splitIntoSentences(text))) {
      segments.push({ text: group, blockIndex, isHeading });
    }
    blockIndex += 1;
  }

  return segments;
}

function groupSentences(sentences) {
  const groups = [];
  let current = "";

  for (const sentence of sentences) {
    if (current && current.length + 1 + sentence.length > MAX_SEGMENT_CHARS) {
      groups.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }

  if (current) groups.push(current);
  return groups;
}

function splitIntoSentences(text) {
  const parts = text
    .split(SENTENCE_SPLIT_REGEX)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text];
}
