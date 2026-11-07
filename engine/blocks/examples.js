// One example copy for each recipe: shown in the library's "blocks" answer and used by the tests
// that check every recipe against the quality gates. `media: true` means the recipe needs a
// picture (an uploaded media ID); `settings` are more fields for the library's example.
export const EXAMPLES = Object.freeze({
  "logo-sting": { copy: { tagline: "Plan the week in one view" } },
  "headline-reveal": { copy: { text: "Plan the week in one view", sub: "Shared calendars for busy teams", kicker: "New" } },
  "device-slide": { copy: { text: "Everything in one place", sub: "Calendars, tasks and notes" }, media: true },
  "feature-callout": { copy: { text: "Smart scheduling", sub: "Finds the time that works for everyone" } },
  "screen-detail": { copy: {}, media: true, region: [55, 20, 35, 40] },
  "callout": { copy: { text: "Keys found" }, settings: { box: [760, 380, 420, 320], color: "#ff4f9a" } },
  "price-pop": { copy: { price: "$29", text: "per month, billed yearly", label: "Launch price" } },
  "cta-end": { copy: { text: "Try Orbit free", sub: "orbit.app" } },
  "hook-slam": { copy: { text: "Stop double-booking" } },
  "caption-pop": { copy: { text: "This one change saved me two hours a week" } },
  "tip-card": { copy: { title: "Tip 1", text: "Colour-code calendars so you see your week at a glance" } },
  "progress-bar": { copy: { text: "Week planned", value: 72 } },
  "follow-cta": { copy: { text: "Follow for daily tips", handle: "@orbit" } },
  "step-list": { copy: { title: "How it works", items: ["Connect your calendars", "Pick your focus hours", "Share one link"] } },
  "diagram-build": { copy: { items: ["Idea", "Draft", "Ship"] } },
  "connector-draw": { copy: { from: "Your calendar", to: "Your team", label: "one link" } },
  "bar-chart-grow": { copy: { title: "Meetings per week", bars: [{ label: "Jan", value: 14 }, { label: "Feb", value: 11 }, { label: "Mar", value: 7 }, { label: "Apr", value: 5 }] } },
  "line-chart-draw": { copy: { title: "Hours saved", points: [2, 3, 3.5, 5, 6.5, 8], labels: ["W1", "W2", "W3", "W4", "W5", "W6"], suffix: "h" } },
  "number-counter": { copy: { value: 1200, suffix: "+", label: "teams plan with Orbit" } },
  "logo-build": { copy: { text: "Orbit" } },
  "wordmark-type": { copy: { text: "Orbit" } },
  "word-stack": { copy: { words: ["Plan", "Focus", "Ship"] } },
  "title-type": { copy: { text: "Ship every week", kicker: "Chapter one", sub: "How small teams keep shipping" } },
  "split-reveal": { copy: { text: "Plan less", sub: "Do more of what matters" } },
});
