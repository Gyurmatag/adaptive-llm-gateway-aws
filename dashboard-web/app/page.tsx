import { Dashboard } from "@/components/dashboard";

// Static shell. The SSR surface stays deliberately small: a static page plus
// one client component that opens the EventSource. No server actions on the
// live path, because Amplify does not run Next.js streaming.
export const dynamic = "force-static";

export default function Page() {
  return <Dashboard />;
}
