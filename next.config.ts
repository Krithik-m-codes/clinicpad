import type { NextConfig } from "next";

const PRESCRIPTION_FONTS = [
  "./node_modules/@fontsource/noto-sans-devanagari/400.css",
  "./node_modules/@fontsource/noto-sans-devanagari/700.css",
  "./node_modules/@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-*-{400,700}-normal.woff2",
];

// The PDF reader frame route reads pdf.js and its decoders, fonts and colour profile at runtime (ADR-0046).
const PDFJS_ASSETS = [
  "./node_modules/pdfjs-dist/build/pdf.min.mjs",
  "./node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
  "./node_modules/pdfjs-dist/wasm/*",
  "./node_modules/pdfjs-dist/standard_fonts/*",
  "./node_modules/pdfjs-dist/iccs/*",
];

const isDesktop = process.env.NEXT_BUILD_TARGET === "desktop";

const nextConfig: NextConfig = {
  ...(isDesktop
    ? {
        output: "export" as const,
        distDir: "src/.dist",
        assetPrefix: "./",
        images: { unoptimized: true },
      }
    : {
        // Route handlers read the embedded prescription fonts from node_modules at runtime (the public share route renders PDFs too).
        outputFileTracingIncludes: {
          "/prescriptions/**": PRESCRIPTION_FONTS,
          "/s/**": PRESCRIPTION_FONTS,
          "/templates/**": PRESCRIPTION_FONTS,
          "/pdf-frame/**": PDFJS_ASSETS,
        },
      }),
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
};

export default nextConfig;
