/**
 * What every live test needs from Clerk: the instances, the migrate CLI, and
 * the waits that make Clerk's listings trustworthy. Shared by test-migrate.ts
 * and test-custom-source.ts.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createClerkClient, type User } from "@clerk/backend";
import { run } from "./run";
import { pool, withRetry } from "./users";

/** argv prefix that runs a CLI: a cli.ts path runs with bun, anything else is a binary (e.g. `clerk`). */
export const cliArgv = (cli: string) => (cli.endsWith(".ts") ? ["bun", cli] : [cli]);

/**
 * Which build of the CLI ran: the checkout's commit (plus "dirty" when it has
 * uncommitted changes) for a cli.ts path, else the binary's --version.
 */
export function cliVersion(cli: string): string {
  try {
    if (!cli.endsWith(".ts")) return execFileSync(cli, ["--version"], { encoding: "utf8" }).trim().split("\n")[0];
    const git = (...a: string[]) => execFileSync("git", ["-C", dirname(cli), ...a], { encoding: "utf8" }).trim();
    return `${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain") ? " (dirty)" : ""}`;
  } catch {
    return "unknown";
  }
}

export const DEFAULT_CLI = join(
  homedir(),
  "clerk/clk/.clk/features/integrate-migration-tool-into-cli/cli/packages/cli-core/src/cli.ts",
);

/**
 * Clerk instances a run can import into. `dev` takes every test except the 10K
 * ones (and is the Clerk-as-source instance too); the other two are 10K only.
 */
export const TARGETS = {
  dev: { app: "app_3HYFnu4WUmQ1p5DS301lefhySiO", instance: "ins_3HYFnwsybLbCpZ3iqN5yt4odmrx", key: "CLERK_SECRET_KEY" },
  "10k-dev": { app: "app_3JVnO515SfI9c8lo2l3KskmG7MQ", instance: "ins_3JVnO75emwoOfD4sY7FeE5BDJFi", key: "CLERK_SECRET_KEY_10K_DEV" },
  "10k-prod": { app: "app_3JVnO515SfI9c8lo2l3KskmG7MQ", instance: "ins_3JVszqLLBrKGLYjh7Ag1f4kRGny", key: "CLERK_SECRET_KEY_10K_PROD" },
} as const;

/**
 * @param opts.cli - Path to the CLI's cli.ts (run with bun), or a binary such as `clerk`.
 * @param opts.log - File every CLI command and its stderr is appended to.
 * @param opts.env - Extra env for every CLI call.
 */
export function clerkRun(opts: { cli: string; secretKey: string; log: string; env?: Record<string, string> }) {
  const clerk = createClerkClient({ secretKey: opts.secretKey });

  /** Runs the migrate CLI; stdout is JSON under --json, stderr goes to the log. */
  async function cli(args: string[], env: Record<string, string | undefined> = {}) {
    const [bin, ...pre] = cliArgv(opts.cli);
    const result = await run(bin, [...pre, ...args], {
      // The target's key, so nothing in the CLI can fall back to another instance.
      ...process.env, CLERK_TELEMETRY_DISABLED: "1", CLERK_SECRET_KEY: opts.secretKey, ...opts.env, ...env,
    });
    appendFileSync(opts.log, `$ clerk ${args.join(" ")}\n${result.stderr}\n`);
    let json: any = null;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      /* not JSON (config commands print text) */
    }
    return { code: result.code, json, stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * Clerk's user count lags deletes by a few seconds: straight after an undo it
   * can still report users that are gone (seen live: "already has 3 users" after
   * F3's undo, 0 a moment later). Poll for up to a minute before trusting it.
   */
  async function settledCount(timeoutMs = 60_000, want = 0) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const n = await withRetry(() => clerk.users.getCount(), 8);
      if (n === want || Date.now() > deadline) return n;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  async function clerkUsers(): Promise<User[]> {
    const users: User[] = [];
    for (let offset = 0; ; offset += 500) {
      // Right after an import the instance's rate budget is spent: retry 429s.
      const { data } = await withRetry(() => clerk.users.getUserList({ limit: 500, offset }), 8);
      users.push(...data);
      if (data.length < 500) return users;
    }
  }

  /**
   * Every user with a password must actually sign in with the seed password.
   * Past 500 users (the 10K runs) a spread sample of 200 stands in for all of
   * them — 8,500 verify calls would take longer than the import.
   */
  async function verifyPasswords(users: User[], password: string) {
    const all = users.filter((u) => u.passwordEnabled);
    const step = all.length > 500 ? Math.ceil(all.length / 200) : 1;
    const withPassword = all.filter((_, i) => i % step === 0);
    const bad: string[] = [];
    await pool(withPassword, 4, async (u) => {
      const ok = await clerk.users
        .verifyPassword({ userId: u.id, password })
        .then((r) => r.verified)
        .catch((e) => {
          if (e?.status === 429) throw e; // let pool's retry handle throttling
          return false;
        });
      if (!ok) bad.push(u.id);
    });
    return { checked: withPassword.length, failed: bad };
  }

  return { clerk, cli, settledCount, clerkUsers, verifyPasswords };
}
