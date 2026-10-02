/**
 * Verifies every credential in 1Password (op.env) by actually calling the
 * provider.
 *
 * A key that is present but wrong is worse than one that is missing — it fails
 * later, inside a seed or a test, with a provider-specific error. This makes each one
 * prove itself with the cheapest authenticated call available.
 *
 * Never prints a secret. Groups that are entirely unset are reported as
 * "not configured" rather than failed, so you can set up one provider at a time.
 *
 * Run: pnpm check:env
 */
export {};

/** `skip` = deliberately optional. `miss` = required for its provider, not set. */
type Status = "ok" | "fail" | "miss" | "skip";
type Result = { status: Status; detail: string };

const results: { group: string; check: string; result: Result }[] = [];

const has = (...keys: string[]) => keys.every((k) => (process.env[k] ?? "") !== "");

const missing = (...keys: string[]) => keys.filter((k) => (process.env[k] ?? "") === "");

async function check(
  group: string,
  name: string,
  keys: string[],
  run: () => Promise<string>,
  /** Why this one is safe to leave unset. Omit it and the check is required. */
  optional?: string,
) {
  if (!has(...keys)) {
    results.push({
      group,
      check: name,
      result: optional
        ? { status: "skip", detail: `not set — ${optional}` }
        : { status: "miss", detail: `not set: ${missing(...keys).join(", ")}` },
    });
    return;
  }
  try {
    results.push({ group, check: name, result: { status: "ok", detail: await run() } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({
      group,
      check: name,
      result: { status: "fail", detail: message.replace(/\s+/g, " ").slice(0, 110) },
    });
  }
}

// ── Turso ── one database per provider, default (unprefixed) table names ──────────
for (const [group, urlKey, tokenKey] of [
  ["Better Auth", "BA_TURSO_DATABASE_URL", "BA_TURSO_DATABASE_TOKEN"],
  ["Auth.js", "AUTHJS_TURSO_DATABASE_URL", "AUTHJS_TURSO_DATABASE_TOKEN"],
] as const) {
  await check(group, "Turso connect + tables", [urlKey, tokenKey], async () => {
    const { createClient } = await import("@libsql/client");
    const db = createClient({ url: process.env[urlKey]!, authToken: process.env[tokenKey]! });
    const { rows } = await db.execute(
      "select name from sqlite_master where type='table' and name not like 'sqlite_%'",
    );
    const names = (rows as unknown as { name: string }[]).map((r) => r.name);
    if (!names.includes("user"))
      throw new Error(`no "user" table — pnpm seed -p ${group === "Auth.js" ? "authjs" : "better-auth"} creates it`);
    const users = await db.execute('select count(*) as n from "user"');
    return `${names.length} tables; ${users.rows[0].n} users`;
  });
}

// ── Clerk ────────────────────────────────────────────────────────────────────
await check("Clerk", "secret key", ["CLERK_SECRET_KEY"], async () => {
  const { createClerkClient } = await import("@clerk/backend");
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
  return `${await clerk.users.getCount()} users in instance`;
});

// ── Supabase ─────────────────────────────────────────────────────────────────
await check("Supabase", "service/secret key", ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error) throw error;
  return `${(data as { total?: number }).total ?? "?"} users`;
});

/*
 * Only needed by `pnpm supabase:sql`, so it stays a skip when unset. Verifies
 * the token can actually see the project NEXT_PUBLIC_SUPABASE_URL points at — a
 * token scoped to a different organisation authenticates fine but cannot touch
 * this project.
 */
await check("Supabase", "management access token", ["SUPABASE_ACCESS_TOKEN", "NEXT_PUBLIC_SUPABASE_URL"], async () => {
  /*
   * Runs a trivial read-only query against the exact endpoint `pnpm
   * supabase:sql` uses. Listing projects would be the obvious probe, but that
   * needs a different permission — a fine-grained token with database_write
   * gets 403 there while being perfectly able to run SQL.
   */
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "select 1 as ok", read_only: true }),
  });

  if (response.status === 401) throw new Error("token rejected");
  if (response.status === 403)
    throw new Error(`token cannot reach project ${ref} — needs the database_write permission on its organisation`);
  if (!response.ok) throw new Error(`returned ${response.status}: ${(await response.text()).slice(0, 80)}`);
  return `can run SQL on project ${ref}`;
}, "only `pnpm supabase:sql` uses it");

