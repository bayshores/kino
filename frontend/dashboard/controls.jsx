// Small mouse-first controls shared by the crew, projects, share and settings screens, in the
// inspire screen's style (inspire.css): line icons, buttons with an icon and a word, toggle
// groups, on/off switches and number steppers. Styles in screens.css. Keys stay on the screens;
// a button names its key in its tooltip (title) and aria-keyshortcuts.
import React from "react";
import "./screens.css";

const ICONS = {
  back: "M13 8H3M7 4L3 8l4 4",
  plus: "M8 3v10M3 8h10",
  minus: "M3 8h10",
  x: "M4 4l8 8M12 4l-8 8",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  eye: "M1.5 8s2.5-4.5 6.5-4.5 6.5 4.5 6.5 4.5-2.5 4.5-6.5 4.5S1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  hold: "M5.5 3v10M10.5 3v10",
  stop: "M4 4h8v8H4z",
  message: "M2.5 3h11v8h-6l-3 2.5V11h-2z",
  compass: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM10.5 5.5l-1.5 3.5-3.5 1.5 1.5-3.5z",
  screen: "M2 3h12v8H2zM5.5 14h5M8 11v3",
  lock: "M4 7.5h8v6H4zM5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2",
  folder: "M2 4.5V12.5h12V6H7.5L6 4.5z",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  link: "M7 9a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5L8.5 4M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.5-.5",
  comment: "M2.5 3h11v8h-6l-3 2.5V11h-2z",
  pencil: "M10.5 2.5l3 3-8 8h-3v-3z",
  search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm3.5-1.5L14 14",
  timer: "M8 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 5.5V8.5l2 1.5M6.5 1.5h3",
  detect: "M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  check: "M3 8.5l3 3 7-7",
  chevron: "M6 4l4 4-4 4",
};

/** A 16 px line icon. Decorative: the control it sits in carries the words. */
export function Icon({ name, className = "" }) {
  return (
    <svg className={`ui-icon ${className}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  );
}

/**
 * A button with an icon and words. `kind`: "" (outlined), "primary" (the accent), "urgent" (red
 * words), "quiet" (no border). `keys` is the key that does the same, shown in the tooltip.
 */
export function Btn({ icon, kind = "", keys, title, children, className = "", ...rest }) {
  const tip = [title, keys ? `key: ${keys}` : ""].filter(Boolean).join(" · ") || undefined;
  return (
    <button type="button" className={`ui-btn${kind ? ` ${kind}` : ""}${className ? ` ${className}` : ""}`} title={tip} aria-keyshortcuts={keys || undefined} {...rest}>
      {icon ? <Icon name={icon} /> : null}{children}
    </button>
  );
}

/** A row of choices where one is on: [{ value, text, icon?, count? }]. Radio buttons inside. */
export function Segmented({ name, label, value, options, onChange, className = "", disabled = false }) {
  return (
    <div role="radiogroup" aria-label={label} className={`ui-seg ${className}`}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <label key={String(option.value)} className={`ui-seg-item${on ? " on" : ""}${option.value === "allow" ? " ok" : ""}`}>
            <input type="radio" className="sr-only" name={name} checked={on} disabled={disabled || option.disabled} onChange={() => onChange(option.value)} />
            {option.icon ? <Icon name={option.icon} /> : null}
            <span>{option.text ?? String(option.value)}</span>
            {option.count != null ? <span className="ui-seg-n">· {option.count}</span> : null}
          </label>
        );
      })}
    </div>
  );
}

/** An on/off switch: a real checkbox with role="switch". */
export function Switch({ id, checked, onChange, label, ...rest }) {
  return (
    <span className="ui-switch">
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={onChange} aria-label={label} {...rest} />
      <span className="ui-switch-track" aria-hidden="true"><span /></span>
    </span>
  );
}

/** A whole number with − and + buttons; saved at once on a press, or on Enter or blur when typed. */
export function Stepper({ value, min, max, label, onSave }) {
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => { setDraft(String(value)); }, [value]);
  const save = (number) => {
    if (!Number.isInteger(number) || number < min || number > max) { setDraft(String(value)); return; }
    setDraft(String(number));
    if (number !== value) onSave(number);
  };
  return (
    <span className="ui-stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`${label}: one less`} disabled={value <= min} onClick={() => save(value - 1)}><Icon name="minus" /></button>
      <input type="number" min={min} max={max} step={1} value={draft} aria-label={label} style={{ width: `${Math.max(1, draft.length) + 1}ch` }}
        onChange={(event) => setDraft(event.target.value)} onBlur={() => save(Number(draft))}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(Number(draft)); } }} />
      <button type="button" aria-label={`${label}: one more`} disabled={value >= max} onClick={() => save(value + 1)}><Icon name="plus" /></button>
    </span>
  );
}

/** A box with its title set into the top border, as the inspire screen's boxes. */
export function TitledBox({ title, labelId, className = "", style, children, actions = null }) {
  return (
    <section className={`ui-box ${className}`} style={style} aria-labelledby={labelId}>
      <h3 className="ui-box-title" id={labelId}>{title}</h3>
      {actions}
      <div className="ui-box-body">{children}</div>
    </section>
  );
}
