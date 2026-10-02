/**
 * Clerk destination configs (D1–D5 in .testing-plan.md), each a
 * `clerk config patch` body. Every one sets all four keys, so applying one
 * fully replaces whatever the previous run left behind.
 */
export const DEST_KEYS = ["auth_email", "auth_phone", "auth_username", "auth_password"] as const;

const email = (required: boolean) => ({
  used_for_sign_up: true,
  used_for_sign_in: true,
  required_for_sign_up: required,
  sign_in_strategies: ["email_code"],
  verification_strategies: ["email_code"],
});
const phone = (required: boolean) => ({
  used_for_sign_up: true,
  used_for_sign_in: true,
  required_for_sign_up: required,
  sign_in_strategies: ["phone_code"],
  verification_strategies: ["phone_code"],
});
const phoneOff = {
  used_for_sign_up: false,
  used_for_sign_in: false,
  required_for_sign_up: false,
  sign_in_strategies: [],
  verification_strategies: [],
};
const username = (on: boolean, required = false, extended = false) => ({
  used_for_sign_up: on,
  used_for_sign_in: on,
  required_for_sign_up: required,
  allow_extended_special_characters: extended,
});

export const DESTS = {
  /**
   * Everything on, nothing required: every valid user imports. Extended
   * username characters are on so dotted usernames (common in every source)
   * land; D2–D4 keep Clerk's default and so exercise that rejection.
   */
  D1: {
    auth_email: email(false),
    auth_phone: phone(false),
    auth_username: username(true, false, true),
    auth_password: { enabled: true, required: false },
  },
  /** Email + password required: phone-only and passwordless users are rejected. */
  D2: {
    auth_email: email(true),
    auth_phone: phone(false),
    auth_username: username(true),
    auth_password: { enabled: true, required: true },
  },
  /** Phone required: email-only users are rejected. */
  D3: {
    auth_email: email(false),
    auth_phone: phone(true),
    auth_username: username(true),
    auth_password: { enabled: true, required: false },
  },
  /** Username required: users without one are rejected. */
  D4: {
    auth_email: email(false),
    auth_phone: phone(false),
    auth_username: username(true, true),
    auth_password: { enabled: true, required: false },
  },
  /** Email code only (the dev instance's original config): passwords dropped. */
  D5: {
    auth_email: email(true),
    auth_phone: phoneOff,
    auth_username: username(false),
    auth_password: { enabled: false, required: false },
  },
} as const;

export type DestId = keyof typeof DESTS;
export const DEST_IDS = Object.keys(DESTS) as DestId[];
