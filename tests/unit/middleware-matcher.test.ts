// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({ default: () => ({ auth: () => undefined }) }));
vi.mock("@/auth.config", () => ({ authConfig: {} }));

import { createRequire } from "node:module";
import { config } from "@/middleware";

const { pathToRegexp } = createRequire(import.meta.url)("next/dist/compiled/path-to-regexp") as { pathToRegexp: (path: string) => RegExp };

// Next anchors each matcher entry like this (path-to-regexp, whole path).
const matches = (path: string) => config.matcher.some((entry) => pathToRegexp(entry).test(path));

describe("middleware matcher", () => {
  it("guards the app pages and the template pages", () => {
    for (const path of ["/dashboard", "/patients/123", "/settings/clinic", "/templates", "/templates/new", "/templates/abc/edit", "/templates/files/abc"]) {
      expect(matches(path), path).toBe(true);
    }
  });

  it("leaves the upload endpoint out: Next buffers middleware request bodies up to 10 MB", () => {
    expect(matches("/templates/uploads")).toBe(false);
    expect(matches("/templates/uploadsx")).toBe(true);
  });

  it("does not guard public routes", () => {
    for (const path of ["/s/abc", "/login", "/api/health"]) expect(matches(path), path).toBe(false);
  });
});
