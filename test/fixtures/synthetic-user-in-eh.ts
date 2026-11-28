import ehRecord from "./eh-bulk-employee.json" with { type: "json" };

/**
 * `syntheticUser` (connecteam-user.ts) as EH's bulk list would hold them:
 * the same made-up details in EH's own forms (#232). Change the two together.
 */
export const syntheticUserInEh: Record<string, unknown> = {
  ...ehRecord,
  firstName: "Samuel",
  surname: "Rivera",
  dateOfBirth: "1992-04-07T00:00:00",
  gender: "Female",
  emailAddress: "Sam.Rivera@Example.com",
  mobilePhone: "0411 000 111",
  residentialStreetAddress: "12 Example Rd",
  residentialSuburb: "COBURG",
  residentialState: "VIC",
  residentialPostCode: "3058",
  residentialCountry: "Australia",
  startDate: "2026-09-01T00:00:00",
  jobTitle: "Support Officer",
  employmentType: "Full Time",
  emergencyContact1_Name: "Alex Rivera",
  emergencyContact1_ContactNumber: "0412000222",
  emergencyContact1_Relationship: "Sibling",
  taxFileNumber: "123456782",
  bankAccount1_AccountName: "Samuel Rivera",
  bankAccount1_BSB: "012345",
  bankAccount1_AccountNumber: "00123456",
  superFund1_ProductCode: "HOS0100AU",
  superFund1_FundName: "Hostplus",
  superFund1_MemberNumber: "M123456",
};
