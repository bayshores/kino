// Letter shortcuts that follow the keyboard layout.
//
// A shortcut such as ⌥A means "Option with the key that has A printed on it", on any layout.
// A key press tells us two things:
// - event.key: the character the key typed. With Alt on Windows and Linux this is still the
//   letter printed on the key, but on a Mac Option changes it (Option+A types "å").
// - event.code: where the key sits, named after a US QWERTY keyboard. On a French AZERTY
//   keyboard the key with A printed on it sits where QWERTY has Q, so its code is "KeyQ".
// So the typed letter comes first. When Option has changed it, the layout map (Chromium and
// the Mac app: navigator.keyboard.getLayoutMap()) says which character is printed at that
// position. The position alone is used only when neither of those gives a Latin character,
// for example on a Cyrillic layout, the same way most apps handle those layouts.

const LETTER = /^[a-z]$/i;
const PRINTABLE_ASCII = /^[\x21-\x7e]$/;

/**
 * The lowercase letter a key press means for a letter shortcut, or null when the key is not
 * a letter on this layout. `layoutMap` is the result of readKeyboardLayout(), or null.
 */
export function shortcutLetter(event, layoutMap = null) {
  const typed = String(event?.key ?? "");
  if (LETTER.test(typed)) return typed.toLowerCase();
  const printed = layoutMap?.get?.(event?.code);
  if (typeof printed === "string" && PRINTABLE_ASCII.test(printed)) return LETTER.test(printed) ? printed.toLowerCase() : null;
  // Without a layout map, a typed digit or punctuation mark means the key is not a letter.
  if (!layoutMap && PRINTABLE_ASCII.test(typed)) return null;
  const position = /^Key([A-Z])$/.exec(String(event?.code ?? ""));
  return position ? position[1].toLowerCase() : null;
}
