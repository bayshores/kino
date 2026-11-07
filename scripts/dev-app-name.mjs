// The Mac menu bar names an app by its bundle, not by app.setName: run from this folder, kino
// runs inside node_modules/electron's own Electron.app and so was called "Electron" there. This
// names that bundle kino and signs it again (ad hoc, only on this machine), since its signature
// covers Info.plist. `npm run desktop` runs it first; a packaged kino is named by its productName.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NAME = "kino";
const bundle = fileURLToPath(new URL("../node_modules/electron/dist/Electron.app", import.meta.url));
const plist = `${bundle}/Contents/Info.plist`;
const buddy = (command) => execFileSync("/usr/libexec/PlistBuddy", ["-c", command, plist], { encoding: "utf8" }).trim();
const read = (key) => { try { return buddy(`Print :${key}`); } catch { return null; } };

if (process.platform === "darwin" && existsSync(plist) && (read("CFBundleName") !== NAME || read("CFBundleDisplayName") !== NAME)) {
  buddy(`Set :CFBundleName ${NAME}`);
  buddy(read("CFBundleDisplayName") === null ? `Add :CFBundleDisplayName string ${NAME}` : `Set :CFBundleDisplayName ${NAME}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "ignore" });
  console.log(`The dev app is named ${NAME}.`);
}
