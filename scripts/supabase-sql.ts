/**
 * Runs a .sql file against the Supabase project via the Management API.
 *
 * The sb_secret_ key cannot do this: PostgREST exposes data, not DDL. This
 * needs a personal access token (sbp_…) with the database_write permission,
 * from https://supabase.com/dashboard/account/tokens
 *
 * Run: pnpm supabase:sql <file.sql>
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: pnpm supabase:sql <file.sql>");
  process.exit(1);
}

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error(
    "SUPABASE_ACCESS_TOKEN is not set. Create one at\n" +
      "  https://supabase.com/dashboard/account/tokens\n" +
      "with the database_write permission, then add it to 1Password (op.env).",
  );
  process.exit(1);
}

// https://abcdefgh.supabase.co -> abcdefgh
const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];
const query = readFileSync(file, "utf8");

const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ query }),
});

const body = await response.text();
if (!response.ok) {
  console.error(`Failed (${response.status}): ${body}`);
  process.exit(1);
}
console.log(`Applied ${file} to project ${ref}.`);
if (body.trim() && body.trim() !== "[]") console.log(body.slice(0, 500));
