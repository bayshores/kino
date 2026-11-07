import { loadBundledFonts } from "../backend/fonts.mjs";
import { defaultFonts } from "../engine/fonts.js";
defaultFonts.replace(await loadBundledFonts());
