/**
 * What every eval runs before its batch, so nobody has to remember to:
 *   1. the saved skill synced from skillSource (eval:setup:sync-skill)
 *   2. eval:ready, for the batch's agents
 *   3. imports and migrations only: the eval users, each provider's export and
 *      each golden key the batch grades against. A missing one is built. An
 *      out-of-date one is rebuilt only if you say yes; no keeps it and the
 *      batch goes on.
 *        users    data/users-eval.json differs from what eval:setup:users makes now
 *        export   made from other eval users or another variation (<provider>.made-from.json)
 *        golden   made with another CLI build, or from another export
 *      Each step can make the next one out of date, so they are checked in order.
 *
 *   --no-sync   leave evals/skill as it is, to test an edit to the saved copy
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { flag } from "../lib/args";
import { cliVersion } from "../lib/clerk-run";
import { run } from "../lib/run";
import { loadConfig, type AgentName } from "./config";
import { goldenFile, sha256, type GoldenKey } from "./golden";
import { EVAL_USERS, exportFile, exportStale } from "./provider-exports";

/** One setup script, its output shown as it runs. Async so the parent's pooled sockets live through it (lib/run.ts). */
function step(what: string, script: string, args: string[] = []): Promise<void> {
  console.log(`\n── ${what} ──`);
  return new Promise((resolve) => {
    const fail = (why: string) => {
      console.error(`\n${what} failed (${why}): fix it, then run the eval again.`);
      process.exit(2);
    };
    spawn("tsx", [`scripts/eval/${script}`, ...args], { stdio: ["ignore", "inherit", "inherit"] })
      .on("error", (e) => fail(e.message))
      .on("close", (code) => (code === 0 ? resolve() : fail(`exit ${code}`)));
  });
}

/** Yes/no at the terminal. No terminal, or stdin closed, counts as no: the batch keeps what it has. */
async function confirm(question: string): Promise<boolean> {
  console.log(`\n${question}`);
  if (!process.stdin.isTTY) {
    console.log("No terminal to ask: skipped.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // rl.question never settles once stdin hits EOF (teardown.ts).
    const answer = await new Promise<string | null>((done) => {
      rl.question("Rebuild? [y/N] ").then(done, () => done(null));
      rl.once("close", () => done(null));
    });
    return /^y(es)?$/i.test(answer?.trim() ?? "");
  } finally {
    rl.close();
  }
}

/** Whether data/users-eval.json differs from what the generator makes from today's users.json. */
async function usersStale(): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "eval-users-"));
  try {
    const fresh = join(dir, "users-eval.json");
    const r = await run("tsx", ["scripts/eval/generate-eval-users.ts", "--out", fresh]);
    if (r.code !== 0) {
      console.log(`⚠ could not check ${EVAL_USERS}: ${r.stderr.trim().split("\n").pop()}`);
      return false;
    }
    return !readFileSync(fresh).equals(readFileSync(EVAL_USERS));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Why `provider`'s golden key for `settings` needs building, or undefined when it is current. */
function goldenReason(settings: string, provider: string, version: string): string | undefined {
  const f = goldenFile(settings, provider);
  if (!existsSync(f)) return "missing";
  const key = JSON.parse(readFileSync(f, "utf8")) as GoldenKey;
  if (key.cliVersion !== version) return `made with CLI ${key.cliVersion}`;
  if (key.exportSha !== sha256(exportFile(provider))) return "the export changed";
}

/** @param graded - imports and migrations: the providers and golden-key settings (settingsOf) the batch grades against. */
export async function prepare(agents: AgentName[], graded?: { providers: string[]; settings: string[] }) {
  if (!flag("noSync")) await step("skill", "sync-skill.ts");
  await step("ready", "ready.ts", ["-a", agents.join(",")]);
  if (!graded) return console.log();
  const { providers, settings } = graded;

  if (!existsSync(EVAL_USERS)) await step("eval users", "generate-eval-users.ts");
  else if ((await usersStale()) && (await confirm(`${EVAL_USERS} is out of date with data/users.json (eval:setup:users).`)))
    await step("eval users", "generate-eval-users.ts");

  const noExport = providers.filter((p) => !existsSync(exportFile(p)));
  const oldExport = providers.filter((p) => !noExport.includes(p) && exportStale(p));
  const reExport = oldExport.length &&
    (await confirm(`Exports out of date, made from other eval users or another variation: ${oldExport.join(", ")} (eval:setup:provider-exports; each reseeds the provider).`));
  for (const p of [...noExport, ...(reExport ? oldExport : [])]) await step(`${p} export`, "provider-exports.ts", ["-p", p]);

  // golden.ts builds every settings combination for a provider, so a provider is the unit here.
  const version = cliVersion(loadConfig().cli);
  const reasons = new Map(providers.map((p) => [p, [...new Set(settings.map((s) => goldenReason(s, p, version)).filter(Boolean))]] as const));
  const noKey = providers.filter((p) => reasons.get(p)!.includes("missing"));
  const oldKey = providers.filter((p) => !noKey.includes(p) && reasons.get(p)!.length);
  const rebuild = oldKey.length &&
    (await confirm(`Golden keys out of date (CLI now ${version}): ${oldKey.map((p) => `${p} (${reasons.get(p)!.join(", ")})`).join(", ")} (eval:setup:golden).`));
  for (const p of [...noKey, ...(rebuild ? oldKey : [])]) await step(`${p} golden keys`, "golden.ts", ["-p", p]);
  console.log();
}
