/**
 * Schema for a client's `field-map.json` - the per-client artifact that says
 * which Connecteam field feeds each Employment Hero Payroll field and how to
 * transform it. Validated once at Worker start-up; a bad map fails fast.
 */
import { z } from "zod";

/** Where an employee edits their details in the Connecteam app, unless a client's field map says otherwise. */
export const DEFAULT_PROFILE_PATH = "Profile > Personal Information";

/** The closing line on every message to a person, unless a client's field map says otherwise. */
export const DEFAULT_AUTOMATED_NOTE = "This is an automated message from the Employment Hero sync.";

const source = z.union([
  z.object({ customFieldId: z.number().int().positive() }).strict(),
  z
    .object({
      userField: z.enum(["firstName", "lastName", "email", "phoneNumber", "userId"]),
    })
    .strict(),
]);

const transform = z.enum([
  "trimString",
  "lowerTrim",
  "dateDmyToIso",
  "dropdownValue",
  "phoneAu",
  "locationFull",
  "locationStreetLine",
  "digits",
  "zeroPad4",
  "zeroPad6",
  /** Non-negative JSON number, e.g. a `hoursPerWeek` custom field (issue #42). */
  "number",
]);

export const fieldRule = z
  .object({
    /** Target field name on the Employment Hero unstructured employee model. */
    eh: z.string().min(1),
    from: source,
    transform,
    /** When true, a missing/blank source value is a mapping issue, not a skip. */
    required: z.boolean().default(false),
    /** Optional value lookup applied after `transform` (e.g. dropdown -> EH enum). */
    map: z.record(z.string()).optional(),
    /** Used verbatim when the source value is absent. Skips `transform`. */
    default: z.string().optional(),
    /** Marks TFN / bank values - never logged, never read back. */
    sensitive: z.boolean().default(false),
  })
  .strict();

const yesNoSource = z
  .object({
    customFieldId: z.number().int().positive(),
    /**
     * The client's own answer wording (#112), e.g. "Yes, claim tax free threshold" -> "yes".
     * When set, only these answers count; any other (N/A, TBC) is held for a Correction.
     * Absent: the answer must be Yes or No, in any case.
     */
    options: z.record(z.enum(["yes", "no"])).optional(),
  })
  .strict();

export const rules = z
  .object({
    /** Connecteam Yes/No dropdowns that feed the EH tax file declaration. */
    taxDeclaration: z
      .object({
        claimTaxFreeThreshold: yesNoSource,
        australianResident: yesNoSource,
        hasHelpOrStslDebt: yesNoSource,
      })
      .strict()
      .optional(),
    /** Connecteam custom fields holding super fund details (APRA or SMSF). */
    super: z
      .object({
        usiField: z.number().int().positive(),
        abnField: z.number().int().positive(),
        fundNameField: z.number().int().positive(),
        memberNumberField: z.number().int().positive(),
      })
      .strict()
      .optional(),
    /** Fixed values folded verbatim into every payload. */
    constants: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    /**
     * Employees whose answer to a Connecteam dropdown is one of `values` are left
     * out of the sync entirely: no EH record, no message (e.g. an employee type
     * that isn't paid through payroll). Picked in the wizard's field check.
     */
    exclude: z
      .array(z.object({ customFieldId: z.number().int().positive(), values: z.array(z.string().min(1)).min(1) }).strict())
      .optional(),
  })
  .strict();