// ── Firebase ─────────────────────────────────────────────────────────────────
await check("Firebase", "service account", ["FIREBASE_SERVICE_ACCOUNT_JSON"], async () => {
  let parsed: { project_id?: string; client_email?: string };
  try {
    parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!);
  } catch {
    throw new Error("not valid JSON");
  }
  const { cert, getApps, initializeApp } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  if (!getApps().length) initializeApp({ credential: cert(parsed as never) });
  await getAuth().listUsers(1);
  return `authenticated as ${parsed.client_email}`;
});

// ── Auth0 ────────────────────────────────────────────────────────────────────
await check("Auth0", "tenant domain", ["AUTH0_DOMAIN"], async () => {
  const response = await fetch(
    `https://${process.env.AUTH0_DOMAIN}/.well-known/openid-configuration`,
  );
  if (!response.ok) throw new Error(`no OIDC config at that domain (${response.status})`);
  return "reachable";
});

await check(
  "Auth0",
  "management api access",
  ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"],
  async () => {
    const tokenResponse = await fetch(`https://${process.env.AUTH0_DOMAIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: process.env.AUTH0_CLIENT_ID,
        client_secret: process.env.AUTH0_CLIENT_SECRET,
        audience: `https://${process.env.AUTH0_DOMAIN}/api/v2/`,
      }),
    });
    const token = (await tokenResponse.json()) as {
      access_token?: string;
      scope?: string;
      error_description?: string;
    };
    if (!token.access_token)
      throw new Error(
        (token.error_description ?? "no access token") +
          " — enable the Client Credentials grant under Advanced Settings, and authorise the app for the Management API",
      );

    const granted = new Set((token.scope ?? "").split(" "));
    const needed = ["create:users", "read:users", "read:connections"];
    const absent = needed.filter((s) => !granted.has(s));
    if (absent.length) throw new Error(`missing scope(s): ${absent.join(", ")}`);

    const name = process.env.AUTH0_DB_CONNECTION || "Username-Password-Authentication";
    const connectionsResponse = await fetch(
      `https://${process.env.AUTH0_DOMAIN}/api/v2/connections?name=${encodeURIComponent(name)}&strategy=auth0`,
      { headers: { authorization: `Bearer ${token.access_token}` } },
    );
    const connections = (await connectionsResponse.json()) as unknown[];
    if (!connections.length) throw new Error(`no database connection named "${name}"`);
    return `all scopes granted; connection "${name}" found`;
  },
);

// ── WorkOS ───────────────────────────────────────────────────────────────────
await check("WorkOS", "api key", ["WORKOS_API_KEY"], async () => {
  const { WorkOS } = await import("@workos-inc/node");
  const workos = new WorkOS(process.env.WORKOS_API_KEY!);
  const { data } = await workos.userManagement.listUsers({ limit: 1 });
  return data.length ? "accepted; environment has users" : "accepted; no users yet — run pnpm seed -p workos";
});

// ── Report ───────────────────────────────────────────────────────────────────
const ICON: Record<Status, string> = { ok: "PASS", fail: "FAIL", miss: "MISS", skip: " opt" };

let lastGroup = "";
console.log();
for (const { group, check: name, result } of results) {
  if (group !== lastGroup) {
    console.log(`\n${group}`);
    lastGroup = group;
  }
  console.log(`  ${ICON[result.status]}  ${name.padEnd(28)} ${result.detail}`);
}

const count = (status: Status) => results.filter((r) => r.result.status === status).length;
const failed = results.filter((r) => r.result.status === "fail");

console.log(
  `\n${count("ok")} passed, ${failed.length} failed, ` +
    `${count("miss")} not set, ${count("skip")} optional and unset.`,
);
if (failed.length) {
  console.log("\nFix these before seeding:");
  for (const f of failed) console.log(`  ${f.group} / ${f.check}: ${f.result.detail}`);
  process.exitCode = 1;
}

