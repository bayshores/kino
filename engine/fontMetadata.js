const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

function safeString(value) {
  if (value == null) return "";
  return [...String(value).normalize("NFC").replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim()]
    .slice(0, 200)
    .join("");
}

function readName(font, key) {
  if (typeof font?.getName !== "function") return "";
  try {
    return safeString(font.getName(key));
  } catch {
    return "";
  }
}

function filenameStem(filename) {
  const base = String(filename ?? "").replace(/\\/gu, "/").split("/").at(-1) ?? "";
  const extension = base.lastIndexOf(".");
  return safeString(extension > 0 ? base.slice(0, extension) : base);
}

// Match the original server's filename-derived family exactly. Collapsing its
// spaces or replacing a control character would break family-only references
// saved before embedded family names were used.
function legacyFilenameFamily(filename) {
  const base = String(filename ?? "").split("/").at(-1) ?? "";
  const extension = base.lastIndexOf(".");
  const stem = extension > 0 ? base.slice(0, extension) : base;
  return stem.trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 200);
}

function metadataStyle(font) {
  const subfamilies = [
    readName(font, "preferredSubfamily"),
    readName(font, "fontSubfamily"),
    safeString(font?.subfamilyName),
  ];
  return subfamilies.some((name) => /italic|oblique/iu.test(name)) ? "italic" : "normal";
}

/** Return safe, document-facing metadata for an uploaded font face. */
export function uploadedFontMetadata(font, filename) {
  const family =
    readName(font, "preferredFamily") ||
    readName(font, "fontFamily") ||
    safeString(font?.familyName) ||
    filenameStem(filename);
  const legacyFamily = legacyFilenameFamily(filename);
  const aliases = legacyFamily && legacyFamily.toLowerCase() !== family.toLowerCase()
    ? [legacyFamily]
    : [];
  const weight = Number(font?.["OS/2"]?.usWeightClass);

  return {
    family,
    aliases,
    weight: Number.isFinite(weight) && weight > 0 && weight <= 1000 ? weight : 400,
    style: metadataStyle(font),
  };
}
