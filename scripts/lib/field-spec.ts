/**
 * Every Connecteam custom field the sync reads (docs/connecteam-field-checklist.md),
 * with enough to both MATCH an existing field by name (discover) and CREATE a
 * correctly-configured one (create-fields, issue #55).
 *
 * Names, types, options, categories and permissions copy the demo account,
 * whose fields the committed clients/self/field-map.json is tuned against.
 * The award field is not here: its own stage creates it from EH's classifications
 * (npm run provision-classification-field), and the pay-run picker maps it.
 */

export type Group = "Identity" | "Address" | "Employment" | "Emergency contact" | "Tax" | "Bank" | "Super" | "Not synced";

/** What the field feeds in the field map. */
export type Target =
  | {
      kind: "field";
      eh: string;
      transform: string;
      required?: boolean;
      sensitive?: boolean;
      map?: Record<string, string>;
      default?: string;
    }
  | { kind: "taxDeclaration"; key: string }
  | { kind: "super"; key: string }
  | { kind: "none" };

export interface FieldSpec {
  /** The name a created field gets. */
  name: string;
  /** Matches the client's existing field, whatever they called it. */
  match: RegExp;
  group: Group;
  /** Created by create-fields when missing; false = optional, only used if the client has it. */
  create: boolean;
  /** What it's for, shown when the picker asks about an optional field. */
  about?: string;
  ct: {
    type: "str" | "dropdown" | "date" | "birthday" | "location" | "directManager";
    options?: string[];
    /** Other Connecteam types the sync's transform also reads (e.g. a number field for hours). */
    alsoAccepts?: string[];
    /** Why a number field won't do, added to the check's "wrong type" explanation. */
    numberNote?: string;
    /** Every option must exist (a Yes/No question needs both answers). */
    allOptionsRequired?: boolean;
    /** Category to create it under, by name; falls back to the account's first. */
    category: string;
    isRequired: boolean;
    isVisibleToUsers: boolean;
    isEditableForUsers: boolean;
  };
  /**
   * A Connecteam profile field that can stand in for it, when the human confirms
   * (the profile name may be a preferred one, and payroll needs the legal name, #70).
   */
  profile?: { key: "firstName" | "lastName"; label: string; plural: string };
  target: Target;
}

/** EH can't create the employee without it: never skipped. */
export const requiredForSync = (spec: FieldSpec): boolean => spec.target.kind === "field" && spec.target.required === true;

const PERSONAL = "Personal Details";
const COMPANY = "Company Related Info";
const TAX = "Super & TAX Information";
const PAYROLL = "Payroll Information";

const employee = (category: string, isRequired = false) => ({ category, isRequired, isVisibleToUsers: true, isEditableForUsers: true });
const adminSet = (category: string) => ({ category, isRequired: false, isVisibleToUsers: true, isEditableForUsers: false });
const YES_NO = ["Yes", "No"];
// Unlike postcode and BSB, these vary in length, so a dropped leading zero can't be put back (#116).
const NUMBER_LOSES_ZEROS =
  "A number field drops leading zeros, and this value's length varies, so the sync can't put them back.";

