// Letter spacing, saved as a percentage of the font size.
//
// kino saves it as a percentage of the font size since document version 2: a text layer with a font size
// of 48 px and a letter spacing of 10 adds 48 × 10 / 100 = 4.8 px after each letter. A Letter
// spacing animation changes the same percentage, so the spacing grows and shrinks with the font
// size. Documents of version 1 saved pixels; documentMigration.js converts them.

/**
 * The largest letter spacing in either direction, in percent of the font size. Version 1 allowed
 * ±10,000 px on text as small as 0.1 px, which is ±10,000,000 %, so every older file still opens.
 */
export const LETTER_SPACING_LIMIT = 10_000_000;

/** The font size text is laid out with (textLayout.js): at least 0.1 px, 24 px when it is not a number. */
export function layoutFontSize(fontSize) {
  return Math.max(0.1, Number(fontSize) || 24);
}

/** The pixels added after each letter by `letterSpacing` percent of `fontSize`. */
export function letterSpacingPixels(letterSpacing, fontSize) {
  return (layoutFontSize(fontSize) * (Number(letterSpacing) || 0)) / 100;
}

/** The letter spacing, in percent of `fontSize`, that adds `pixels` after each letter. */
export function letterSpacingPercent(pixels, fontSize) {
  return ((Number(pixels) || 0) / layoutFontSize(fontSize)) * 100;
}
