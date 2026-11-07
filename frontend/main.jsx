import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {EditorBoundary} from "./components/EditorBoundary.jsx";
import { api, shareToken } from "./client.js";
import { accessShell } from "./viewerNavigation.js";
import "./base.css";

function Startup() {
  const [ready, setReady] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    (async () => {
      const { access } = await api("/access");
      if (!active) return;
      const shell = accessShell(access);
      if (shell === "viewer") {
        // View, comment and edit links: the file plays here; comment and edit links add comments.
        const { Viewer } = await import("./Viewer.jsx");
        if (active) setReady({ Component: Viewer, access });
      } else if (shell === "dashboard") {
        // The owner's view is the dashboard (plan §5). /?editor opens it too: the manual editor is gone.
        const { Dashboard, DashboardBoundary } = await import("./dashboard/Dashboard.jsx");
        if (active) setReady({ Component: Dashboard, Boundary: DashboardBoundary, access });
      } else throw Object.assign(new Error("This link no longer works."), { status: 403 });
    })().catch((cause) => {
      if (active) setError(shareToken() && [403, 404, 410].includes(cause.status) ? "This link no longer works." : cause.message);
    });
    return () => { active = false; };
  }, [attempt]);
  if (ready?.Boundary) return <ready.Boundary><ready.Component access={ready.access} /></ready.Boundary>;
  if (ready) return <EditorBoundary viewer><ready.Component access={ready.access} /></EditorBoundary>;
  return <main className="startup" aria-live="polite">
    <strong>kino</strong>
    <p>{error || "Opening file…"}</p>
    {/* A revoked or unknown link stays that way, so trying again only helps with other errors. */}
    {error && error !== "This link no longer works." && <button onClick={() => setAttempt((value) => value + 1)}>Try again</button>}
  </main>;
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Startup />
  </React.StrictMode>,
);
