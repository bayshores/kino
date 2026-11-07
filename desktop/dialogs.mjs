// The Mac app's two questions (main.mjs). A kino window keeps no unsaved work: the local service
// writes each project to this Mac as the agent changes it, and the dashboard and the viewer only
// show it. So each question says the projects are safe and offers what can be done next.

const SAVED = "Your projects are saved on this Mac by the local kino service.";

// What a window was about to do, as the button that goes ahead says it.
const GO_AHEAD = { close: "Close anyway", quit: "Quit anyway", reload: "Reload anyway", link: "Open the link anyway" };

/**
 * Asks what to do when a window did not answer before it closed, quit, reloaded or opened a link
 * (`action`: "close", "quit", "reload" or "link"). The page is busy or stuck. Resolves true to go
 * ahead anyway, false to wait (the window stays as it is and can be closed again later).
 */
export async function askWhenWindowDoesNotAnswer(dialog, window, action) {
  const { response } = await dialog.showMessageBox(window, {
    type: "warning", title: "kino is not answering",
    message: "This window did not answer.",
    detail: `${SAVED} Going ahead keeps them; only text still being typed in this window, such as a note or a comment, would be lost. Wait keeps the window open, so you can try again in a moment.`,
    buttons: [GO_AHEAD[action] ?? GO_AHEAD.close, "Wait"], defaultId: 0, cancelId: 1,
  });
  return response === 0;
}

/**
 * Says the local service stopped and could not restart on its own, and asks what to do next.
 * Resolves "restart" (try once more now), "quit" (quit kino) or "wait" (keep the windows open;
 * View > Restart local service tries again later).
 */
export async function askAfterServiceStopped(dialog) {
  const { response } = await dialog.showMessageBox({
    type: "error", title: "The local kino service stopped",
    message: "The local kino service stopped and did not restart.",
    detail: `${SAVED} Until the service runs again, the windows show no new changes and agents cannot reach kino. Not now keeps the windows open; Restart local service in the View menu tries again later.`,
    buttons: ["Restart local service", "Quit kino", "Not now"], defaultId: 0, cancelId: 2,
  });
  return ["restart", "quit", "wait"][response] ?? "wait";
}
