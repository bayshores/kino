// The settings screen (plan §5.9): six numbered panes in the main screen's style. Each setting is
// one row, its control on the right. Changes save at once (onSave); the top line says "Saved.".
// The stops pane is StopSettings in stops.jsx, built from SettingsPane, SettingRow and Choice. It
// comes before the approvals: its stops hold a final render, so they must not be missed.
//
// Keys on this screen: ↑ ↓ (and j k) move between rows, ← → change a choice, typing the start of
// an option picks it, 1 to 6 jump to a pane, c copies "kino setup", y the MCP config, d detects
// this computer's graphics cards and encoders again. Esc goes back (Dashboard.jsx).
import React, { useEffect, useState } from "react";
import { cacheUsage, mcpConfig, renderDevices } from "./api.js";
import { ago, bytes } from "./format.js";
import { isTyping } from "./keys.js";
import { fpsLabel } from "../../engine/frameRate.js";
import { notificationsAllowed } from "./notify.js";
import { agentRows } from "./state.js";
import { Back, Screen } from "./screens.jsx";
import { Btn, Switch } from "./controls.jsx";
import { APPROVAL_KINDS, APPROVAL_WORDS, DRAFT_WIDTHS, EXPORT_FORMATS, EXPORT_FPS, FRAMES_AT_ONCE, VIDEO_ENCODER_WORDS, VIDEO_QUALITY_WORDS } from "./words.js";

// The approvals with a limit in their row come first.
const LIMITED_FIRST = ["final-render", "large-import", ...APPROVAL_KINDS.filter((kind) => kind !== "final-render" && kind !== "large-import")];

// The colors of a chosen ask, allow or deny (the dot in its chip).
export const POLICY_COLORS = { ask: "var(--accent)", allow: "var(--ok)", deny: "var(--urgent)" };

/** One pane: "1 agents" set into its top border, like the main screen's panes (panes.jsx). */
export function SettingsPane({ number, name, area, note, children }) {
  return (
    <section className="pane set-pane" style={{ gridArea: area }} data-pane={number} aria-labelledby={`set-pane-${number}`}>
      <h2 id={`set-pane-${number}`}><span className="pane-name">{name}</span></h2>
      <div className="pane-body set-body">
        {children}
        {note ? <p className="set-note">{note}</p> : null}
      </div>
    </section>
  );
}

/**
 * One setting. `label` names the control `id`: a <label> for an input or select, the radio
 * group's name for a Choice (`choice`). `hint` describes the control (aria-describedby on it is
 * the caller's, `${id}-hint`): read out only, unless `warn` is set, when it shows under the row
 * because it changes what the setting does (an override, a card or encoder this computer lacks).
 */
export function SettingRow({ id, label, hint, warn = false, choice = false, children }) {
  return (
    <div className="set-item">
      <div className="set-row">
        {choice ? <span className="set-label" id={`${id}-label`}>{label}</span> : <label className="set-label" htmlFor={id}>{label}</label>}
        <span className="set-control">{children}</span>
      </div>
      {hint ? <span id={`${id}-hint`} className={warn ? "set-warn" : "sr-only"}>{hint}</span> : null}
    </div>
  );
}

/**
 * A row of choices, each a chip: a radio group, so Tab enters it at the chosen one and ← → move
 * and choose (the browser's own keys). `options` are { value, text?, disabled? }; `colors` maps a
 * value to the dot its chip shows while chosen.
 */
export function Choice({ id, value, options, onChange, disabled = false, colors = {}, ...rest }) {
  return (
    <div role="radiogroup" id={id} className="choice" aria-labelledby={rest["aria-label"] ? undefined : `${id}-label`} {...rest}>
      {options.map(({ value: option, text = String(option), disabled: off = false }) => {
        const on = String(option) === String(value);
        return (
          <label key={String(option)} className="chip" data-on={on || undefined}>
            <input type="radio" name={id} value={String(option)} checked={on} disabled={disabled || off} onChange={() => onChange(option)} />
            {on && colors[option] ? <span className="chip-dot" style={{ background: colors[option] }} aria-hidden="true" /> : null}
            {text}
          </label>
        );
      })}
    </div>
  );
}

