import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Google profile pictures
    remotePatterns: [{ protocol: "https", hostname: "lh3.googleusercontent.com" }],
  },
  // Keep the pg driver out of the bundler (native optional deps).
  serverExternalPackages: ["pg"],
};

export default nextConfig;