export const fieldMap = z
  .object({
    client: z.string().min(1),
    connecteam: z.object({ onboardingPackId: z.number().int().positive() }).strict(),
    employmentHero: z
      .object({
        businessId: z.string().min(1),
        /**
         * Reference only, and optional. The numeric pay-schedule / location IDs
         * `scripts/discover.ts` finds for the business - handy when filling in
         * `defaults` below, which names the same schedule/location. NOT sent to
         * Employment Hero (issue #34 - the unstructured endpoint ignores these
         * key names) and no longer read by the Worker (issue #26 retired the
         * `EH_PAY_SCHEDULE_ID` / `EH_LOCATION_ID` env vars they used to seed).
         * Pay-run settings that actually apply go in `defaults`, BY NAME.
         */
        payScheduleId: z.string().min(1).optional(),
        locationId: z.string().min(1).optional(),
        /**
         * Company-wide pay-run settings, stamped on every payload (issue #26).
         * Fully opt-in: omit the block and nothing changes (records land
         * `Incomplete` and a payroll admin finishes them by hand). Field names
         * verified against the live unstructured endpoint
         * (`docs/eh-pay-defaults.md`): EH takes pay schedule / location / pay
         * category / award BY NAME and validates the set **all-or-nothing** -
         * a partial set is a 400, so provide a complete working set - the
         * "location axis" (`paySchedule` + `primaryLocation` +
         * `primaryPayCategory`) plus a "rate axis": **either** `rate` +
         * `rateUnit` **or** `payRateTemplate` (an award classification - EH
         * derives the rate from it) - plus optional hours / award, or none of it.
         */
        defaults: z
          .object({
            /** Pay schedule, by NAME (e.g. "Weekly"). */
            paySchedule: z.string().min(1).optional(),
            /** Primary location, by NAME (e.g. "Head Office"). */
            primaryLocation: z.string().min(1).optional(),
            /** Primary pay category, by NAME (e.g. "Permanent Ordinary Hours"). */
            primaryPayCategory: z.string().min(1).optional(),
            rate: z.number().nonnegative().optional(),
            /** e.g. "Hourly", "Annually". */
            rateUnit: z.string().min(1).optional(),
            hoursPerWeek: z.number().positive().optional(),
            hoursPerDay: z.number().positive().optional(),
            /** Award name/id (validated against the business). */
            awardId: z.union([z.string().min(1), z.number()]).optional(),
            /**
             * Award pay-rate template, by NAME (issue #39), e.g.
             * "General Retail Casual L3 21yrs & over". This IS the award
             * classification. EH fills `rate` + `rateUnit` from it, so it
             * satisfies the rate axis on its own. Use this for a
             * single-classification workforce; for a per-employee classification
             * use `employmentHero.payRateTemplate` + a `fields[]` rule below.
             */
            payRateTemplate: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        /**
         * Opt-in: source each employee's `rate` + `rateUnit` from the Connecteam
         * pay-rates API (`GET /pay-rates/v1/pay-rates`) instead of a flat
         * company-wide `defaults.rate` (issue #42). Present = on; absent = the
         * record's `rate` stays unset and EH marks it `Incomplete` as before.
         *
         * When on, the full pay-run set EH validates all-or-nothing
         * (`paySchedule` + `primaryLocation` + `primaryPayCategory` from
         * `defaults`, plus `rate` + `rateUnit` from the API) must resolve for
         * EVERY employee, or the sync sends no pay-run keys at all and raises one
         * follow-up naming the employee / the missing config. `hoursPerWeek` is
         * optional and comes from a per-employee `number` field rule.
         */
        perEmployeeRate: z
          .object({ source: z.literal("connecteamPayRate") })
          .strict()
          .optional(),
        /**
         * Opt-in (issue #39): this client pays under an Employment Hero award and
         * each employee's classification is a Connecteam field. Add a `fields[]`
         * rule with `eh: "payRateTemplate"` pointing at that (admin-completed)
         * Connecteam field - its value is the award pay-rate template NAME, e.g.
         * "General Retail Casual L3 21yrs & over". EH derives `rate` + `rateUnit`
         * from the template, so any configured `rate` / `rateUnit` is dropped and
         * the rate axis is satisfied by the template alone.
         *
         * All-or-nothing, like `perEmployeeRate`: the location axis
         * (`paySchedule` + `primaryLocation` + `primaryPayCategory` from
         * `defaults`) plus a resolved template must be present for EVERY
         * employee, or the sync sends no pay-run keys and raises one follow-up.
         * Mutually exclusive with `perEmployeeRate` (both fill the rate axis).
         */
        payRateTemplate: z
          .object({ source: z.literal("connecteamField") })
          .strict()
          .optional(),
      })
      .strict()
      .refine((eh) => !(eh.perEmployeeRate && eh.payRateTemplate), {
        message:
          "perEmployeeRate and payRateTemplate are mutually exclusive - pick one rate source",
      }),
    identity: z
      .object({
        externalIdFrom: z.literal("userId").default("userId"),
        emailFallbackFrom: z.literal("email").default("email"),
      })
      .strict()
      .default({ externalIdFrom: "userId", emailFallbackFrom: "email" }),
    fields: z.array(fieldRule).min(1),
    rules: rules.optional(),
    /**
     * Optional employee-facing messages (issue #71). `employeeSuccess`: a one-off
     * DM on the employee's first successful sync and when a Correction is
     * fixed. On unless a client sets it to false. `adminSuccess`: a ✅ in the
     * admin channel at those same two moments. `profilePath`: where in the
     * Connecteam app an employee edits their details, named in every
     * Correction message (sections are the client's own choice).
     * `automatedNote`: the closing line on every message to an employee or
     * manager, saying it was sent automatically; "" for none.
     */
    messages: z
      .object({
        employeeSuccess: z.boolean().default(true),
        adminSuccess: z.boolean().default(true),
        profilePath: z.string().trim().min(1).default(DEFAULT_PROFILE_PATH),
        automatedNote: z.string().trim().max(120).default(DEFAULT_AUTOMATED_NOTE),
      })
      .strict()
      .default({
        employeeSuccess: true,
        adminSuccess: true,
        profilePath: DEFAULT_PROFILE_PATH,
        automatedNote: DEFAULT_AUTOMATED_NOTE,
      }),
  })
  .strict();

export type FieldMap = z.infer<typeof fieldMap>;
export type FieldRule = z.infer<typeof fieldRule>;
export type Rules = z.infer<typeof rules>;
export type TransformName = z.infer<typeof transform>;

/** Each schema problem as `path: message`; empty when the map is valid. */
export function fieldMapIssues(json: unknown): string[] {
  const result = fieldMap.safeParse(json);
  if (result.success) return [];
  return result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

export function parseFieldMap(json: unknown): FieldMap {
  const result = fieldMap.safeParse(json);
  if (!result.success) {
    const lines = fieldMapIssues(json).map((l) => `  ${l}`);
    throw new Error(`Invalid field-map:\n${lines.join("\n")}`);
  }
  return result.data;
}