/** An on/off switch (a real checkbox, role="switch"). */
export function Toggle({ id, checked, onChange, ...rest }) {
  return <Switch id={id} checked={checked} onChange={onChange} {...rest} />;
}

// A button with an icon and words; the screen's key presses it (data-key) and its tooltip names it.
const KeyButton = ({ k, icon, children, ...rest }) => (
  <Btn className="set-key" icon={icon} keys={k} data-key={k} {...rest}>{children}</Btn>
);

// Long absolute paths shown by their last three folders ("…/Contents/MacOS/Electron"); a copy
// always takes the whole text.
const shortPath = (path) => {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
};
// The MCP config with each server's fields on one line each, as short as the pane is narrow.
function compactConfig(config) {
  const servers = config?.mcpServers;
  if (!servers) return JSON.stringify(config, null, 2);
  const lines = ['{ "mcpServers": {'];
  const names = Object.keys(servers);
  names.forEach((name, index) => {
    lines.push(`  ${JSON.stringify(name)}: {`);
    const fields = Object.entries(servers[name]);
    fields.forEach(([key, value], at) => lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(value, null, 1).replace(/\n\s*/g, " ")}${at < fields.length - 1 ? "," : ""}`));
    lines.push(`  }${index < names.length - 1 ? "," : ""}`);
  });
  lines.push("} }");
  return lines.join("\n");
}
const shortPaths = (text) => text.replace(/"((?:\/|[A-Za-z]:\\\\)[^"]+)"/g, (whole, path) => `"${shortPath(path.replace(/\\\\/g, "\\"))}"`);

/**
 * The screen's own keys (see the top of this file). It runs before the dashboard's keys
 * (Dashboard.jsx listens on the window), and a key it uses is not passed on.
 */
function settingsKeys(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const root = event.currentTarget;
  const target = event.target;
  const key = event.key;
  const radio = target.matches?.("input[type=radio]") ? target : null;
  if (radio && key.length === 1 && key !== " ") {
    const inputs = [...radio.closest(".choice").querySelectorAll("input:not(:disabled)")];
    const match = inputs.find((input) => input.parentElement.textContent.trim().toLowerCase().startsWith(key.toLowerCase()));
    if (match) {
      event.preventDefault();
      if (!match.checked) match.click();
      match.focus();
      return;
    }
  }
  const select = target.tagName === "SELECT";
  // Text and number fields keep their keys; a select keeps all but ↑ and ↓.
  if (isTyping(target) && !select) return;
  const step = key === "ArrowDown" || (!select && key === "j") ? 1 : key === "ArrowUp" || (!select && key === "k") ? -1 : 0;
  if (step) {
    const items = [...root.querySelectorAll(".set-item")].filter((item) => item.getClientRects().length && focusTarget(item));
    const current = items.indexOf(target.closest?.(".set-item"));
    const next = items[current === -1 ? (step > 0 ? 0 : items.length - 1) : current + step];
    event.preventDefault();
    focusTarget(next)?.focus();
    return;
  }
  if (select) return;
  if (/^[1-6]$/.test(key)) {
    const item = [...root.querySelectorAll(`.set-pane[data-pane="${key}"] .set-item`)].find(focusTarget);
    const button = root.querySelector(`.set-pane[data-pane="${key}"] button:not(:disabled)`);
    event.preventDefault();
    (item ? focusTarget(item) : button)?.focus();
    return;
  }
  const button = root.querySelector(`button[data-key="${CSS.escape(key)}"]:not(:disabled)`);
  if (button) {
    event.preventDefault();
    button.click();
  }
}

// The control ↑ and ↓ land on in a row: a choice's chosen chip, else its first control.
function focusTarget(item) {
  return item?.querySelector(".choice input:checked:not(:disabled)")
    ?? item?.querySelector(".set-control :is(input, select, button):not(:disabled)") ?? null;
}

// The hints of the rendering settings, from GET /api/dashboard/render/devices (`devices`, null while
// it loads). An environment variable the server was started with wins over a setting; its control
// is then disabled and the hint names the variable.
function graphicsHint(devices, setting) {
  if (!devices) return "looking for graphics cards…";
  const { graphics, overrides, lastRender } = devices;
  if (overrides.graphics) return `${overrides.graphics} is set where the server started, so every render draws on the processor.`;
  const parts = [];
  if (overrides.card.length) parts.push(`${overrides.card.join(", ")} set where the server started ${overrides.card.length > 1 ? "choose" : "chooses"} the card.`);
  if (graphics.saved && !graphics.saved.found) parts.push(`"${graphics.saved.name}" was not found on this computer, so renders use Auto.`);
  else if (graphics.saved && !graphics.saved.used) parts.push(`A card cannot be chosen by name on this computer, so "${graphics.saved.name}" acts as Auto.`);
  if (graphics.platform === "wsl" && graphics.auto === "processor" && !overrides.card.length)
    parts.push("Auto draws on the processor here: on WSL the card draws only on WSLg's display (DISPLAY unset or :0, not xvfb-run's) with /dev/dxg.");
  if (!graphics.canChoose) parts.push(graphics.platform === "darwin" || graphics.platform === "win32" ? "Auto uses the faster card when there are two." : "");
  const last = lastRender?.graphics;
  if (last?.renderer) parts.push(`Last render: ${last.renderer} (${last.card ? "graphics card" : "processor"}).`);
  else if (setting !== "processor") parts.push("Processor only is slower but draws the same everywhere.");
  return parts.filter(Boolean).join(" ");
}

// True when the graphics hint changes what the setting does, so it shows under the row.
const graphicsWarns = (devices) => Boolean(devices && (devices.overrides.graphics || devices.overrides.card.length
  || (devices.graphics.saved && (!devices.graphics.saved.found || !devices.graphics.saved.used))));

function encoderHint(devices, setting) {
  const entry = devices?.videoEncoders.find((item) => item.id === setting);
  if (entry && !entry.available) return `MP4 only. ${entry.label} does not work on this computer (${entry.reason}), so MP4 renders stop with an error until you choose another.`;
  if (devices && setting !== "auto" && setting !== "software" && !entry) return "MP4 only. This encoder is not made for this computer, so MP4 renders stop with an error until you choose another.";
  const last = devices?.lastRender?.videoEncoder;
  return `MP4 only; an agent may choose another for one render.${last ? ` Last render: ${last.ffmpegEncoder}, ${last.quality} quality.` : ""}`;
}

const encoderWarns = (devices, setting) => {
  if (!devices || setting === "auto" || setting === "software") return false;
  const entry = devices.videoEncoders.find((item) => item.id === setting);
  return !entry || !entry.available;
};

// "VideoToolbox (Apple)" → "VideoToolbox": the machine line has little room.
const shortEncoder = (label) => label.replace(/\s*\(.*\)$/, "");

// `stops` is the stops pane (StopSettings in stops.jsx), pane 2.
export function SettingsScreen({ data, onSave: saveTo, onClearCache, onClearRenderCache, onBack, notificationState, onAskNotifications, now, stops = null }) {
  const settings = data.settings;
  // "saved" shows under the panes for a few seconds after each change made here.
  const [savedAt, setSaved] = useState(0);
  useEffect(() => {
    if (!savedAt) return undefined;
    const timer = setTimeout(() => setSaved(0), 4000);
    return () => clearTimeout(timer);
  }, [savedAt]);
  const onSave = async (change) => { const reply = await saveTo(change); setSaved(Date.now()); return reply; };
  const [cache, setCache] = useState(null);
  const [renderCache, setRenderCache] = useState(null);
  const [devices, setDevices] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [config, setConfig] = useState(null);
  const [copied, setCopied] = useState("");
  const [limits, setLimits] = useState(() => ({ ...settings?.limits, cache: settings?.compute.frameCacheMegabytes, folder: settings?.exports.folder ?? "",
    keepFree: settings?.compute.keepFreePercent, renderCache: settings?.compute.renderCacheMegabytes, previewCache: settings?.compute.previewCacheMegabytes }));
  const [previewCache, setPreviewCache] = useState(null);

  useEffect(() => {
    let active = true;
    cacheUsage().then((value) => { if (active) { setCache(value.cache); setRenderCache(value.renderCache ?? null); setPreviewCache(value.previewCache ?? null); } }).catch(() => {});
    mcpConfig().then((value) => { if (active) setConfig(value); }).catch(() => {});
    return () => { active = false; };
  }, [settings?.compute.frameCacheMegabytes, settings?.compute.renderCacheMegabytes, settings?.compute.previewCacheMegabytes]);

  useEffect(() => {
    let active = true;
    renderDevices().then((value) => { if (active) setDevices(value); }).catch(() => {});
    // Renders finish while this screen is open: every 10 s (while the window is shown) read the
    // cache sizes and the last render again, so the rows do not show numbers from before them.
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      cacheUsage().then((value) => { if (active) { setCache(value.cache); setRenderCache(value.renderCache ?? null); setPreviewCache(value.previewCache ?? null); } }).catch(() => {});
      renderDevices().then((value) => { if (active) setDevices(value); }).catch(() => {});
    }, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(""), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!settings) return <Screen title="settings" actions={<Back onBack={onBack} />}><p className="faint">loading…</p></Screen>;
  const agents = agentRows(data, now);
  const copy = async (name, text) => {
    try { await navigator.clipboard.writeText(text); setCopied(name); } catch { setCopied(""); }
  };
  const number = (value) => { const parsed = Number(value); return Number.isFinite(parsed) ? Math.round(parsed) : value; };
  const configText = config ? JSON.stringify(config, null, 2) : "";
  const used = cache?.limitBytes ? Math.min(1, cache.bytes / cache.limitBytes) : 0;
  const renderUsed = renderCache?.limitBytes ? Math.min(1, renderCache.bytes / renderCache.limitBytes) : 0;
  const previewUsed = previewCache?.limitBytes ? Math.min(1, previewCache.bytes / previewCache.limitBytes) : 0;
  const detect = async () => {
    setDetecting(true);
    try { setDevices(await renderDevices(true)); } catch { /* the rows keep the last answer */ } finally { setDetecting(false); }
  };
  // The video encoders: Auto (named after what it picks here), Software, then every hardware family;
  // one this computer cannot use is listed but cannot be chosen.
  const encoders = devices?.videoEncoders ?? [];
  const autoEncoder = encoders.find((entry) => entry.id === devices?.autoVideoEncoder);
  const encoderWorks = (id) => !devices || id === "software" || encoders.some((entry) => entry.id === id && entry.available);
  const cards = devices?.graphics.canChoose ? devices.graphics.cards : [];
  const savedCard = !["auto", "processor"].includes(settings.compute.graphics) ? settings.compute.graphics : null;
  // Renders match a saved card's name in any case (render-devices.mjs namedCard): its option keeps
  // the card's own name and the saved value.
  const isSaved = (card) => savedCard !== null && card.name.toLowerCase() === savedCard.trim().toLowerCase();
  // A saved name renders do not use (not found, or on macOS and Windows, where cards cannot be
  // chosen) is shown as acting as Auto.
  const saved = devices?.graphics.saved;
  const savedNote = !saved ? "" : !saved.found ? " (not found: acts as Auto)" : !saved.used ? " (acts as Auto here)" : "";
  const notificationsOn = notificationState === "granted" || notificationsAllowed();
  const dataFolder = data.storage?.dataDirectory ?? "";
  const meter = (share) => <span className="meter" aria-hidden="true"><span style={{ width: `${Math.round(share * 100)}%` }} /></span>;

  return (
    <Screen title="settings" className="settings" onKeyDown={settingsKeys} actions={<Back onBack={onBack} />}>
      <div className="settings-grid">
        <SettingsPane number="1" name="agents" area="agents">
          {agents.length === 0 ? <p className="faint set-line">no agent has called kino yet.</p> : agents.map((agent) => (
            <p key={agent.id} className="set-agent">
              <span className={`s-${agent.status}`} aria-hidden="true">●</span>
              <span className="agent-name" style={agent.color ? { color: agent.color } : undefined}>{agent.name}</span>
              {agent.kind && agent.kind !== agent.name ? <span className="faint">{agent.kind}</span> : null}
              <span className="grow" />
              <span className={`s-${agent.status}`}>{agent.status}</span>
              <span className="faint">{agent.lastVerb} {ago(agent.lastAt, now)}</span>
            </p>
          ))}
          <div className="set-rule" />
          <div className="set-setup">
            <code><span className="faint">$ </span>kino setup</code>
            <KeyButton k="c" icon="copy" onClick={() => copy("setup", "kino setup")}>{copied === "setup" ? "copied" : "copy"}</KeyButton>
          </div>
          <p className="set-small">sets up claude code and codex, asking before each change.</p>
          <div className="set-config">
            <p className="set-config-head">
              <span>other agents: add this mcp server</span>
              <KeyButton k="y" icon="copy" disabled={!config} onClick={() => copy("config", configText)}>{copied === "config" ? "copied" : "copy config"}</KeyButton>
            </p>
            {config ? <pre aria-label="MCP configuration" title={configText}>{shortPaths(compactConfig(config))}</pre> : <p className="faint">loading…</p>}
          </div>
          <span className="sr-only" role="status">{copied ? "copied" : ""}</span>
          <SettingRow id="set-channels" label="push notes into claude code" hint="Off by default. Pushes your notes straight into a Claude Code session started with: claude --dangerously-load-development-channels server:kino. Restart the agent's kino MCP server after changing it. Notes always reach the agent through its inbox as well.">
            <Toggle id="set-channels" checked={settings.channels} aria-describedby="set-channels-hint" onChange={(event) => onSave({ channels: event.target.checked })} />
          </SettingRow>
        </SettingsPane>

        {stops}

        <SettingsPane number="3" name="approvals" area="approvals" note="the agent keeps working while one waits for you.">
          {LIMITED_FIRST.map((kind) => {
            const limit = kind === "final-render" ? ["set-frames", "finalRenderFrames", "frames", "final render frame limit", "final renders longer than this many frames ask first (default 600)"]
              : kind === "large-import" ? ["set-import", "importMegabytes", "MB", "import size limit in MB", "imports larger than this ask first (default 200 MB)"] : null;
            const label = !limit ? APPROVAL_WORDS[kind] : (
              <>
                {kind === "final-render" ? "final render over" : "import over"}
                <input id={limit[0]} className="set-num" type="number" min="1" max="100000" aria-label={limit[3]} title={limit[4]} value={limits[limit[1]] ?? ""}
                  onChange={(event) => setLimits({ ...limits, [limit[1]]: event.target.value })}
                  onBlur={() => onSave({ limits: { [limit[1]]: number(limits[limit[1]]) } })} />
                <span className="faint">{limit[2]}</span>
              </>
            );
            return (
              <SettingRow key={kind} id={`set-approval-${kind}`} label={label} choice>
                <Choice id={`set-approval-${kind}`} value={settings.approvals[kind]} colors={POLICY_COLORS}
                  options={[{ value: "ask" }, { value: "allow" }, { value: "deny" }]} onChange={(value) => onSave({ approvals: { [kind]: value } })} />
              </SettingRow>
            );
          })}
        </SettingsPane>

        <SettingsPane number="4" name="export" area="export">
          <SettingRow id="set-format" label="format" hint="used when the agent does not name one" choice>
            <Choice id="set-format" value={settings.exports.format} aria-describedby="set-format-hint" options={EXPORT_FORMATS.map((value) => ({ value }))}
              onChange={(value) => onSave({ exports: { format: value } })} />
          </SettingRow>
          <SettingRow id="set-fps" label="frame rate" hint="frames per second" choice>
            <Choice id="set-fps" value={settings.exports.fps} aria-describedby="set-fps-hint" options={EXPORT_FPS.map((value) => ({ value, text: fpsLabel(value) }))}
              onChange={(value) => onSave({ exports: { fps: Number(value) } })} />
          </SettingRow>
          <SettingRow id="set-video-quality" label="quality" hint="MP4 only. Smaller file is half the bitrate of Standard, High twice (Standard is 24 Mbps at 720p and up)." choice>
            <Choice id="set-video-quality" value={settings.exports.videoQuality} aria-describedby="set-video-quality-hint"
              options={Object.keys(VIDEO_QUALITY_WORDS).map((value) => ({ value, text: value === "small" ? "smaller" : value }))}
              onChange={(value) => onSave({ exports: { videoQuality: value } })} />
          </SettingRow>
          <SettingRow id="set-video-encoder" label="encoder" hint={encoderHint(devices, settings.exports.videoEncoder)} warn={encoderWarns(devices, settings.exports.videoEncoder)}>
            <span className="set-drop">
              <select id="set-video-encoder" aria-describedby="set-video-encoder-hint" value={settings.exports.videoEncoder} onChange={(event) => onSave({ exports: { videoEncoder: event.target.value } })}>
                <option value="auto">{autoEncoder ? `Auto (${autoEncoder.label} here)` : "Auto"}</option>
                {Object.entries(VIDEO_ENCODER_WORDS).map(([id, label]) => (
                  <option key={id} value={id} disabled={!encoderWorks(id) && settings.exports.videoEncoder !== id}>{label}{encoderWorks(id) ? "" : " (not on this computer)"}</option>
                ))}
              </select>
            </span>
          </SettingRow>
          <SettingRow id="set-folder" label="folder" hint="an absolute path; empty keeps renders in kino's own folder">
            <input id="set-folder" className="set-text" type="text" aria-describedby="set-folder-hint" value={limits.folder} placeholder="kino's folder" spellCheck={false}
              onChange={(event) => setLimits({ ...limits, folder: event.target.value })} onBlur={() => onSave({ exports: { folder: limits.folder.trim() } })} />
          </SettingRow>
        </SettingsPane>

        <SettingsPane number="5" name="render" area="render">
          <div className="set-machine">
            <p className="render-devices">
              {devices ? <>
                <span>{devices.graphics.cards.map((card) => card.name).join(", ") || "no graphics card found"}</span>
                <span className="faint">{encoders.filter((entry) => entry.available).map((entry) => `${shortEncoder(entry.label)} ✓`).join("  ") || "no MP4 encoder works"}</span>
              </> : <span className="faint">looking at this computer…</span>}
            </p>
            <KeyButton k="d" icon="detect" onClick={detect} disabled={detecting}>{detecting ? "detecting…" : <>detect<span className="sr-only"> again</span></>}</KeyButton>
          </div>
          <div className="set-rule" />
          <SettingRow id="set-graphics" label="graphics card" hint={graphicsHint(devices, settings.compute.graphics)} warn={graphicsWarns(devices)}>
            <span className="set-drop">
              <select id="set-graphics" aria-describedby="set-graphics-hint" value={settings.compute.graphics} disabled={Boolean(devices?.overrides.graphics)} onChange={(event) => onSave({ compute: { graphics: event.target.value } })}>
                <option value="auto">{devices?.graphics.auto ? `Auto (${devices.graphics.auto})` : "Auto"}</option>
                <option value="processor">Processor only</option>
                {cards.map((card) => <option key={card.name} value={isSaved(card) ? savedCard : card.name}>{card.name}</option>)}
                {savedCard && !cards.some(isSaved) ? <option value={savedCard}>{savedCard}{savedNote}</option> : null}
              </select>
            </span>
          </SettingRow>
          <SettingRow id="set-frames-at-once" label="frames at once" choice warn={Boolean(devices?.overrides.framesAtOnce)} hint={devices?.overrides.framesAtOnce
            ? `${devices.overrides.framesAtOnce} is set where the server started, so it decides.`
            : "More than 1 is faster, but a few pixels may differ by 1 level. Free memory, processor cores and length still limit it. Auto is up to 8."}>
            <Choice id="set-frames-at-once" value={settings.compute.framesAtOnce} aria-describedby="set-frames-at-once-hint" disabled={Boolean(devices?.overrides.framesAtOnce)}
              options={FRAMES_AT_ONCE.map((value) => ({ value }))} onChange={(value) => onSave({ compute: { framesAtOnce: value } })} />
          </SettingRow>
          <SettingRow id="set-keep-free" label="memory to leave free" hint="renders start fewer frames at once rather than use this share of memory (5 to 60, default 20)">
            <input id="set-keep-free" className="set-num" type="number" min="5" max="60" aria-describedby="set-keep-free-hint" value={limits.keepFree ?? ""}
              onChange={(event) => setLimits({ ...limits, keepFree: event.target.value })}
              onBlur={() => onSave({ compute: { keepFreePercent: number(limits.keepFree) } })} />
            <span className="faint">%</span>
          </SettingRow>
          <SettingRow id="set-draft" label="draft size" hint="drafts are half size, with the long side at most this many pixels" choice>
            <Choice id="set-draft" value={settings.compute.draftWidth} aria-describedby="set-draft-hint" options={DRAFT_WIDTHS.map((value) => ({ value }))}
              onChange={(value) => onSave({ compute: { draftWidth: Number(value) } })} />
          </SettingRow>
          <div className="set-rule" />
          <SettingRow id="set-render-cache" label="render cache" hint={renderCache ? `${bytes(renderCache.bytes)} used by ${renderCache.entries} finished render${renderCache.entries === 1 ? "" : "s"}, limit in MB` : "finished renders kept to reuse unchanged scenes, limit in MB"}>
            {meter(renderUsed)}
            <span>{renderCache ? bytes(renderCache.bytes) : "…"} /</span>
            <input id="set-render-cache" className="set-num" type="number" min="64" max="65536" aria-describedby="set-render-cache-hint" value={limits.renderCache ?? ""}
              onChange={(event) => setLimits({ ...limits, renderCache: event.target.value })}
              onBlur={() => onSave({ compute: { renderCacheMegabytes: number(limits.renderCache) } })} />
            <span className="faint">MB</span>
            <Btn className="set-clear" icon="trash" disabled={!renderCache} onClick={async () => setRenderCache((await onClearRenderCache?.())?.renderCache ?? renderCache)}>clear<span className="sr-only"> the render cache</span></Btn>
          </SettingRow>
          <SettingRow id="set-preview-size" label="preview cache" hint={`While kino is idle, it draws the scene you watch to small videos, so playback is smooth (the line under the timeline's ruler shows what is ready). ${previewCache ? `${bytes(previewCache.bytes)} used by ${previewCache.entries} segment${previewCache.entries === 1 ? "" : "s"}; the oldest go first.` : "The oldest segments go first when it is full (default 2048)."} Limit in MB.`}>
            {meter(previewUsed)}
            <span>{previewCache ? bytes(previewCache.bytes) : "…"} /</span>
            <input id="set-preview-size" className="set-num" type="number" min="64" max="65536" aria-describedby="set-preview-size-hint" value={limits.previewCache ?? ""}
              onChange={(event) => setLimits({ ...limits, previewCache: event.target.value })}
              onBlur={() => onSave({ compute: { previewCacheMegabytes: number(limits.previewCache) } })} />
            <span className="faint">MB</span>
            <Toggle id="set-preview-cache" checked={settings.compute.previewCache !== false} aria-label="preview cache on" aria-describedby="set-preview-size-hint"
              onChange={(event) => onSave({ compute: { previewCache: event.target.checked } })} />
          </SettingRow>
          <SettingRow id="set-cache" label="frame cache" hint={cache ? `${bytes(cache.bytes)} used by ${cache.frames} stage frames, limit in MB` : "stage frames kept for playback, limit in MB"}>
            {meter(used)}
            <span>{cache ? bytes(cache.bytes) : "…"} /</span>
            <input id="set-cache" className="set-num" type="number" min="64" max="65536" aria-describedby="set-cache-hint" value={limits.cache ?? ""}
              onChange={(event) => setLimits({ ...limits, cache: event.target.value })}
              onBlur={() => onSave({ compute: { frameCacheMegabytes: number(limits.cache) } })} />
            <span className="faint">MB</span>
            <Btn className="set-clear" icon="trash" onClick={async () => setCache((await onClearCache())?.cache ?? cache)}>clear<span className="sr-only"> the frame cache</span></Btn>
          </SettingRow>
        </SettingsPane>

        <SettingsPane number="6" name="notify · sound · storage" area="other" note="Sound search made using Openverse. Not endorsed or certified by Openverse.">
          <div className="set-item">
            <div className="set-row">
              <span className="set-label">system notifications</span>
              <span className="set-control">
                {notificationsOn ? <Switch id="set-notify" checked disabled label="system notifications on" title="for requests and errors; turn them off in the system settings" />
                  : notificationState === "denied" ? <span className="faint">blocked in the system settings</span>
                    : notificationState === "unsupported" ? <span className="faint">not available here</span>
                      : <Btn icon="check" onClick={onAskNotifications}>allow<span className="sr-only"> system notifications for requests and errors</span></Btn>}
              </span>
            </div>
          </div>
          <SettingRow id="set-quiet" label="tell me when an agent goes quiet" hint="Off by default. After 30 s without a call, only while this window is in the background, a silent notification names the agent and its last call, once each time it goes quiet.">
            <Toggle id="set-quiet" checked={Boolean(settings.notify?.quiet)} aria-describedby="set-quiet-hint"
              onChange={async (event) => {
                const quiet = event.target.checked;
                onSave({ notify: { quiet } });
                // Turning it on asks for permission, as the allow button does.
                if (quiet && notificationState === "default") await onAskNotifications?.();
              }} />
          </SettingRow>
          <SettingRow id="set-sound-search" label="find sounds and songs online" hint="Off by default. When on, agents may find CC0 sound effects and Creative Commons songs: an agent's search words go to Openverse and the Internet Archive (no account); imported files keep their creator, link and license.">
            <Toggle id="set-sound-search" checked={Boolean(settings.sounds?.search)} aria-describedby="set-sound-search-hint"
              onChange={(event) => onSave({ sounds: { search: event.target.checked } })} />
          </SettingRow>
          <SettingRow id="set-freesound-key" label="Freesound key" hint="Optional. A free Freesound API key adds Freesound to sound search (previews only, no sign-in here). Empty: Openverse alone.">
            <input id="set-freesound-key" className="set-text" type="password" autoComplete="off" spellCheck={false} placeholder="none" aria-describedby="set-freesound-key-hint"
              defaultValue={settings.sounds?.freesoundKey ?? ""} key={settings.sounds?.freesoundKey ?? ""}
              onBlur={(event) => { const value = event.target.value.trim(); if (value !== (settings.sounds?.freesoundKey ?? "")) onSave({ sounds: { freesoundKey: value } }); }} />
          </SettingRow>
          <div className="set-rule" />
          <SettingRow id="set-data-copy" label="data folder" hint="Start kino with MOTION_DATA_DIR to use another folder.">
            <code id="set-data" className="faint set-path" title={dataFolder}>{shortPath(dataFolder)}</code>
            <Btn id="set-data-copy" className="set-clear" icon="copy" aria-describedby="set-data-copy-hint" disabled={!dataFolder}
              onClick={() => copy("data", dataFolder)}>{copied === "data" ? "copied" : "copy"}<span className="sr-only"> the data folder's path</span></Btn>
          </SettingRow>
        </SettingsPane>
      </div>
      <p className="set-saved" role="status">{savedAt ? "saved · agents read it on their next call" : ""}</p>
    </Screen>
  );
}
