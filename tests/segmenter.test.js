// Le segmenter décide de ce qui est prononcé et dans quel ordre : une erreur ici
// se traduit par des phrases avalées ou un article lu en désordre.
import test from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { segmentArticle } from "../src/lib/segmenter.js";

globalThis.DOMParser = DOMParser;

test("chaque bloc devient au moins un segment, dans l'ordre du document", () => {
  const segments = segmentArticle("<h1>Titre</h1><p>Premier.</p><p>Second.</p>");

  assert.deepEqual(
    segments.map((s) => s.text),
    ["Titre", "Premier.", "Second."],
  );
  assert.deepEqual(
    segments.map((s) => s.blockIndex),
    [0, 1, 2],
  );
});

test("les titres sont marqués pour pouvoir être intonés et espacés", () => {
  const segments = segmentArticle("<h2>Chapitre</h2><p>Texte.</p>");

  assert.equal(segments[0].isHeading, true);
  assert.equal(segments[1].isHeading, false);
});

test("les phrases courtes d'un paragraphe tiennent dans un seul segment", () => {
  // Un appel de synthèse par phrase ferait payer trois fois le coût fixe de
  // phonémisation pour quelques secondes d'audio.
  const segments = segmentArticle("<p>Première phrase. Deuxième phrase ! Troisième ?</p>");

  assert.deepEqual(
    segments.map((s) => s.text),
    ["Première phrase. Deuxième phrase ! Troisième ?"],
  );
  assert.equal(segments[0].blockIndex, 0);
});

test("un paragraphe long est coupé, sans phrase à cheval", () => {
  const sentence = "Voici une phrase de longueur tout à fait ordinaire pour un article.";
  const segments = segmentArticle(`<p>${Array(6).fill(sentence).join(" ")}</p>`);

  assert.ok(segments.length > 1, "au-delà de la limite, le bloc doit être scindé");
  for (const segment of segments) {
    assert.ok(segment.text.length <= 250, `segment trop long : ${segment.text.length}`);
    // Chaque segment doit commencer et finir sur une phrase entière.
    assert.match(segment.text, /[.!?…]$/);
  }
  // Aucun mot perdu en chemin.
  assert.equal(segments.map((s) => s.text).join(" "), Array(6).fill(sentence).join(" "));
});

test("le regroupement ne franchit jamais une frontière de bloc", () => {
  // Sans cette garantie, un titre serait prononcé d'un trait avec le paragraphe
  // suivant, et la respiration de fin de bloc disparaîtrait.
  const segments = segmentArticle("<h2>Titre court.</h2><p>Texte court.</p>");

  assert.deepEqual(
    segments.map((s) => s.text),
    ["Titre court.", "Texte court."],
  );
  assert.deepEqual(
    segments.map((s) => s.blockIndex),
    [0, 1],
  );
});

test("les blocs vides ou purement décoratifs sont ignorés", () => {
  const segments = segmentArticle("<p>   </p><p></p><p>Du contenu.</p>");

  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, "Du contenu.");
  assert.equal(segments[0].blockIndex, 0, "l'index ne doit pas compter les blocs vides");
});

test("les espaces et retours à la ligne du HTML sont normalisés", () => {
  const segments = segmentArticle("<p>Du texte\n   avec   des\tespaces.</p>");

  assert.equal(segments[0].text, "Du texte avec des espaces.");
});

test("une phrase sans ponctuation finale reste un segment entier", () => {
  const segments = segmentArticle("<p>Un titre sans point final</p>");

  assert.deepEqual(
    segments.map((s) => s.text),
    ["Un titre sans point final"],
  );
});

test("les listes et citations sont lues comme des blocs à part entière", () => {
  const segments = segmentArticle("<ul><li>Premier point.</li><li>Second point.</li></ul><blockquote>Une citation.</blockquote>");

  assert.deepEqual(
    segments.map((s) => s.text),
    ["Premier point.", "Second point.", "Une citation."],
  );
});

test("un article vide ne produit aucun segment plutôt qu'un segment vide", () => {
  assert.deepEqual(segmentArticle("<div></div>"), []);
});
