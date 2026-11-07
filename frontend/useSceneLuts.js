// The .cube LUTs that a preview's lut effects need, read from the media folder in the browser.
//
// How the data flows: useSceneLuts lists the .cube files the layers' lut effects use
// (lutFiles.js), fetches each one once per page, parses it with the same parser the server
// uses (colorMath.js parseCubeLut), and returns a Map of src → parsed LUT for renderSceneSvg's
// `luts` option. A file that is still loading is null there, and the lut effect leaves the
// layer ungraded until it arrives; a file that can't be read or parsed is { error }, and the
// preview shows that message, as an export would.

import { useEffect, useMemo, useState } from "react";
import { authorizedMediaUrl } from "./client.js";
import { layersLutSources, loadedLut, missingLut } from "../engine/effects/lutFiles.js";

// Shared by every preview on the page: src → parsed LUT or { error }, and the loads in progress.
const loaded = new Map();
const loading = new Map();

function loadLut(source) {
  if (!loading.has(source)) {
    loading.set(source, fetch(authorizedMediaUrl(source), { credentials: "same-origin" })
      .then(async (response) => (response.ok ? loadedLut(source, await response.text()) : missingLut(source)))
      .catch(() => missingLut(source))
      .then((lut) => {
        loaded.set(source, lut);
        return lut;
      }));
  }
  return loading.get(source);
}

export function useSceneLuts(layers) {
  // A string key, so the effect below runs only when the list of files changes.
  const key = useMemo(() => [...layersLutSources(layers)].sort().join("\n"), [layers]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    for (const source of key ? key.split("\n") : []) {
      if (!loaded.has(source)) loadLut(source).then(() => { if (active) setVersion((value) => value + 1); });
    }
    return () => { active = false; };
  }, [key]);
  return useMemo(() => new Map((key ? key.split("\n") : []).map((source) => [source, loaded.get(source) ?? null])), [key, version]);
}
