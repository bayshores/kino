// The share box: opens under the Share button of the top line, over whatever is shown. Make a
// link (watch, comment or edit, with who it is for), copy the one just made, and revoke a link.
// A watch link opens the viewer read only; comment and edit links open it with comments. Nobody
// edits by hand, so an edit link works like a comment link. The server keeps only a hash of a
// link's secret, so a link's address can be copied only right after it is made.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listShares } from "./api.js";
import { Btn, Icon, Segmented } from "./controls.jsx";
import { ago, cut } from "./format.js";
import "./shareBox.css";

const ROLE_WORDS = { view: "Watch", comment: "Comment", edit: "Edit" };

/** Newest first, and the links that still work before the revoked ones. */
export function shareRows(shares) {
  return [...(shares ?? [])].sort((a, b) => (Boolean(a.revokedAt) - Boolean(b.revokedAt)) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * `onMake(role, label)` resolves to { url, role } or null, `onRevoke(share, reload)` asks first,
 * `onClose()` closes the box (Escape, or a click outside it and outside a confirm box).
 */
export function ShareBox({ data, now, onMake, onRevoke, onClose }) {
  const boxRef = useRef(null);
  const fieldRef = useRef(null);
  const [shares, setShares] = useState(null);
  const [error, setError] = useState("");
  const [role, setRole] = useState("view");
  const [label, setLabel] = useState("");
  const [made, setMade] = useState(null);
  const [copied, setCopied] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((value) => value + 1);

  useEffect(() => {
    let active = true;
    listShares(data.projectId).then((value) => { if (active) { setShares(value.shares); setError(""); } }).catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [data.projectId, version]);

  useEffect(() => {
    fieldRef.current?.focus({ preventScroll: true });
    const outside = (event) => {
      if (boxRef.current?.contains(event.target) || event.target.closest?.(".confirm, #share-button")) return;
      onClose();
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, []);

  const copy = async (text) => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } };
  async function make(event) {
    event.preventDefault();
    const link = await onMake(role, label.trim());
    if (!link) return;
    setMade({ ...link, label: label.trim() });
    setCopied(false);
    setLabel("");
    reload();
    copy(link.url);
  }

  const rows = shareRows(shares);
  // Drawn at the top of the dashboard, not inside the top line, so nothing clips it.
  return createPortal(
    <section ref={boxRef} id="share-box" className="share-box" role="dialog" aria-label="Share this video"
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <form className="share-form" aria-label="Make a share link" onSubmit={make}>
        <Segmented name="share-role" label="What the link allows" value={role} onChange={setRole}
          options={["view", "comment", "edit"].map((value) => ({ value, text: ROLE_WORDS[value] }))} />
        <label className="ui-field"><span className="sr-only">Who it's for</span>
          <input ref={fieldRef} id="share-label" type="text" value={label} maxLength={100} placeholder="Who it's for" spellCheck={false} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <Btn kind="primary" icon="link" type="submit">Make link</Btn>
      </form>
      {made ? (
        <p className="share-made" role="status">
          <span className="share-url" title={made.url}>{made.url}</span>
          <Btn kind="quiet" className="icon-only" icon={copied ? "check" : "copy"} onClick={() => copy(made.url)} aria-label={copied ? "Copied. Copy the link again" : "Copy the link"} title={copied ? "Copied" : "Copy the link"} />
        </p>
      ) : null}
      {error ? <p className="err" role="alert">{error}</p> : rows.length ? (
        <ul className="share-list" aria-label="Links">
          {rows.map((share) => {
            const access = ROLE_WORDS[share.role] ?? share.role;
            return (
              <li key={share.id} className={share.revokedAt ? "revoked" : undefined}>
                <span className="share-who" title={share.label || undefined}>{share.label ? cut(share.label, 28) : "No name"}</span>
                <span className="share-meta">{access}, {share.revokedAt ? `revoked ${ago(share.revokedAt, now)} ago` : `${ago(share.createdAt, now)} ago`}</span>
                {share.revokedAt ? null : (
                  <Btn kind="quiet" className="icon-only" icon="x" onClick={() => onRevoke(share, reload)} title="Revoke: the link stops working"
                    aria-label={`Revoke the ${access.toLowerCase()} link${share.label ? ` "${share.label}"` : ""}`} />
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>,
    document.querySelector(".dash") ?? document.body,
  );
}
