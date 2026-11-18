import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCatalogueSearch, type SearchKind } from "@/components/rx/use-catalogue-search";

type Pending = {
  url: string;
  signal: AbortSignal;
  cache: RequestCache | undefined;
  respond: (body: unknown, ok?: boolean) => void;
  fail: () => void;
};

let calls: Pending[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
          calls.push({
            url,
            signal: init.signal as AbortSignal,
            cache: init.cache,
            respond: (body, ok = true) => resolve({ ok, status: ok ? 200 : 500, json: async () => body }),
            fail: () => reject(new Error("network down")),
          });
        }),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const settle = (fn: () => void) =>
  act(async () => {
    fn();
    await vi.advanceTimersByTimeAsync(0);
  });

type Props = { kind?: SearchKind; query: string; active?: boolean };
function setup(initial: Props) {
  return renderHook((p: Props) => useCatalogueSearch(p.kind ?? "complaint", p.query, p.active ?? true), {
    initialProps: initial,
  });
}

describe("useCatalogueSearch", () => {
  it("waits for the debounce window, then fetches once with no-store", async () => {
    const { rerender } = setup({ query: "f" });
    await wait(199);
    expect(fetch).not.toHaveBeenCalled();
    rerender({ query: "fe" });
    await wait(199);
    expect(fetch).not.toHaveBeenCalled();
    await wait(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe("/api/catalogue/search?kind=complaint&q=fe");
    expect(calls[0].cache).toBe("no-store");
  });

  it("is loading with no results from the moment the query changes", async () => {
    const { result, rerender } = setup({ query: "fe" });
    await wait(200);
    await settle(() => calls[0].respond({ terms: ["FEVER"] }));
    expect(result.current).toEqual({ medicines: [], terms: ["FEVER"], loading: false, failed: false });

    rerender({ query: "fev" });
    expect(result.current.terms).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it("does not refetch when only whitespace around the query changes", async () => {
    const { rerender } = setup({ query: "fe" });
    await wait(200);
    rerender({ query: "fe " });
    rerender({ query: " fe" });
    await wait(500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("ignores a slow response that arrives after a newer one", async () => {
    const { result, rerender } = setup({ query: "a" });
    await wait(200);
    rerender({ query: "ab" });
    await wait(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].signal.aborted).toBe(true);

    await settle(() => calls[1].respond({ terms: ["NEW"] }));
    await settle(() => calls[0].respond({ terms: ["OLD"] }));
    expect(result.current.terms).toEqual(["NEW"]);
    expect(result.current.loading).toBe(false);
  });

  it("reports failure for a bad status and for a network error", async () => {
    const { result, rerender } = setup({ query: "fe" });
    await wait(200);
    await settle(() => calls[0].respond({}, false));
    expect(result.current).toMatchObject({ failed: true, loading: false, terms: [] });

    rerender({ query: "fev" });
    await wait(200);
    await settle(() => calls[1].fail());
    expect(result.current).toMatchObject({ failed: true, loading: false });
  });

  it("aborts the request on unmount", async () => {
    const { unmount } = setup({ query: "fe" });
    await wait(200);
    expect(calls[0].signal.aborted).toBe(false);
    unmount();
    expect(calls[0].signal.aborted).toBe(true);
  });

  it("drops results and loading state as soon as it becomes inactive", async () => {
    const { result, rerender } = setup({ query: "fe" });
    await wait(200);
    await settle(() => calls[0].respond({ terms: ["FEVER"] }));

    rerender({ query: "fe", active: false });
    expect(result.current).toEqual({ medicines: [], terms: [], loading: false, failed: false });

    rerender({ query: "fe", active: true });
    expect(result.current.terms).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it("does not stay loading after the query is cleared mid-flight", async () => {
    const { result, rerender } = setup({ query: "fe" });
    await wait(200);
    rerender({ query: "" });
    await wait(500);
    expect(calls[0].signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
  });

  it("searches an empty medicine query (favourites) but never an empty term query", async () => {
    setup({ kind: "medicine", query: "" });
    await wait(200);
    expect(calls[0].url).toBe("/api/catalogue/search?kind=medicine&q=");
    setup({ kind: "diagnosis", query: "  " });
    await wait(500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
