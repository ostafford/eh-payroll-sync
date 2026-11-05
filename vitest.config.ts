import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Three projects:
 *  - "node":        the pure-logic unit tests (fast, `fetch` stubbed, no runtime).
 *  - "worker":      end-to-end consumer tests inside workerd, real local D1 + queue.
 *  - "integration": live checks against the real Connecteam / Employment Hero
 *                   accounts. NOT run by `npm test` - `npm run test:integration`,
 *                   and self-skips without CT_API_KEY / EH_API_KEY in .dev.vars.
 */
/**
 * The Worker imports clients/self/field-map.json: this deployment's own map,
 * git-ignored and different on every clone (a placeholder on a fresh one). The
 * tests swap in a fixed fixture so they pass the same everywhere, mid-tuning
 * included; `npm run validate-field-map` and the deploy check the real map.
 */
const fieldMapFixture = {
  find: /^.*\/clients\/self\/field-map\.json$/,
  replacement: path.join(import.meta.dirname, "test/fixtures/demo-field-map.json"),
};

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    test: {
      projects: [
        {
          resolve: { alias: [fieldMapFixture] },
          test: {
            name: "node",
            include: ["test/**/*.test.ts"],
            exclude: ["test/worker/**", "test/**/*.integration.test.ts"],
            environment: "node",
            setupFiles: ["./test/setup.env.ts"],
          },
        },
        {
          resolve: { alias: [fieldMapFixture] },
          test: {
            name: "integration",
            include: ["test/**/*.integration.test.ts"],
            environment: "node",
            setupFiles: ["./test/setup.env.ts"],
          },
        },
        {
          resolve: { alias: [fieldMapFixture] },
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                // Test-only binding so the setup file can apply migrations.
                bindings: { TEST_MIGRATIONS: migrations },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/worker/**/*.test.ts"],
            setupFiles: ["./test/worker/apply-migrations.ts"],
          },
        },
      ],
    },
  };
});
