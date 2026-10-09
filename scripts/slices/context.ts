/**
 * What a slice test's checks get to work with, and the helpers they share.
 * scripts/test-slice.ts builds the context and runs the checks.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClerkClient, User } from "@clerk/backend";
import { cliArgv } from "../lib/clerk-run";
import type { SeedUser } from "../lib/users";

export type CliResult = { code: number; json: any; stdout: string; stderr: string };

export type Ctx = {
  /** The CLI under test: a cli.ts path, or a binary. */
  cliPath: string;
  /** test-results/<run>/: this run's report, log and files. */
  dir: string;
  /** clerk-runs/<run>/: the CLI's run store for this test run. */
  runsDir: string;
  /** `--app … --instance …` for the target instance. */
  target: string[];
  seed: { seedPassword: string; users: SeedUser[] };
  clerk: ClerkClient;
  /** Runs the CLI with the target's key and CLERK_EXPERIMENTAL=migrate (pass "" to turn it off). */
  cli: (args: string[], env?: Record<string, string | undefined>, timeoutMs?: number) => Promise<CliResult>;
  /** The env `cli` runs with, for a caller that spawns the CLI itself. */
  cliEnv: (extra?: Record<string, string | undefined>) => NodeJS.ProcessEnv;
  settledCount: (timeoutMs?: number, want?: number) => Promise<number>;
  clerkUsers: () => Promise<User[]>;
  verifyPasswords: (users: User[], password: string) => Promise<{ checked: number; failed: string[] }>;
  /** `clerk config patch` on the target. */
  patchDest: (body: object) => Promise<void>;
  /** Writes a file under this run's folder and returns its path. */
  write: (name: string, content: string) => string;
  log: (line: string) => void;
};

/** One check. Returns what went wrong; an empty list passes. */
export type Check = { id: string; name: string; run: (ctx: Ctx) => Promise<string[]> };

/** `clerk migrate import <file> --source <key> …` against the target, into this run's store. */
export const importFile = (ctx: Ctx, file: string, source: string, flags: string[] = [], env = {}) =>
  ctx.cli(["migrate", "import", file, "--source", source, ...flags, ...ctx.target, "--runs-dir", ctx.runsDir], env);

/** `clerk migrate undo <run> …` against the target. */
export const undo = (ctx: Ctx, runId: string, flags: string[] = []) =>
  ctx.cli(["migrate", "undo", runId, ...flags, ...ctx.target, "--runs-dir", ctx.runsDir]);

export const readRun = (ctx: Ctx, runId: string) =>
  JSON.parse(readFileSync(join(ctx.runsDir, runId, "run.json"), "utf8")) as Record<string, any>;

/** Each source ID's latest line in a run's users.ndjson. */
export function latestLines(ctx: Ctx, runId: string): Map<string, Record<string, any>> {
  const file = join(ctx.runsDir, runId, "users.ndjson");
  const latest = new Map<string, Record<string, any>>();
  if (!existsSync(file)) return latest;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    try {
      const line = JSON.parse(raw);
      latest.set(line.sourceId, line);
    } catch {
      // A torn last line, mid-write.
    }
  }
  return latest;
}

/** Run folders in the store, oldest first. */
export const runIds = (ctx: Ctx) =>
  existsSync(ctx.runsDir)
    ? readdirSync(ctx.runsDir).filter((id) => existsSync(join(ctx.runsDir, id, "run.json"))).sort()
    : [];

/** Pushes `message` when `ok` is false. */
export function want(issues: string[], ok: boolean, message: string) {
  if (!ok) issues.push(message);
}

/** The error message an agent-mode run printed, from stdout JSON or stderr JSON. */
export function errorOf(result: CliResult): string {
  for (const text of [result.stderr, result.stdout]) {
    const at = text.indexOf('{"error"');
    if (at === -1) continue;
    try {
      const parsed = JSON.parse(text.slice(at).split("\n")[0]);
      return `${parsed.error?.code ?? ""} ${parsed.error?.message ?? ""}`.trim();
    } catch {
      // Not the JSON line; fall through.
    }
  }
  return result.stderr.trim().split("\n").slice(-3).join(" ");
}

/** What landed in Clerk, in the counts the variations use. */
export function summarize(users: User[]) {
  return {
    total: users.length,
    withPassword: users.filter((u) => u.passwordEnabled).length,
    withUsername: users.filter((u) => u.username).length,
    withPhone: users.filter((u) => u.phoneNumbers.length).length,
    banned: users.filter((u) => u.banned).length,
  };
}

/** Polls Clerk until it lists `n` users (listings lag creates), then returns them. */
export async function usersWhenSettled(ctx: Ctx, n: number) {
  await ctx.settledCount(60_000, n);
  let users = await ctx.clerkUsers();
  for (let i = 0; users.length !== n && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    users = await ctx.clerkUsers();
  }
  return users;
}

/**
 * Starts an import, waits until it has created `after` users, then sends it
 * SIGINT, as Ctrl-C would. Slow it down with CLERK_MIGRATE_RATE_LIMIT so there
 * is a middle to interrupt.
 *
 * @returns The exit code (130 when it died by SIGINT) and the run it wrote.
 */
export async function interruptImport(
  ctx: Ctx,
  file: string,
  source: string,
  after: number,
  env: Record<string, string> = {},
): Promise<{ code: number | null; signal: string | null; runId?: string; created: number }> {
  const before = new Set(runIds(ctx));
  const [bin, ...pre] = cliArgv(ctx.cliPath);
  const args = ["migrate", "import", file, "--source", source, "--yes", "--allow-partial", "--json", ...ctx.target, "--runs-dir", ctx.runsDir];
  const child = spawn(bin, [...pre, ...args], { env: ctx.cliEnv(env), stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr.resume();
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );

  let runId: string | undefined;
  let created = 0;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && child.exitCode === null) {
    runId ??= runIds(ctx).find((id) => !before.has(id) && statSync(join(ctx.runsDir, id)).isDirectory());
    if (runId) created = [...latestLines(ctx, runId).values()].filter((l) => l.status === "created").length;
    if (created >= after) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill("SIGINT");
  const result = await exited;
  // Deliberate: the check presses Ctrl-C itself. Whether the exit was right is the check's call.
  ctx.log(`   (sent Ctrl-C on purpose after ${created} users were created; the CLI exited with ${result.code ?? result.signal})`);
  return { ...result, runId, created };
}

/** Died by SIGINT: 130 from a shell, or the signal itself from spawn. */
export const diedBySigint = (r: { code: number | null; signal: string | null }) =>
  r.code === 130 || r.signal === "SIGINT";
