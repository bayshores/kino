import { useEffect, useRef, useState } from "react";
import "./ConnectionStatus.css";

const STATE_LABELS = {
  synced: "Synced",
  syncing: "Syncing",
  offline: "Offline",
  reconnecting: "Reconnecting",
  error: "Error",
  conflict: "Conflict",
};

function StatusIcon({ state }) {
  if (state === "synced") return <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.3 12.2 2.4 2.4 5-5.2" />
  </>;
  if (state === "syncing") return <>
    <path d="M20 7v5h-5M4 17v-5h5" />
    <path d="M5.8 9.1A7 7 0 0 1 18 6.4L20 12M4 12l2 5.6a7 7 0 0 0 12.2-2.7" />
  </>;
  if (state === "offline") return <>
    <path d="M4 9.5a12.4 12.4 0 0 1 15-1.1M7.5 13a7.2 7.2 0 0 1 8.8-.7M11 16.5a2.2 2.2 0 0 1 2.2-.2M4 4l16 16" />
  </>;
  if (state === "reconnecting") return <>
    <path d="M20 11a8 8 0 0 0-13.7-5.7L4 7.5M4 4v3.5h3.5M4 13a8 8 0 0 0 13.7 5.7l2.3-2.2M20 20v-3.5h-3.5" />
  </>;
  if (state === "conflict") return <>
    <path d="M12 3.8 21 20H3L12 3.8Z" />
    <path d="M12 9v5m0 2.7v.1" />
  </>;
  return <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v5.2m0 3.2v.1" />
  </>;
}

export function ConnectionStatus({ status, failure = "" }) {
  const state = Object.hasOwn(STATE_LABELS, status?.state) ? status.state : "syncing";
  const label = typeof status?.label === "string" && status.label ? status.label : STATE_LABELS[state];
  const description = typeof status?.description === "string" ? status.description : label;
  const failureText = typeof failure === "string" ? failure.trim() : "";
  const detail = [description, failureText].filter(Boolean).join(" ");
  const previous = useRef({ state: null, failure: "", offlinePending: false });
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const last = previous.current;
    let next = "";
    let offlinePending = last.offlinePending;

    if (state === "offline" && last.state !== "offline") {
      next = `${label}. ${description}`;
      offlinePending = true;
    } else if (state === "synced" && offlinePending) {
      next = `${label}. ${description}`;
      offlinePending = false;
    }

    const enteredFailureState = (state === "error" || state === "conflict") && last.state !== state;
    const newFailure = Boolean(failureText) && failureText !== last.failure;
    if (enteredFailureState || newFailure)
      next = failureText ? `${label}. ${failureText}` : `${label}. ${description}`;

    previous.current = { state, failure: failureText, offlinePending };
    setAnnouncement((current) => current === next ? current : next);
  }, [state, label, description, failureText]);

  const accessibleName = detail ? `${label}. ${detail}` : label;
  return <span className={`connection-status connection-status--${state}`} role="group"
    aria-label={accessibleName} title={accessibleName}>
    <svg className="connection-status__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <StatusIcon state={state} />
    </svg>
    <span className="connection-status__label">{label}</span>
    <span className="connection-status__live" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </span>;
}
