// A picture that arrives as ASCII and resolves: while it loads, a block of text shades stands in
// for it; once it has loaded, the shades clear row by row from the top (each cell a little early
// or late), showing the picture. A picture that was already in the browser's cache shows at once.
// Only opacity animates (dashboard.css); reduced motion clears them at once.
import React, { useLayoutEffect, useRef, useState } from "react";
import { asciiCells } from "./resolveCells.js";

export function ResolveImage({ src, alt = "", onLoad, rows = 9, cols = 14, ...rest }) {
  const image = useRef(null);
  // "cached": loaded before the first paint (no shades); "waiting": shades; "clearing": loaded.
  const [phase, setPhase] = useState("waiting");
  useLayoutEffect(() => {
    setPhase(image.current?.complete && image.current.naturalWidth > 0 ? "cached" : "waiting");
  }, [src]);
  return (
    <span className="resolve">
      <img ref={image} src={src} alt={alt} {...rest}
        onLoad={(event) => { setPhase((value) => (value === "cached" ? value : "clearing")); onLoad?.(event); }} />
      {phase === "cached" ? null : (
        <span className={`resolve-ascii${phase === "clearing" ? " clearing" : ""}`} aria-hidden="true">
          {asciiCells(src, rows, cols).map((row, r) => (
            <span key={r} className="resolve-row">
              {row.map(({ char, delay }, c) => <span key={c} style={{ transitionDelay: `${delay}ms` }}>{char}</span>)}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
