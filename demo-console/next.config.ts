import type { NextConfig } from "next";

// NOT a static export, unlike dashboard-web. This app has a server, and it has
// one for a single reason: the gateway's master key must never reach a browser
// bundle. Every call to the gateway happens in a route handler; the client only
// ever talks to this app's own /api routes.
//
// standalone: produces a self-contained server bundle so the container image is
// a Node runtime plus one directory, rather than the whole node_modules tree.
//
// basePath: the ALB routes /console* here, so the app has to own that prefix.
// Next rewrites its own routes and asset URLs; it does NOT rewrite fetch()
// calls in client code, which is why lib/base.ts exists.
const nextConfig: NextConfig = {
  output: "standalone",
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
};

export default nextConfig;
