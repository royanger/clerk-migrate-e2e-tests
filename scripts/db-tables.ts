/** Lists the tables and row counts in both Turso databases. `pnpm db:tables` */
import { createClient } from "@libsql/client";

const DATABASES = [
  ["better-auth", "BA_TURSO_DATABASE_URL", "BA_TURSO_DATABASE_TOKEN"],
  ["authjs", "AUTHJS_TURSO_DATABASE_URL", "AUTHJS_TURSO_DATABASE_TOKEN"],
] as const;

for (const [label, urlKey, tokenKey] of DATABASES) {
  const db = createClient({ url: process.env[urlKey]!, authToken: process.env[tokenKey]! });
  const { rows } = await db.execute(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name",
  );

  const counts: Record<string, number> = {};
  for (const { name } of rows as unknown as { name: string }[]) {
    const r = await db.execute(`select count(*) as n from "${name}"`);
    counts[name] = Number(r.rows[0].n);
  }
  console.log(`\n── ${label} ──`);
  console.table(counts);
}
