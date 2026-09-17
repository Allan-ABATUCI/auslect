// Analyse d'un signal synthétisé, partagée par les bancs de test.
//
// Le taux de passages par zéro sépare nettement la parole du bruit : une voix
// tourne autour de 0,02–0,20, un bruit blanc approche 0,5. C'est ce qui a permis
// d'identifier objectivement une sortie inexploitable sans avoir à l'écouter.

export function analyseSignal(samples, sampleRate) {
  let sumSquares = 0;
  let peak = 0;
  let crossings = 0;
  let clipped = 0;

  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    sumSquares += value * value;
    peak = Math.max(peak, Math.abs(value));
    if (Math.abs(value) >= 0.999) clipped++;
    if (i > 0 && Math.sign(value) !== Math.sign(samples[i - 1])) crossings++;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  const zeroCrossingRate = crossings / samples.length;

  return {
    durationSeconds: +(samples.length / sampleRate).toFixed(2),
    rms: +rms.toFixed(4),
    peak: +peak.toFixed(4),
    zeroCrossingRate: +zeroCrossingRate.toFixed(4),
    clippedRatio: +(clipped / samples.length).toFixed(4),
    verdict: verdictFor({ rms, zeroCrossingRate }),
  };
}

function verdictFor({ rms, zeroCrossingRate }) {
  if (rms < 0.001) return "SILENCE — rien n'a été produit";
  if (zeroCrossingRate > 0.35) return "BRUIT — sortie incohérente";
  if (zeroCrossingRate > 0.2) return "SUSPECT — très bruité pour de la parole";
  return "OK — profil compatible avec de la parole";
}
