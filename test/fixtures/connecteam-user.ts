import type { ConnecteamUser } from "../../src/mapping/apply.js";

/**
 * A synthetic Connecteam user shaped exactly like the real API response
 * (field IDs are the real ones discovered in the account; every value is fake).
 * `structuredClone` it per test and mutate as needed. `syntheticUserInEh`
 * (synthetic-user-in-eh.ts) is the same person as EH holds them: change the
 * two together.
 */
export const syntheticUser: ConnecteamUser = {
  userId: 17760356,
  firstName: "Sam",
  lastName: "Rivera",
  email: "Sam.Rivera@Example.com",
  phoneNumber: "+61411000111",
  isArchived: false,
  customFields: [
    { customFieldId: 42920713, type: "str", name: "Legal First Name", value: "Samuel" },
    { customFieldId: 42920714, type: "str", name: "Legal Surname", value: "Rivera" },
    { customFieldId: 25145118, type: "birthday", name: "Birthday", value: "07/04/1992" },
    { customFieldId: 25145119, type: "dropdown", name: "Gender", value: [{ id: 1, value: "Female" }] },
    {
      customFieldId: 25145120,
      type: "location",
      name: "Street Address",
      value: { address: "12 Example Rd, Coburg VIC 3058, Australia", latitude: -37.7, longitude: 144.9, zipcode: "3058" },
    },
    { customFieldId: 42920715, type: "str", name: "Suburb", value: "Coburg" },
    { customFieldId: 42920838, type: "dropdown", name: "State", value: [{ id: 3, value: "VIC" }] },
    { customFieldId: 42923224, type: "str", name: "Postcode", value: "3058" },
    {
      customFieldId: 42920716,
      type: "location",
      name: "Country",
      value: { address: "Australia", latitude: -25.2, longitude: 133.7 },
    },
    { customFieldId: 25145109, type: "date", name: "Employment Start Date", value: "01/09/2026" },
    { customFieldId: 25145108, type: "str", name: "Title", value: "Support Officer" },
    { customFieldId: 42920839, type: "dropdown", name: "Employee Status", value: [{ id: 0, value: "FullTime" }] },
    { customFieldId: 42708535, type: "str", name: "Emergency Contact Name", value: "Alex Rivera" },
    { customFieldId: 42708537, type: "str", name: "Emergency Contact Number", value: "0412 000 222" },
    { customFieldId: 42708536, type: "str", name: "Emergency Contact Relationship", value: "Sibling" },
    { customFieldId: 42923222, type: "str", name: "TFN", value: "123 456 782" },
    { customFieldId: 42921173, type: "str", name: "Name on Bank Account", value: "Samuel Rivera" },
    { customFieldId: 42923223, type: "str", name: "BSB", value: "012-345" },
    { customFieldId: 42921172, type: "str", name: "Account Number", value: "00123456" },
    { customFieldId: 42923276, type: "dropdown", name: "Claim tax-free threshold?", value: [{ id: 0, value: "Yes" }] },
    { customFieldId: 42923315, type: "dropdown", name: "Australian resident for tax purposes?", value: [{ id: 0, value: "Yes" }] },
    { customFieldId: 42923316, type: "dropdown", name: "Have a HELP/STSL study debt?", value: [{ id: 1, value: "No" }] },
    { customFieldId: 42920803, type: "str", name: "Super Fund USI", value: "HOS0100AU" },
    { customFieldId: 42920782, type: "str", name: "Super Fund Name", value: "Hostplus" },
    { customFieldId: 42920783, type: "str", name: "Super Fund ABN", value: "68 657 495 890" },
    { customFieldId: 42920804, type: "str", name: "Member Number", value: "M123456" },
  ],
};
