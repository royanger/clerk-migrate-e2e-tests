import { faker } from "@faker-js/faker";
import { isValidPhoneNumber, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

/** `n` random digits. */
export const d = (n: number) =>
  Array.from({ length: n }, () => faker.number.int({ min: 0, max: 9 })).join("");

/**
 * National mobile shapes. A shape is only a starting point: some of its ranges
 * are unassigned, so every candidate is checked with libphonenumber (the data
 * Clerk validates against) and redrawn until it passes. UK has no fictional
 * range that validates — Ofcom's drama range 07700 900xxx is rejected — so it
 * draws from real mobile ranges. Nothing here ever sends an SMS.
 *
 * These are the only non-North-American countries the test data uses; the
 * Clerk instances accept them. Add one here and it must be allowed there too.
 */
export const EUROPEAN_FORMATS: { cc: string; country: CountryCode; build: () => string }[] = [
  { cc: "+44", country: "GB", build: () => `7${d(9)}` }, // United Kingdom
  { cc: "+49", country: "DE", build: () => `151${d(8)}` }, // Germany
  { cc: "+33", country: "FR", build: () => `6${d(8)}` }, // France
  { cc: "+34", country: "ES", build: () => `6${d(8)}` }, // Spain
  { cc: "+39", country: "IT", build: () => `3${d(9)}` }, // Italy
  { cc: "+31", country: "NL", build: () => `6${d(8)}` }, // Netherlands
  // Sweden: only the standard mobile prefixes. libphonenumber-js also accepts
  // 074/075/077/078, but Clerk rejected +46787512503 as not E.164.
  { cc: "+46", country: "SE", build: () => `7${faker.helpers.arrayElement(["0", "2", "3", "6", "9"])}${d(7)}` }, // Sweden
  { cc: "+353", country: "IE", build: () => `8${faker.helpers.arrayElement(["3","5","6","7","9"])}${d(7)}` }, // Ireland
];

/** A valid E.164 mobile for one of EUROPEAN_FORMATS, redrawn until libphonenumber accepts it. */
export function europeanNumber(f: (typeof EUROPEAN_FORMATS)[number]): string {
  for (;;) {
    const candidate = `${f.cc}${f.build()}`;
    // The country check keeps +44 out of Jersey/Guernsey/Isle of Man.
    if (parsePhoneNumberFromString(candidate)?.country === f.country && isValidPhoneNumber(candidate)) return candidate;
  }
}
