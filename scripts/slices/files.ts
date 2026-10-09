/**
 * Import files for the slice tests, built from seed users without touching a
 * provider. Slices 1 and 2 have no `clerk migrate export`, so their tests
 * import a file they wrote themselves:
 *
 * - supabaseRows(): `auth.users` rows in exactly the shape the CLI's own
 *   `export supabase` query returns (export/supabase.ts EXPORT_QUERY): the
 *   phone without its `+`, the name in `raw_user_meta_data`, '' for no
 *   password, nulls left out.
 * - clerkCsv(): a Clerk Dashboard user export, with each password's digest and
 *   hasher.
 *
 * Real provider data is covered from slice 3 on, where the tests export from
 * the live providers.
 */
import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { clerkUsername } from "../lib/clerk-source";
import type { SeedUser } from "../lib/users";

/** One bcrypt digest per password: every seed user shares it, and cost 10 takes ~70 ms a hash. */
const digests = new Map<string, string>();
/** gotrue writes `$2a$`; bcryptjs `$2b$`. Same algorithm, so match the source. */
export function bcryptOf(password: string) {
  if (!digests.has(password)) digests.set(password, bcrypt.hashSync(password, 10).replace(/^\$2b\$/, "$2a$"));
  return digests.get(password)!;
}

/** A stable UUID per seed ID, so a rebuilt file has the same source IDs. */
export function supabaseId(u: SeedUser) {
  const h = createHash("sha256").update(u.id).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const CREATED = "2024-03-01T12:00:00.000Z";

export function supabaseRows(users: SeedUser[], password: string): Record<string, unknown>[] {
  return users.map((u) => {
    const row: Record<string, unknown> = {
      id: supabaseId(u),
      email: u.email,
      email_confirmed_at: u.email && u.emailVerified ? CREATED : null,
      encrypted_password: u.hasPassword ? bcryptOf(password) : "",
      // Supabase stores E.164 without the plus.
      phone: u.phone?.replace(/^\+/, "") ?? null,
      phone_confirmed_at: u.phone && u.phoneVerified ? CREATED : null,
      first_name: u.firstName,
      last_name: u.lastName,
      raw_user_meta_data: {
        seed_id: u.id,
        username: u.username,
        full_name: u.fullName,
        first_name: u.firstName,
        last_name: u.lastName,
        ...u.metadata?.user,
      },
      raw_app_meta_data: {
        provider: u.email ? "email" : "phone",
        providers: [u.email ? "email" : "phone", ...(u.oauth ?? [])],
        ...u.metadata?.app,
      },
      banned_until: u.banned ? "2125-01-01T00:00:00.000Z" : null,
      deleted_at: u.deleted ? CREATED : null,
      created_at: CREATED,
    };
    // The export leaves nulls out.
    return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined));
  });
}

/** The source ID a Clerk export row carries for a seed user. */
export const clerkId = (u: SeedUser) => `user_${u.id}`;

const CLERK_COLUMNS = [
  "id",
  "first_name",
  "last_name",
  "username",
  "primary_email_address",
  "unverified_email_addresses",
  "primary_phone_number",
  "unverified_phone_numbers",
  "password_digest",
  "password_hasher",
] as const;

type ClerkRow = Partial<Record<(typeof CLERK_COLUMNS)[number], string>>;

/**
 * A Dashboard-style CSV. `override` changes one row's cells, e.g. a hasher the
 * CLI must refuse.
 */
export function clerkCsv(
  users: SeedUser[],
  password: string,
  override: (u: SeedUser, row: ClerkRow) => ClerkRow = (_, row) => row,
): string {
  const quote = (v: string | undefined) => `"${(v ?? "").replaceAll('"', '""')}"`;
  const rows = users.map((u) =>
    override(u, {
      id: clerkId(u),
      first_name: u.firstName ?? undefined,
      last_name: u.lastName ?? undefined,
      username: clerkUsername(u.username),
      primary_email_address: u.email && u.emailVerified ? u.email : undefined,
      unverified_email_addresses: u.email && !u.emailVerified ? u.email : undefined,
      primary_phone_number: u.phone && u.phoneVerified ? u.phone : undefined,
      unverified_phone_numbers: u.phone && !u.phoneVerified ? u.phone : undefined,
      password_digest: u.hasPassword ? bcryptOf(password) : undefined,
      password_hasher: u.hasPassword ? "bcrypt" : undefined,
    }),
  );
  return [CLERK_COLUMNS.join(","), ...rows.map((r) => CLERK_COLUMNS.map((c) => quote(r[c])).join(","))].join("\n") + "\n";
}
