/** Shown when the doctor is about to leave a page whose edits could not be saved. */
export const LEAVE_MESSAGE = "You have changes that are not saved. Leave anyway?";

/** Whether a click on this anchor would leave the current page (same origin, same tab, not just a hash move). */
function leavesPage(anchor: HTMLAnchorElement, event: MouseEvent): boolean {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (anchor.hasAttribute("download")) return false;
  const target = anchor.getAttribute("target");
  if (target && target !== "_self") return false;
  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin) return false; // a full page load: beforeunload covers it
  const here = window.location;
  return !(url.pathname === here.pathname && url.search === here.search && url.hash !== "");
}

/**
 * Next's soft navigation (links, back/forward) and server-action forms such as sign out never fire
 * `beforeunload`, and the editor's unmount cannot be relied on to save while autosave is halted, held,
 * failing or mid-save. While `atRisk()` is true this asks before the
 * page is left and cancels the navigation when the doctor declines. Returns the cleanup function.
 */
export function installLeaveGuard(atRisk: () => boolean): () => void {
  const href = window.location.href;
  // The router's history state for THIS page. After the browser has already moved back, `history.state`
  // belongs to the other entry, so it is sampled while we are still here: now, and on every interaction.
  let pageState: unknown = window.history.state;
  const sampleState = () => {
    pageState = window.history.state;
  };

  const onClick = (event: MouseEvent) => {
    sampleState();
    if (event.defaultPrevented || !atRisk()) return;
    const origin = event.target;
    if (!(origin instanceof Element)) return;
    const anchor = origin.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement) || !leavesPage(anchor, event)) return;
    if (window.confirm(LEAVE_MESSAGE)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onPopState = (event: PopStateEvent) => {
    if (!atRisk()) return;
    if (window.confirm(LEAVE_MESSAGE)) return;
    // The browser already moved: stop the router from following it and put this page's URL back.
    event.stopImmediatePropagation();
    window.history.pushState(pageState, "", href);
  };

  // Forms that leave the page without a link (sign out is a server action form) opt in with data-leave-guard.
  const onSubmit = (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-leave-guard") || !atRisk()) return;
    if (window.confirm(LEAVE_MESSAGE)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  // Capture phase so these run before the router's own handlers.
  document.addEventListener("click", onClick, true);
  document.addEventListener("submit", onSubmit, true);
  window.addEventListener("popstate", onPopState, true);
  window.addEventListener("pointerdown", sampleState, true);
  window.addEventListener("keydown", sampleState, true);
  return () => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("submit", onSubmit, true);
    window.removeEventListener("popstate", onPopState, true);
    window.removeEventListener("pointerdown", sampleState, true);
    window.removeEventListener("keydown", sampleState, true);
  };
}
