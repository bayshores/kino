// The projects screen's rows (screens.jsx ProjectsScreen), as plain data so it is easy to test.

/**
 * A test fixture: the verification projects kino's own checks make ("Media verification") and
 * the seeded motion study. They fold away under "tests" so your own projects come first.
 */
export function isTestProject(project) {
  const name = String(project?.name ?? "").trim();
  return /\bverification$/i.test(name) || name === "Motion study";
}

/**
 * The projects screen's groups: mine and tests (isTestProject), each filtered by the words in
 * `filter` (name or id), with each project's index in `projects` (the dashboard's cursor).
 * { mine: [{project, index}], tests: [{project, index}] }
 */
export function projectGroups(projects, filter = "") {
  const words = filter.trim().toLowerCase();
  const rows = (projects ?? []).map((project, index) => ({ project, index }))
    .filter(({ project }) => !words || `${project.name} ${project.id}`.toLowerCase().includes(words));
  return { mine: rows.filter(({ project }) => !isTestProject(project)), tests: rows.filter(({ project }) => isTestProject(project)) };
}
