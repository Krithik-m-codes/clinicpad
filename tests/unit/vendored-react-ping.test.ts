import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Regression test for a React bug in the build Next.js bundles into the app (next/dist/compiled/react-dom,
 * 19.2.0-canary-0bdb9206-20250818). Fixed upstream in facebook/react#36134; scripts/patch-react-ping.mjs applies
 * that fix on install.
 *
 * The bug: a transition renders inside a Suspense boundary that is already showing content and suspends on a
 * Server Components (Flight) chunk. If the chunk's data arrives while React is yielded, React attaches its ping
 * listener to a chunk that is now "resolved_model". The Flight chunk's then() initialises it and calls the
 * listener synchronously, inside the render, while the render is already "suspended with delay". React drops
 * that ping, marks the lane suspended, and never renders it again. In the app this is a server action whose
 * revalidatePath response streams in: useActionState stays pending ("Saving…", "Uploading…") forever.
 */

const require = createRequire(import.meta.url);
const VENDORED = /[\\/]next[\\/]dist[\\/]compiled[\\/](react|react-dom|scheduler)[\\/]/;

type ReactModule = typeof import("react");
type ReactDomClient = typeof import("react-dom/client");

function loadVendoredReact(nodeEnv: "production" | "development"): { React: ReactModule; client: ReactDomClient } {
  for (const key of Object.keys(require.cache)) if (VENDORED.test(key)) delete require.cache[key];
  // The vendored entry points pick their build from NODE_ENV when first required.
  const env = process.env as Record<string, string | undefined>;
  const previous = env.NODE_ENV;
  env.NODE_ENV = nodeEnv;
  try {
    return {
      React: require("next/dist/compiled/react") as ReactModule,
      client: require("next/dist/compiled/react-dom/client") as ReactDomClient,
    };
  } finally {
    env.NODE_ENV = previous;
  }
}

/**
 * Mirrors ReactPromise in next/dist/compiled/react-server-dom-turbopack (client.browser): data that arrives with
 * no listener leaves the chunk "resolved_model"; then() initialises it and calls back synchronously.
 */
class FlightLikeChunk {
  status: "pending" | "resolved_model" | "fulfilled" = "pending";
  value: string | null = null;
  private model: string | null = null;
  private listeners: ((value: string) => void)[] = [];

  then(resolve?: (value: string) => void) {
    if (this.status === "resolved_model") this.initialize();
    if (this.status === "fulfilled") resolve?.(this.value as string);
    else if (resolve) this.listeners.push(resolve);
  }

  /** The row arrives from the network. */
  resolveModel(model: string) {
    this.status = "resolved_model";
    this.model = model;
    if (this.listeners.length > 0) {
      this.initialize();
      for (const listener of this.listeners.splice(0)) listener(this.value as string);
    }
  }

  initialize() {
    this.status = "fulfilled";
    this.value = this.model;
  }
}

function readChunk(chunk: FlightLikeChunk): string {
  if (chunk.status === "resolved_model") chunk.initialize();
  if (chunk.status === "fulfilled") return chunk.value as string;
  // While React is yielded after this throw, the row arrives (a microtask stands in for the network).
  queueMicrotask(() => chunk.resolveModel("new content"));
  throw chunk;
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnv = actEnv.IS_REACT_ACT_ENVIRONMENT;

afterEach(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = previousActEnv;
  document.body.innerHTML = "";
});

describe.each(["production", "development"] as const)("vendored React (%s build)", (nodeEnv) => {
  it("commits a transition whose Flight chunk resolves while React is yielded", async () => {
    actEnv.IS_REACT_ACT_ENVIRONMENT = false; // real scheduler, no act()
    const { React, client } = loadVendoredReact(nodeEnv);
    const h = React.createElement;
    let show: (node: unknown) => void = () => undefined;

    function Page() {
      const [content, setContent] = React.useState<unknown>("old content");
      show = (node) => React.startTransition(() => setContent(node));
      return h("p", null, content as string);
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = client.createRoot(container);
    root.render(h(React.Suspense, { fallback: h("p", null, "loading") }, h(Page)));
    expect(await waitFor(() => container.textContent === "old content", 2_000)).toBe(true);

    const chunk = new FlightLikeChunk();
    const lazy = { $$typeof: Symbol.for("react.lazy"), _payload: chunk, _init: readChunk };
    show(lazy);

    expect(await waitFor(() => container.textContent === "new content", 2_000)).toBe(true);
    root.unmount();
  });
});