export const FIELD_SPEC: FieldSpec[] = [
  // --- Identity
  { name: "Legal First Name", match: /legal first name/i, group: "Identity", create: true,
    profile: { key: "firstName", label: "First name", plural: "first names" },
    ct: { type: "str", ...employee(PERSONAL) },
    target: { kind: "field", eh: "firstName", transform: "trimString", required: true } },
  { name: "Legal Surname", match: /legal surname/i, group: "Identity", create: true,
    profile: { key: "lastName", label: "Last name", plural: "last names" },
    ct: { type: "str", ...employee(PERSONAL) },
    target: { kind: "field", eh: "surname", transform: "trimString", required: true } },
  { name: "Birthday", match: /birthday|date of birth/i, group: "Identity", create: true,
    ct: { type: "birthday", ...employee(PERSONAL) },
    target: { kind: "field", eh: "dateOfBirth", transform: "dateDmyToIso", required: true } },
  // EH's API stores only Male / Female; any other value is accepted and left
  // blank (probed 2026-10-03, docs/field-mapping.md). "Other" still needs a map
  // entry, or the sync would reject it as an unknown option.
  { name: "Gender", match: /^gender/i, group: "Identity", create: true,
    ct: { type: "dropdown", options: ["Male", "Female", "Other"], ...employee(PERSONAL) },
    target: { kind: "field", eh: "gender", transform: "dropdownValue", map: { Male: "Male", Female: "Female", Other: "Indeterminate" } } },

  // --- Address
  { name: "Street Address", match: /street address/i, group: "Address", create: true,
    ct: { type: "location", ...employee(PERSONAL) },
    target: { kind: "field", eh: "residentialStreetAddress", transform: "locationStreetLine" } },
  { name: "Suburb", match: /suburb/i, group: "Address", create: true,
    ct: { type: "str", ...employee(PERSONAL) },
    target: { kind: "field", eh: "residentialSuburb", transform: "trimString" } },
  { name: "State", match: /^state/i, group: "Address", create: true,
    ct: { type: "dropdown", options: ["QLD", "NSW", "VIC", "ACT", "TAS", "SA", "WA", "NT", "INTERNATIONAL"], ...adminSet(PERSONAL) },
    target: { kind: "field", eh: "residentialState", transform: "dropdownValue" } },
  { name: "Postcode", match: /postcode|post code/i, group: "Address", create: true,
    // A number field drops the leading zero (0800 -> 800); zeroPad4 restores it (#116).
    ct: { type: "str", alsoAccepts: ["number"], ...employee(PERSONAL) },
    target: { kind: "field", eh: "residentialPostCode", transform: "zeroPad4" } },
  { name: "Country", match: /country/i, group: "Address", create: true,
    ct: { type: "location", ...employee(PERSONAL) },
    target: { kind: "field", eh: "residentialCountry", transform: "locationFull", map: { Australia: "AU" }, default: "AU" } },

  // --- Emergency contact
  { name: "Emergency Contact Name", match: /emergency contact name/i, group: "Emergency contact", create: true,
    ct: { type: "str", ...employee(PERSONAL) },
    target: { kind: "field", eh: "emergencyContact1_Name", transform: "trimString" } },
  { name: "Emergency Contact Number", match: /emergency contact (number|phone)/i, group: "Emergency contact", create: true,
    ct: { type: "str", ...employee(PERSONAL) },
    target: { kind: "field", eh: "emergencyContact1_ContactNumber", transform: "trimString" } },
  { name: "Emergency Contact Relationship", match: /emergency contact relationship/i, group: "Emergency contact", create: true,
    ct: { type: "str", ...employee(PERSONAL) },
    target: { kind: "field", eh: "emergencyContact1_Relationship", transform: "trimString" } },

  // --- Employment
  { name: "Employment Start Date", match: /employment start date|start date/i, group: "Employment", create: true,
    ct: { type: "date", ...adminSet(COMPANY) },
    target: { kind: "field", eh: "startDate", transform: "dateDmyToIso", required: true } },
  { name: "Title", match: /^title/i, group: "Employment", create: true,
    ct: { type: "str", ...adminSet(COMPANY) },
    target: { kind: "field", eh: "jobTitle", transform: "trimString" } },
  { name: "Employee Status", match: /employee status/i, group: "Employment", create: true,
    ct: { type: "dropdown", options: ["FullTime", "PartTime", "Casual", "LabourHire"], ...adminSet(COMPANY) },
    target: { kind: "field", eh: "employmentType", transform: "dropdownValue", required: true,
      map: { FullTime: "FullTime", PartTime: "PartTime", Casual: "Casual", LabourHire: "LabourHire" } } },
  // Optional (#42, #118): sent with the pay-run settings, overriding the default hours.
  { name: "Standard hours per week", match: /standard hours.*week|hours per week|weekly hours/i, group: "Employment", create: false,
    about: "Each employee's standard weekly hours, sent with their pay settings. Skip if payroll uses the default hours.",
    ct: { type: "str", alsoAccepts: ["number"], ...adminSet(COMPANY) },
    target: { kind: "field", eh: "hoursPerWeek", transform: "number" } },

  // --- Tax
  { name: "TFN", match: /^tfn|tax file number/i, group: "Tax", create: true,
    ct: { type: "str", numberNote: NUMBER_LOSES_ZEROS, ...employee(TAX) },
    target: { kind: "field", eh: "taxFileNumber", transform: "digits", required: true, sensitive: true } },
  { name: "Claim tax-free threshold?", match: /tax-?free threshold/i, group: "Tax", create: true,
    ct: { type: "dropdown", options: YES_NO, allOptionsRequired: true, ...employee(TAX, true) },
    target: { kind: "taxDeclaration", key: "claimTaxFreeThreshold" } },
  { name: "Australian resident for tax purposes?", match: /australian resident/i, group: "Tax", create: true,
    ct: { type: "dropdown", options: YES_NO, allOptionsRequired: true, ...employee(TAX, true) },
    target: { kind: "taxDeclaration", key: "australianResident" } },
  { name: "Have a HELP/STSL study debt?", match: /help.*debt|stsl|study.*debt/i, group: "Tax", create: true,
    ct: { type: "dropdown", options: YES_NO, allOptionsRequired: true, ...employee(TAX, true) },
    target: { kind: "taxDeclaration", key: "hasHelpOrStslDebt" } },

  // --- Bank
  { name: "Name on Bank Account", match: /name on bank account/i, group: "Bank", create: true,
    ct: { type: "str", ...employee(PAYROLL) },
    target: { kind: "field", eh: "bankAccount1_AccountName", transform: "trimString", sensitive: true } },
  { name: "BSB", match: /^bsb/i, group: "Bank", create: true,
    // Always 6 digits, so zeroPad6 restores a leading zero a number field drops (#116).
    ct: { type: "str", alsoAccepts: ["number"], ...employee(PAYROLL) },
    target: { kind: "field", eh: "bankAccount1_BSB", transform: "zeroPad6", sensitive: true } },
  { name: "Account Number", match: /account number/i, group: "Bank", create: true,
    ct: { type: "str", numberNote: NUMBER_LOSES_ZEROS, ...employee(PAYROLL) },
    target: { kind: "field", eh: "bankAccount1_AccountNumber", transform: "digits", sensitive: true } },

  // --- Super
  // Whole word only - a bare /usi/ also matches "Business".
  { name: "Super Fund USI", match: /\busi\b|unique superannuation identifier/i, group: "Super", create: true,
    ct: { type: "str", ...employee(TAX) },
    target: { kind: "super", key: "usiField" } },
  { name: "Super Fund ABN", match: /super.*abn/i, group: "Super", create: true,
    ct: { type: "str", ...employee(TAX) },
    target: { kind: "super", key: "abnField" } },
  { name: "Super Fund Name", match: /super fund name/i, group: "Super", create: true,
    ct: { type: "str", ...employee(TAX) },
    target: { kind: "super", key: "fundNameField" } },
  { name: "Member Number", match: /member number/i, group: "Super", create: true,
    ct: { type: "str", ...employee(TAX) },
    target: { kind: "super", key: "memberNumberField" } },

  // --- Not synced: read for the 3rd-cycle Correction escalation only.
  { name: "Direct manager", match: /direct manager/i, group: "Not synced", create: true,
    ct: { type: "directManager", ...adminSet(COMPANY) },
    target: { kind: "none" } },
];
