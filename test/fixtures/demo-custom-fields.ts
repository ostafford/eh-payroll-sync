/**
 * The demo account's Connecteam custom-field DEFINITIONS (no employee data),
 * read from `GET /users/v1/custom-fields` on 2026-10-03. The demo field map
 * (test/fixtures/demo-field-map.json) was tuned against exactly these.
 */
import type { CustomFieldDefinition } from "../../scripts/lib/connecteam-custom-fields.js";

const f = (customFieldId: number, name: string, type: string): CustomFieldDefinition => ({ customFieldId, name, type });

export const DEMO_CUSTOM_FIELDS: CustomFieldDefinition[] = [
  f(25145118, "Birthday", "birthday"),
  f(25145119, "Gender", "dropdown"),
  f(42920713, "Legal First Name", "str"),
  f(42920714, "Legal Surname", "str"),
  f(25145120, "Street Address", "location"),
  f(42920715, "Suburb", "str"),
  f(42920716, "Country", "location"),
  f(42920838, "State", "dropdown"),
  f(42923224, "Postcode", "str"),
  f(42708535, "Emergency Contact Name", "str"),
  f(42708537, "Emergency Contact Number", "str"),
  f(42708536, "Emergency Contact Relationship", "str"),
  f(43580607, "Test Field", "dropdown"),
  f(42923222, "TFN", "str"),
  f(42923276, "Claim tax-free threshold?", "dropdown"),
  f(42923315, "Australian resident for tax purposes?", "dropdown"),
  f(42923316, "Have a HELP/STSL study debt?", "dropdown"),
  f(42920782, "Super Fund Name", "str"),
  f(42920783, "Super Fund ABN", "str"),
  f(42920803, "Super Fund USI", "str"),
  f(42920804, "Member Number", "str"),
  f(42923223, "BSB", "str"),
  f(42921172, "Account Number", "str"),
  f(42921173, "Name on Bank Account", "str"),
  f(42921174, "Payment Method", "dropdown"),
  f(42921208, "Pay Type", "dropdown"),
  f(43504863, "EH Pay Rate Template", "dropdown"),
  f(25145108, "Title", "str"),
  f(25145109, "Employment Start Date", "date"),
  f(25145114, "Direct manager", "directManager"),
  f(42920839, "Employee Status", "dropdown"),
  f(42920893, "Employee ID", "str"),
  f(42921224, "Employee Type", "dropdown"),
];
