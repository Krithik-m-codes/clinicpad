import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLeaveGuard, LEAVE_MESSAGE } from "@/components/rx/use-leave-guard";

let atRisk = true;
let remove: () => void;
let confirm: ReturnType<typeof vi.fn>;

function link(href: string, attrs: Record<string, string> = {}): HTMLAnchorElement {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  for (const [key, value] of Object.entries(attrs)) a.setAttribute(key, value);
  a.textContent = "link";
  document.body.append(a);
  return a;
}

/** Dispatches a click the way a browser does (bubbling, cancelable) and says whether the default was prevented. */
function click(target: Element, init: MouseEventInit = {}): { prevented: boolean; reachedPage: boolean } {
  let reachedPage = false;
  const spy = () => {
    reachedPage = true;
  };
  document.body.addEventListener("click", spy);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  target.dispatchEvent(event);
  document.body.removeEventListener("click", spy);
  return { prevented: event.defaultPrevented, reachedPage };
}

beforeEach(() => {
  atRisk = true;
  confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  window.history.replaceState(null, "", "/prescriptions/rx-1");
  remove = installLeaveGuard(() => atRisk);
});

afterEach(() => {
  remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("installLeaveGuard: links", () => {
  it("asks before following a same-origin link and blocks it when the doctor cancels", () => {
    const result = click(link("/patients/p-1"));
    expect(confirm).toHaveBeenCalledWith(LEAVE_MESSAGE);
    expect(LEAVE_MESSAGE).toBe("You have changes that are not saved. Leave anyway?");
    expect(result.prevented).toBe(true);
    expect(result.reachedPage).toBe(false); // propagation stopped, so the router never sees the click
  });

  it("lets the click through when the doctor confirms", () => {
    confirm.mockReturnValue(true);
    const result = click(link("/patients/p-1"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.prevented).toBe(false);
    expect(result.reachedPage).toBe(true);
  });

  it("finds the anchor from a click on a child element", () => {
    const a = link("/patients/p-1");
    const span = document.createElement("span");
    a.append(span);
    expect(click(span).prevented).toBe(true);
  });

  it("never asks when nothing is at risk", () => {
    atRisk = false;
    const result = click(link("/patients/p-1"));
    expect(confirm).not.toHaveBeenCalled();
    expect(result.prevented).toBe(false);
  });

  it.each([
    ["ctrl", { ctrlKey: true }],
    ["meta", { metaKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["middle button", { button: 1 }],
  ])("ignores a %s click (new tab or window)", (_name, init) => {
    const result = click(link("/patients/p-1"), init);
    expect(confirm).not.toHaveBeenCalled();
    expect(result.prevented).toBe(false);
  });

  it("ignores links that open elsewhere, download, or only move within the page", () => {
    for (const a of [
      link("/patients/p-1", { target: "_blank" }),
      link("/files/x.pdf", { download: "" }),
      link("#advice"),
      link("/prescriptions/rx-1#advice"),
      link("https://example.org/somewhere"),
      link("mailto:a@b.c"),
    ]) {
      expect(click(a).prevented).toBe(false);
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it("still guards a link with target _self and a link that differs only by query string", () => {
    expect(click(link("/patients/p-1", { target: "_self" })).prevented).toBe(true);
    expect(click(link("/prescriptions/rx-1?x=1")).prevented).toBe(true);
  });

  it("asks before the page's own click handler can navigate", () => {
    const a = link("/patients/p-1");
    a.addEventListener("click", (e) => e.preventDefault());
    // The page's own handler runs after ours in the bubble phase, so the guard still asks first.
    expect(click(a).prevented).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("stops asking once removed", () => {
    remove();
    expect(click(link("/patients/p-1")).prevented).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("installLeaveGuard: back and forward", () => {
  it("restores the current URL and blocks the router when the doctor cancels", () => {
    const push = vi.spyOn(window.history, "pushState");
    window.history.replaceState(null, "", "/patients/p-1"); // the browser already moved
    const routerSaw = vi.fn();
    window.addEventListener("popstate", routerSaw);
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.removeEventListener("popstate", routerSaw);
    expect(confirm).toHaveBeenCalledWith(LEAVE_MESSAGE);
    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/prescriptions/rx-1");
    expect(routerSaw).not.toHaveBeenCalled();
    push.mockRestore();
  });

  it("lets navigation happen when the doctor confirms", () => {
    confirm.mockReturnValue(true);
    const push = vi.spyOn(window.history, "pushState");
    const routerSaw = vi.fn();
    window.addEventListener("popstate", routerSaw);
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.removeEventListener("popstate", routerSaw);
    expect(push).not.toHaveBeenCalled();
    expect(routerSaw).toHaveBeenCalledTimes(1);
    push.mockRestore();
  });

  it("does not ask when nothing is at risk", () => {
    atRisk = false;
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(confirm).not.toHaveBeenCalled();
  });
});
