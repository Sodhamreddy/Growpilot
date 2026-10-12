import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/*
 * Load the monorepo-root .env.
 *
 * Next only reads .env files from its own project directory (apps/web), but
 * this is a monorepo with one shared .env at the root that the worker reads
 * too. Loading it here runs before the server starts, so the values reach
 * server-side code. `override: false` means a real environment variable — what
 * a container or CI supplies — always wins over the file.
 */
const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = join(here, "..", "..");
loadEnv({ path: join(here, "..", "..", ".env"), override: false });

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep validation builds separate from the running development server.
  distDir: process.env.NEXT_BUILD_DIR || ".next",
  // Workspace packages ship TypeScript sources; Next compiles them in-place.
  transpilePackages: [
    "@ob/core", "@ob/db", "@ob/ai", "@ob/seo",
    "@ob/voice", "@ob/kb", "@ob/jobs", "@ob/pipeline", "@ob/publish",
    "@ob/blog", "@ob/social", "@ob/gmb",
  ],
  experimental: { serverActions: { bodySizeLimit: "2mb" } },

  /*
   * Keep heavy server-only dependencies out of the bundler.
   *
   * Bundling these means the compiler walks their whole dependency graph on the
   * first request to every route that touches them — which is most of the app —
   * and in development that cost is paid again after every restart. Marking
   * them external makes Node require them at runtime instead: faster to
   * compile, and closer to how they run in production.
   *
   * Only direct dependencies of this app can be listed. Under pnpm's strict
   * layout, `postgres`, `bullmq` and the AI SDKs belong to the workspace
   * packages that use them and are not resolvable from here, so externalising
   * them fails at runtime rather than helping.
   */
  serverExternalPackages: ["drizzle-orm"],
  // Not ioredis: BullMQ imports its internals ("ioredis/built/utils"), which
  // Node cannot resolve from BullMQ's own folder under pnpm, so Next bundles it
  // anyway and warns on every compile. Bundling it is what happens either way.

  /*
   * Development compiles with Turbopack (`next dev --turbopack`): about twice
   * as fast per page as webpack here, which matters in a OneDrive folder where
   * every compiled file is also synced. The webpack hook below still applies
   * to `next build`.
   *
   * The root is the monorepo, stated rather than inferred. Left to guess, Next
   * finds a stray package-lock.json in the user's home folder and treats the
   * whole home folder as the project, which is both wrong and slow. Naming it
   * here is also what tells Next a Turbopack config exists alongside webpack.
   */
  turbopack: { root: monorepoRoot },
  outputFileTracingRoot: monorepoRoot,

  webpack(config) {
    // BullMQ ships an optional Valkey client we do not install. Mark it
    // external so webpack stops warning about the unresolved import.
    config.externals = [
      ...(config.externals ?? []),
      { "@valkey/valkey-glide": "commonjs @valkey/valkey-glide" },
    ];
    return config;
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};
export default nextConfig;
