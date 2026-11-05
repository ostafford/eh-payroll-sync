/**
 * Every client's field-map, bundled into the Worker. Workers have no filesystem
 * at runtime, so each map is a static import and ends up in the deploy bundle.
 *
 * DEFAULT: one repo clone serves one client, whose map is `clients/self/`. The
 * Worker loads `self` unless `FIELD_MAP_CLIENT` names another entry here.
 * That map is git-ignored (it is the deployment's own data, like .dev.vars);
 * npm install copies in the _example placeholder, and the tests swap in
 * test/fixtures/demo-field-map.json (vitest.config.ts).
 *
 * ADD ANOTHER CLIENT (multi-tenant only):
 *   1. create clients/<slug>/field-map.json
 *   2. add an import + one entry below
 *   3. set the deployment's FIELD_MAP_CLIENT var to <slug>
 */
import selfMap from "../../clients/self/field-map.json";
import exampleMap from "../../clients/_example/field-map.json";

/** The entry used when FIELD_MAP_CLIENT is unset or blank. */
export const DEFAULT_CLIENT = "self";

export const FIELD_MAPS: Readonly<Record<string, unknown>> = {
  self: selfMap,
  _example: exampleMap,
};
