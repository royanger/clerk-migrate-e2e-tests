/**
 * Eval settings (evals/config.json) and the saved skill copy.
 *
 * `cli` is what the agent's `clerk` runs, and what test:custom imports with: a
 * path to the CLI's cli.ts (run with bun), or a binary on PATH such as `clerk`.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

export type AgentName = "claude" | "codex";
export const AGENTS: AgentName[] = ["claude", "codex"];

export type EvalConfig = {
  cli: string;
  skillSource: string;
  /** Folder of prompt files (evals/prompts/README.md). */
  prompts: string;
  agents: Record<AgentName, { model: string; effort: string }>;
};

/** Where evals read the skill from. `pnpm eval:sync-skill` refreshes it from `skillSource`. */
export const SKILL_DIR = "evals/skill/clerk-migrate";

const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

export function loadConfig(): EvalConfig {
  const c = JSON.parse(readFileSync("evals/config.json", "utf8")) as EvalConfig;
  return { ...c, cli: expand(c.cli), skillSource: expand(c.skillSource), prompts: c.prompts ?? "evals/prompts" };
}

export { cliArgv } from "../lib/clerk-run";

/** Relative path → contents, for every file under `dir`. */
export function readTree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

/** A short content hash of a directory, so a result names the exact skill it tested. */
export function hashTree(dir: string): string {
  const h = createHash("sha256");
  for (const [path, body] of readTree(dir)) h.update(path).update("\0").update(body).update("\0");
  return h.digest("hex").slice(0, 12);
}
