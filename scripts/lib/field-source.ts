/**
 * Where pick-fields and field-check read the client's fields from, and where
 * the picks live. `--fields-file <path>` rehearses against saved definitions
 * (#112): nothing is sent to Connecteam, and the picks go to a scratch file so
 * the deployment's clients/self/field-picks.json is never touched.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRawCustomFields, readFieldsFile, type CtGet } from "./connecteam-custom-fields.js";
import { fieldPicksPath } from "./field-picks.js";

export interface FieldSource {
  /** Set when rehearsing from a file. */
  fieldsFile?: string;
  picksPath: string;
  load(ctGet: CtGet): Promise<any[]>;
}

export function fieldSource(argv: string[]): FieldSource {
  const i = argv.indexOf("--fields-file");
  const fieldsFile = i !== -1 ? argv[i + 1] : undefined;
  if (i !== -1 && !fieldsFile) throw new Error("--fields-file needs a path");
  if (!fieldsFile) return { picksPath: fieldPicksPath("self"), load: listRawCustomFields };
  return {
    fieldsFile,
    picksPath: join(tmpdir(), "eh-field-picks.rehearsal.json"),
    load: async () => readFieldsFile(fieldsFile),
  };
}

export const rehearsalBanner = (s: FieldSource): string =>
  `Rehearsal: reading fields from ${s.fieldsFile}; nothing is sent to Connecteam.\n` +
  `Choices are kept in ${s.picksPath} (delete it to start over).\n`;
