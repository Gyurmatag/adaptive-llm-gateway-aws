import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully static export.
  //
  // The page is already `force-static` and the only live data path is an
  // EventSource opened straight at the ECS data plane through the ALB, so
  // there is nothing for a server to do. Exporting static also means Amplify
  // serves plain files with no compute provider involved - which removes the
  // Next.js-streaming-unsupported problem entirely rather than working around
  // it, and makes a manual (zip) deployment possible without wiring Amplify
  // to GitHub over OAuth.
  output: "export",
  images: { unoptimized: true },
  /* config options here */
};

export default nextConfig;
