import type { NextConfig } from "next";

const PRESCRIPTION_FONTS = [
  "./node_modules/@fontsource/noto-sans-devanagari/400.css",
  "./node_modules/@fontsource/noto-sans-devanagari/700.css",
  "./node_modules/@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-*-{400,700}-normal.woff2",
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
        },
      }),
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
};

export default nextConfig;
