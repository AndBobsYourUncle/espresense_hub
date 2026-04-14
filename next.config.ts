import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // Suppress the "Encountered unexpected file in NFT list" warning for
    // `next.config.ts` itself. The tracer can't statically narrow our
    // `path.resolve(process.cwd(), ...)` call in `src/lib/config/load.ts`
    // (cwd is intentionally runtime-dynamic — the config file location
    // varies per deploy target), so it falls back to tracing the whole
    // project as a precaution. The bloat is cosmetic — this config file is
    // a handful of bytes — but the warning is noise. `turbopackIgnore`
    // comments don't apply to filesystem operations, only to dynamic
    // require()/import(), so the standalone-suppression escape hatch is
    // the correct remedy for this legitimate-but-untraceable pattern.
    ignoreIssue: [
      {
        path: "**/next.config.ts",
        title: "Encountered unexpected file in NFT list",
      },
    ],
  },
};

export default nextConfig;
