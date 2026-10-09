/**
 * Eval prompts, from files (evals/prompts/README.md): each eval's first user
 * message and, optionally, text appended to the agent's system prompt.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { value } from "../lib/args";
import type { EvalConfig } from "./config";

export type EvalName = "sources" | "imports" | "migrations";
export type PromptVars = { provider?: string; file?: string; cliAccess?: string };

export type Prompts = {
  dir: string;
  /** Covers every file the eval read, so a changed prompt shows in results. */
  hash: string;
  user: (vars: PromptVars) => string;
  system: (vars: PromptVars) => string | undefined;
};

/** The folder `--prompt-dir` names, else `prompts` in evals/config.json. */
export function loadPrompts(name: EvalName, cfg: EvalConfig): Prompts {
  const dir = value("promptDir") ?? cfg.prompts;
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : undefined);
  const user = read(`${name}.user.md`);
  if (user === undefined) throw new Error(`No ${name}.user.md in ${dir}`);
  const system = read(`${name}.system.md`);
  const rules = read("session-rules.md");
  const needsRules = [user, system].some((t) => t?.includes("{{sessionRules}}"));
  if (needsRules && rules === undefined) throw new Error(`A ${name} prompt uses {{sessionRules}} but ${dir} has no session-rules.md`);

  const render = (text: string, vars: PromptVars) =>
    text.trim().replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      const v = key === "sessionRules" ? rules?.trim() : vars[key as keyof PromptVars];
      if (v === undefined) throw new Error(`${dir}: {{${key}}} has no value in the ${name} eval`);
      return v;
    });

  const hash = createHash("sha256");
  for (const t of [user, system ?? "", needsRules ? rules! : ""]) hash.update(t).update("\0");
  return {
    dir,
    hash: hash.digest("hex").slice(0, 12),
    user: (vars) => render(user, vars),
    system: (vars) => (system?.trim() ? render(system, vars) : undefined),
  };
}
