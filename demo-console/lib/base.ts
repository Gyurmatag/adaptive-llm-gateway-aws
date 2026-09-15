/** The path prefix this app is mounted under, "" when it runs at the root.
 *
 *  next.config's basePath rewrites routes and asset URLs but leaves fetch()
 *  alone, so every client call goes through here. Inlined at build time.
 */
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export const api = (path: string) => `${BASE}${path}`;
