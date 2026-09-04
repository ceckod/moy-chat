// js/song-lab.js

/**
 * Ограничава стиловите тагове за Suno AI до 190 символа, без да чупи думи
 */
export function formatSunoStyleTags(tagsString, maxLen = 190) {
  if (!tagsString || typeof tagsString !== 'string') return '';
  
  let trimmed = tagsString.trim();
  if (trimmed.length <= maxLen) return trimmed;
  
  // Изрязване до максимална дължина и премахване на последната незавършена дума/таг
  trimmed = trimmed.substring(0, maxLen);
  const lastComma = trimmed.lastIndexOf(',');
  
  return lastComma > 0 ? trimmed.substring(0, lastComma).trim() : trimmed.trim();
}

/**
 * Шаблон за поп-фолк / балканска структура на песен
 */
export const POP_FOLK_STRUCTURE_TEMPLATE = `
[Intro - Heavy Synth & Balkan Beat]

[Verse 1]
...

[Pre-Chorus / Bridge]
...

[Chorus]
...

[Bulgarian Solo / Kyuchek Break - Lead Synth & Drums]

[Verse 2]
...

[Chorus]
...

[Outro / Fade Out]
`;
