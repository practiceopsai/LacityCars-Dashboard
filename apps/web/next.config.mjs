/**
 * The browser only ever talks to this origin; /api/* is proxied to the API
 * service. That keeps the httpOnly session cookie same-origin (SameSite works,
 * no CORS in the browser) and hides the API's internal URL.
 * NOTE: API_URL is read when the server starts AND at build time — set it in
 * the Railway service variables for the web service.
 */
const API_URL = process.env.API_URL ?? "http://localhost:4000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@lacity/shared"],
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  // Single in-band build worker: parallel worker spawning is flaky on some
  // Windows/OneDrive setups (spawn UNKNOWN during static generation).
  experimental: { workerThreads: false, cpus: 1 },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
