// Whether the page is in view, for the checks made in the background, which wait while it isn't: in a browser,
// while its tab is hidden, and in the explorer's own window, while that's minimised, which the window says, as
// the page isn't told otherwise. Coming back into view, they're made straight away, rather than at their next turn.
let minimised = false;
const checks = [];

export const pageHidden = () => document.hidden || minimised;

// A check to make on coming back into view
export function whenShown(check) {
  checks.push(check);
}

function shown() {
  if (!pageHidden()) for (const check of checks) check();
}

document.addEventListener('visibilitychange', shown);

// Said by the window as it's minimised and brought back
window.kopiaExplorerMinimised = value => {
  if (value === minimised) return;
  minimised = value;
  shown();
};
