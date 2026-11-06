import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // this tells Next.js to output a standalone app at /app/.next/standalone
  //! output : standalone mode is only for web server deployment
  //? output : export while converting to static site which is required for desktop app conversion with Tauri
  output: "export",
  images: {
    unoptimized: true,
  },
  //! This tells Next.js to look inside "src" by default for build /.dist , for web server deployment
  //? and output the build files to "src/.dist" for easier packaging with Tauri desktop app
  distDir: "src/.dist",

  // ! asset prefix is only for web server deployment
  //? assetPrefix is required to be set to "./" for Tauri desktop app to load assets correctly
  assetPrefix: "./",
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
