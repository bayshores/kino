// The Claude Desktop extension (MCPB, manifest_version 0.3, schema in the anthropics/mcpb
// repository). It holds no code of its own: it starts the installed Mac app's MCP entry the way
// the app does (desktop/mcp-launch.mjs), so the app must be open. Where the app is installed is
// the one setting the person can change. `npm run mcpb:pack` (scripts/mcpb-pack.mjs) builds it.
import { mcpLaunch } from "./mcp-launch.mjs";

export const MCPB_APP_KEY = "app_path";
export const MCPB_DEFAULT_APP = "/Applications/kino.app";

// Where the packaged Mac app keeps what mcpLaunch needs, inside the .app folder.
const APP = `\${user_config.${MCPB_APP_KEY}}`;
export const PACKAGED = {
  execPath: (productName) => `${APP}/Contents/MacOS/${productName}`,
  root: `${APP}/Contents/Resources/app.asar`,
  runtimeFile: "${HOME}/Library/Application Support/kino/runtime.json",
};

/** The manifest.json for `version`, from the product name in package.json's `build`. */
export function mcpbManifest({ version, productName }) {
  return {
    manifest_version: "0.3",
    name: "kino",
    display_name: "kino",
    version,
    description: "Connect Claude Desktop to the kino Mac app: make and edit motion videos.",
    author: { name: "kino contributors" },
    repository: { type: "git", url: "https://github.com/bayshores/kino" },
    license: "AGPL-3.0-only",
    keywords: ["motion design", "video", "animation"],
    icon: "icon.png",
    server: {
      type: "binary",
      entry_point: "server/README.txt",
      mcp_config: mcpLaunch({ execPath: PACKAGED.execPath(productName), root: PACKAGED.root, runtimeFile: PACKAGED.runtimeFile }),
    },
    user_config: {
      [MCPB_APP_KEY]: {
        type: "directory",
        title: "kino app",
        description: "Where the kino app is installed. Open kino before asking Claude to use it.",
        default: MCPB_DEFAULT_APP,
        required: true,
      },
    },
    compatibility: { platforms: ["darwin"] },
  };
}

// server/README.txt: the bundle's entry_point must name a file; the server itself is the app.
export const MCPB_NOTE = "This extension starts the kino Mac app's own tool server.\nIt contains no other code: install and open kino first.\n";
