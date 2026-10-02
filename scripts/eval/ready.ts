/**
 * Readiness check before an eval: is everything signed in, as the right
 * account, and do the exact flags the eval uses still work?
 *
 *   pnpm eval:ready
 *
 * Each agent gets a real first turn and a resumed turn, with the model,
 * effort and flags from evals/config.json. Neither CLI has a dry-run mode,
 * and a turn that changes no files is the nearest thing. The first turn also
 * reports which skills the agent can see, which proves the isolation: none of
 * the user's global skills may appear.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createClerkClient } from "@clerk/backend";
import { run } from "../lib/run";
import { TARGETS } from "../lib/clerk-run";
import { claudeAccount, codexAccount, createWorkspace, runTurn } from "./agents";
import { AGENTS, cliArgv, hashTree, loadConfig, SKILL_DIR } from "./config";

const cfg = loadConfig();
let failed = 0;
const line = (ok: boolean | "warn", what: string, detail: string) => {
  if (ok === false) failed++;
  console.log(`${ok === true ? "✓" : ok === "warn" ? "⚠" : "✗"} ${what.padEnd(14)} ${detail}`);
};

// ── 1. accounts ──
for (const [name, check] of [["claude", claudeAccount], ["codex", codexAccount]] as const) {
  const a = await check().catch((e: Error) => ({ ok: false, version: "?", detail: e.message }));
  line(a.ok, name, `${a.version} · ${a.detail}`);
}

// ── 2. the CLI the agent's `clerk` runs ──
const cli = await run(cliArgv(cfg.cli)[0], [...cliArgv(cfg.cli).slice(1), "migrate", "sources"], {
  ...process.env, CLERK_TELEMETRY_DISABLED: "1",
});
line(cli.code === 0, "cli", `${cfg.cli}${cli.code === 0 ? "" : ` → exit ${cli.code}: ${cli.stderr.trim().split("\n").pop()}`}`);

// ── 3. the saved skill ──
const saved = hashTree(SKILL_DIR);
if (!existsSync(join(SKILL_DIR, "SKILL.md"))) line(false, "skill", `no ${SKILL_DIR}/SKILL.md: run pnpm eval:sync-skill`);
else if (!existsSync(cfg.skillSource)) line("warn", "skill", `${saved} · skillSource ${cfg.skillSource} not found`);
else {
  const source = hashTree(cfg.skillSource);
  line(source === saved ? true : "warn", "skill", source === saved ? `${saved} · in sync with skillSource` : `${saved} · skillSource is ${source}: run pnpm eval:sync-skill to update`);
}

// ── 4. the Clerk dev instance test:custom imports into ──
const key = process.env[TARGETS.dev.key];
if (!key) line(false, "clerk", `${TARGETS.dev.key} not set: run through op (pnpm eval:ready does)`);
else {
  const n = await createClerkClient({ secretKey: key }).users.getCount().catch((e: Error) => e);
  if (n instanceof Error) line(false, "clerk", `dev instance unreachable: ${n.message}`);
  else line(n === 0, "clerk", n === 0 ? "dev instance reachable, 0 users" : `dev instance has ${n} users: run pnpm teardown`);
}

// ── 5. one real turn + one resume per agent, with the eval's flags ──
/**
 * The user's own skills, per agent. A leak loads the whole folder, so it shows
 * as most of these appearing at once; a single match is a built-in that shares
 * a name with one of yours (Claude Code ships a `code-review`, for one).
 */
const userSkills = (agent: string) =>
  new Set(
    (agent === "claude" ? [".claude/skills"] : [".agents/skills", ".codex/skills"])
      .map((d) => join(homedir(), d))
      .filter(existsSync)
      .flatMap((d) => readdirSync(d).filter((n) => !n.startsWith(".") && n !== "clerk-migrate")),
  );

const PROBE =
  "Readiness check: do not use any tools. Reply with status \"done\", questions [], sourceFile null, " +
  "and in issues the exact names of every skill available to you, one per item.";
for (const agent of AGENTS) {
  const { model, effort } = cfg.agents[agent];
  const label = `${agent} turn`;
  const root = mkdtempSync(join(tmpdir(), `eval-ready-${agent}-`));
  try {
    const ws = createWorkspace(root, agent, cfg, [], "sources");
    const first = await runTurn(agent, cfg, ws, PROBE, { access: "sources", timeoutMs: 5 * 60_000 });
    if (first.code !== 0 || !first.output || !first.sessionId) {
      line(false, label, `${model}/${effort}: exit ${first.code}, ${first.output ? "" : "no structured output, "}` +
        `${first.stderr.trim().split("\n").slice(-2).join(" ") || first.events.slice(-300)}`);
      continue;
    }
    const seen = agent === "claude" ? (first.skills ?? []) : first.output.issues;
    const mine = userSkills(agent);
    const overlap = seen.filter((s) => mine.has(s));
    const leaked = overlap.length > 1 && overlap.length >= mine.size / 2;
    const hasSkill = seen.includes("clerk-migrate");
    line(hasSkill && !leaked, label,
      `${model}/${effort}: ${first.seconds}s · sees clerk-migrate: ${hasSkill ? "yes" : "NO"} · ` +
      (leaked
        ? `LEAKED: ${overlap.length} of your ${mine.size} skills visible`
        : `isolated (${seen.length} skills${overlap.length ? `; ${overlap.join(", ")} shares a name with one of yours` : ", none of yours"})`));

    // The resume also proves the agent's `clerk` is the shim, not a real
    // binary earlier on its PATH (Codex's login shell once put Homebrew's first).
    const again = await runTurn(agent, cfg, ws,
      'Run the shell command `clerk --eval-shim`. Reply with status "done", questions [], sourceFile null, and issues ["resumed", <its exact output>].', {
        access: "sources", resume: first.sessionId, timeoutMs: 5 * 60_000,
      });
    const resumed = again.code === 0 && again.output?.issues?.[0] === "resumed" && again.sessionId === first.sessionId;
    line(resumed, `${agent} resume`, resumed ? `${again.seconds}s · same session` : `exit ${again.code}, output ${JSON.stringify(again.output)}, session ${again.sessionId}`);
    const shim = again.output?.issues?.[1]?.trim();
    line(shim === "eval-shim sources", `${agent} clerk`, shim === "eval-shim sources" ? "resolves to the eval shim" : `resolves to something else: ${JSON.stringify(shim)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nReady.");
process.exitCode = failed ? 1 : 0;
