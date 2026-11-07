// Notifications (plan §5.13). Four kinds only: a request (the agent needs you), an error,
// complete (a render finished), and quiet (an agent went quiet, only when the person turned it
// on in Settings and the window is in the background). Requests, errors and quiet raise a system
// notification when you allowed them; only a request makes a sound. The window title and the
// Dock badge show the count. Routine progress never pops up.

/** The window title: "1 awaiting · kino", or the project name. */
export function windowTitle(count, projectName) {
  if (count > 0) return `${count} awaiting · kino`;
  return projectName ? `kino - ${projectName}` : "kino";
}

/** Sets the title and, in the desktop app, the Dock badge. */
export function showCount(count, projectName) {
  document.title = windowTitle(count, projectName);
  try { window.kinoDesktop?.setBadge?.(count); } catch { /* the badge is optional */ }
}

export function notificationsAllowed() {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

/** Asks for permission (must follow a click). Returns the new permission. */
export async function askForNotifications() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission === "default" ? Notification.requestPermission() : Notification.permission;
}

/** A system notification for a request, an error or quiet (silent). Complete never pops up. */
export function notify(kind, title, body, onClick) {
  if (kind === "complete" || !notificationsAllowed()) return null;
  try {
    const notification = new Notification(title, { body, tag: `kino-${kind}-${title}`, silent: kind !== "request" });
    if (onClick) notification.onclick = () => { window.focus(); onClick(); notification.close(); };
    return notification;
  } catch { return null; }
}
