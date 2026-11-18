import { describe, expect, it } from "vitest";
import { browserFamily, overlayPrintsInBrowser, OVERLAY_BROWSER_PRINT } from "@/lib/templates/print-support";

const UA = {
  chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  iosChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1",
};

describe("browserFamily", () => {
  it("recognises the print engine, not the brand", () => {
    expect(browserFamily(UA.chrome, true)).toBe("chromium");
    expect(browserFamily(UA.edge, true)).toBe("chromium");
    expect(browserFamily(UA.firefox, false)).toBe("firefox");
    expect(browserFamily(UA.safari, false)).toBe("webkit");
    expect(browserFamily(UA.iosChrome, false)).toBe("webkit");
    expect(browserFamily("", false)).toBe("other");
  });
});

describe("OVERLAY_BROWSER_PRINT", () => {
  it("is the S1 default: Chromium prints from HTML; Firefox, WebKit and unknown browsers print the PDF (override 16)", () => {
    expect(OVERLAY_BROWSER_PRINT).toEqual({ chromium: true, firefox: false, webkit: false, other: false });
    expect(overlayPrintsInBrowser("chromium")).toBe(true);
    expect(overlayPrintsInBrowser("firefox")).toBe(false);
    expect(overlayPrintsInBrowser("webkit")).toBe(false);
    expect(overlayPrintsInBrowser("other")).toBe(false);
  });
});
