// postinstall: the Worker imports clients/self/field-map.json, which git
// ignores (it is this deployment's own data), so a fresh clone gets the
// _example placeholder to build and typecheck with. Never overwrites a map
// that is there. A deploy refuses the placeholder (scripts/deploy-config.ts);
// `npm run discover` writes the real one.
import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";

const map = "clients/self/field-map.json";
if (!existsSync(map)) {
  mkdirSync("clients/self", { recursive: true });
  copyFileSync("clients/_example/field-map.json", map, constants.COPYFILE_EXCL);
  console.log(`${map} not found - copied in the _example placeholder (npm run discover replaces it).`);
}
