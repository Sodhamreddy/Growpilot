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
  serverExternalPackages: ["drizzle-orm", "ioredis"],

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
