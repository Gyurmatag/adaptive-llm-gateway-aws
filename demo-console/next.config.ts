import type { NextConfig } from "next";

// NOT a static export, unlike dashboard-web. This app has API routes, and it
// has them for one reason: the gateway's master key must never reach a
// browser bundle. Every call to the gateway happens server-side here; the
// client only ever talks to this app's own /api routes.
const nextConfig: NextConfig = {};

export default nextConfig;
