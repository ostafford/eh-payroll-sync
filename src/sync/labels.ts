/**
 * EH's on-screen labels for the units of a Linked employee's data (ADR-0009):
 * what the link stage asks about and the Link notice names (#230). Names
 * only, never a value.
 */
import { UNIT, type GroupUnit } from "./baseline.js";

/** EH's on-screen labels for its groups. */
const GROUP_LABEL: Record<Exclude<GroupUnit, typeof UNIT.payRun>, string> = {
  [UNIT.residentialAddress]: "Residential address",
  [UNIT.bankAccount1]: "Bank account",
  [UNIT.emergencyContact1]: "Emergency contact",
  [UNIT.super]: "Super fund",
  [UNIT.taxDeclaration]: "Tax declaration",
};

/**
 * EH's on-screen labels for the fields the field map can fill. Confirm a new
 * one against EH's UI; one missing here shows its API name.
 */
const FIELD_LABEL: Record<string, string> = {
  firstName: "First name",
  middleName: "Middle name",
  surname: "Surname",
  preferredName: "Preferred name",
  dateOfBirth: "Date of birth",
  gender: "Gender",
  emailAddress: "Email",
  mobilePhone: "Mobile",
  homePhone: "Home phone",
  title: "Title",
  residentialStreetAddress: "Street address",
  residentialAddressLine2: "Address line 2",
  residentialSuburb: "Suburb",
  residentialState: "State",
  residentialPostCode: "Postcode",
  residentialCountry: "Country",
  startDate: "Start date",
  jobTitle: "Job title",
  employmentType: "Employment type",
  emergencyContact1_Name: "Name",
  emergencyContact1_Relationship: "Relationship",
  emergencyContact1_ContactNumber: "Contact number",
  taxFileNumber: "Tax file number",
  claimTaxFreeThreshold: "Claim tax-free threshold",
  australianResident: "Australian resident",
  helpDebt: "HELP debt",
  stslDebt: "STSL debt",
  bankAccount1_AccountName: "Account name",
  bankAccount1_BSB: "BSB",
  bankAccount1_AccountNumber: "Account number",
  superFund1_ProductCode: "USI",
  superFund1_FundName: "Fund name",
  superFund1_MemberNumber: "Member number",
  superFund1_EmployerNominatedFund: "Employer nominated fund",
};

/** EH's on-screen label for one of its fields; one not listed shows its API name. */
export function fieldLabel(ehField: string): string {
  return FIELD_LABEL[ehField] ?? ehField;
}

/** EH's on-screen label for a group, or undefined for a single-field unit. */
export function groupLabel(unit: string): string | undefined {
  return GROUP_LABEL[unit as keyof typeof GROUP_LABEL];
}

/** EH's on-screen label for a unit: its group's, or its field's. */
export function unitLabel(unit: string): string {
  return groupLabel(unit) ?? fieldLabel(unit);
}
