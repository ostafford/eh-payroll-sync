import { describe, it, expect } from "vitest";
import {
  TransformError,
  trimString,
  lowerTrim,
  dateDmyToIso,
  zeroPad,
  digits,
  dropdownValue,
  locationField,
  phoneAu,
  mapEnum,
  yesNo,
  decimalNumber,
} from "../src/mapping/transforms.js";

describe("trimString / lowerTrim", () => {
  it("trims surrounding whitespace", () => {
    expect(trimString("  Stafford ")).toBe("Stafford");
    expect(lowerTrim("  Okky.Stafford@Example.COM ")).toBe("okky.stafford@example.com");
  });
  it("rejects non-strings and blanks", () => {
    expect(() => trimString(null)).toThrow(TransformError);
    expect(() => trimString("   ")).toThrow(TransformError);
    expect(() => trimString(42)).toThrow(TransformError);
  });
});

describe("dateDmyToIso", () => {
  it("converts DD/MM/YYYY to ISO", () => {
    expect(dateDmyToIso("20/11/1990")).toBe("1990-11-20");
    expect(dateDmyToIso("03/03/2026")).toBe("2026-03-03");
  });
  it("accepts single-digit day/month", () => {
    expect(dateDmyToIso("3/3/2026")).toBe("2026-03-03");
  });
  it("rejects ISO input, impossible dates and junk", () => {
    expect(() => dateDmyToIso("2026-03-03")).toThrow(TransformError);
    expect(() => dateDmyToIso("31/02/2020")).toThrow(TransformError);
    expect(() => dateDmyToIso("01/13/2020")).toThrow(TransformError);
    expect(() => dateDmyToIso("")).toThrow(TransformError);
    expect(() => dateDmyToIso(null)).toThrow(TransformError);
  });
});

describe("zeroPad", () => {
  it("pads shorter numeric strings", () => {
    expect(zeroPad("663123", 6)).toBe("663123");
    expect(zeroPad("812", 6)).toBe("000812");
    expect(zeroPad(3065, 4)).toBe("3065");
    expect(zeroPad(810, 4)).toBe("0810");
  });
  it("rejects over-length and non-digits", () => {
    expect(() => zeroPad("1234567", 6)).toThrow(TransformError);
    expect(() => zeroPad("12a", 6)).toThrow(TransformError);
    expect(() => zeroPad("", 6)).toThrow(TransformError);
    expect(() => zeroPad(null, 6)).toThrow(TransformError);
  });
});

describe("digits", () => {
  it("strips spaces and hyphens, keeps leading zeros", () => {
    expect(digits("123 456 789")).toBe("123456789");
    expect(digits("012-345")).toBe("012345");
    expect(digits("  0093 ")).toBe("0093");
    expect(digits(842959736)).toBe("842959736");
  });
  it("rejects values with letters or nothing left", () => {
    expect(() => digits("12a34")).toThrow(TransformError);
    expect(() => digits("")).toThrow(TransformError);
    expect(() => digits("--")).toThrow(TransformError);
  });
});

describe("dropdownValue", () => {
  it("reads the value from a single-select Connecteam dropdown", () => {
    expect(dropdownValue([{ id: 0, value: "Male" }])).toBe("Male");
    expect(dropdownValue([{ id: 3, value: "VIC" }])).toBe("VIC");
  });
  it("tolerates an already-plain string", () => {
    expect(dropdownValue("FullTime")).toBe("FullTime");
  });
  it("rejects empty, multi-select and wrong shapes", () => {
    expect(() => dropdownValue([])).toThrow(TransformError);
    expect(() => dropdownValue([{ id: 1, value: "A" }, { id: 2, value: "B" }])).toThrow(TransformError);
    expect(() => dropdownValue(null)).toThrow(TransformError);
    expect(() => dropdownValue([{ id: 1 }])).toThrow(TransformError);
  });
});

describe("locationField", () => {
  const loc = { address: "425 Smith St, Fitzroy VIC 3065, Australia", latitude: -37.79, longitude: 144.98, zipcode: "3065" };
  it("returns the full address or just the street line", () => {
    expect(locationField(loc, "full")).toBe("425 Smith St, Fitzroy VIC 3065, Australia");
    expect(locationField(loc, "streetLine")).toBe("425 Smith St");
  });
  it("rejects a location object with no address", () => {
    expect(() => locationField({ latitude: 1, longitude: 2 }, "full")).toThrow(TransformError);
    expect(() => locationField(null, "full")).toThrow(TransformError);
  });
});

describe("phoneAu", () => {
  it("normalises Australian numbers to E.164", () => {
    expect(phoneAu("+61411687336")).toBe("+61411687336");
    expect(phoneAu("0411687336")).toBe("+61411687336");
    expect(phoneAu("0411 687 336")).toBe("+61411687336");
    expect(phoneAu("+61 411 687 336")).toBe("+61411687336");
    expect(phoneAu("(03) 9123 4567")).toBe("+61391234567");
  });
  it("drops a (0) typed after the country code, as dialled", () => {
    expect(phoneAu("+61 (0)411 687 336")).toBe("+61411687336");
  });
  it("keeps a well-formed non-AU international number as-is", () => {
    expect(phoneAu("+1 415 555 0100")).toBe("+14155550100");
  });
  it("rejects numbers it cannot make sense of", () => {
    expect(() => phoneAu("not a phone")).toThrow(TransformError);
    expect(() => phoneAu("12345")).toThrow(TransformError);
    expect(() => phoneAu("")).toThrow(TransformError);
  });
});

describe("mapEnum", () => {
  const table = { FullTime: "FullTime", PartTime: "PartTime", Casual: "Casual", LabourHire: "LabourHire" };
  it("maps known values", () => {
    expect(mapEnum("Casual", table)).toBe("Casual");
  });
  it("throws listing the allowed inputs on an unknown value", () => {
    expect(() => mapEnum("Contractor", table)).toThrow(/FullTime.*PartTime.*Casual.*LabourHire/s);
  });
});

describe("yesNo", () => {
  it("reads Yes/No from a dropdown or a plain string", () => {
    expect(yesNo([{ id: 0, value: "Yes" }])).toBe(true);
    expect(yesNo([{ id: 1, value: "No" }])).toBe(false);
    expect(yesNo("Yes")).toBe(true);
    expect(yesNo("No")).toBe(false);
  });
  it("rejects anything else", () => {
    expect(() => yesNo("maybe")).toThrow(TransformError);
    expect(() => yesNo([])).toThrow(TransformError);
  });
});

describe("decimalNumber", () => {
  it("accepts a number or a numeric string, keeping the numeric type", () => {
    expect(decimalNumber(38)).toBe(38);
    expect(decimalNumber("38")).toBe(38);
    expect(decimalNumber(" 7.6 ")).toBe(7.6);
    expect(decimalNumber(0)).toBe(0);
  });
  it("rejects non-numbers and negatives", () => {
    expect(() => decimalNumber("full-time")).toThrow(TransformError);
    expect(() => decimalNumber("")).toThrow(TransformError);
    expect(() => decimalNumber(-1)).toThrow(TransformError);
    expect(() => decimalNumber(null)).toThrow(TransformError);
  });
});
