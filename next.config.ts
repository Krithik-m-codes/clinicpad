import type { NextConfig } from "next";

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
        // Route handlers read the embedded prescription fonts from node_modules at runtime.
        outputFileTracingIncludes: {
          "/prescriptions/**": [
            "./node_modules/@fontsource/noto-sans-devanagari/400.css",
            "./node_modules/@fontsource/noto-sans-devanagari/700.css",
            "./node_modules/@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-*-{400,700}-normal.woff2",
          ],
        },
      }),
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
};

export default nextConfig;
