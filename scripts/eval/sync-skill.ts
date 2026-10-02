/**
 * Copies the skill from `skillSource` (evals/config.json) over the saved copy
 * in evals/skill/, and lists what changed.
 *
 *   pnpm eval:sync-skill          copy
 *   pnpm eval:sync-skill -n       show what would change, copy nothing
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { flag } from "../lib/args";
import { hashTree, loadConfig, readTree, SKILL_DIR } from "./config";

const { skillSource } = loadConfig();
if (!existsSync(skillSource)) {
  console.error(`No skill at ${skillSource} (skillSource in evals/config.json)`);
  process.exit(2);
}

const from = readTree(skillSource);
const to = readTree(SKILL_DIR);
const changes = [
  ...[...from.keys()].filter((p) => !to.has(p)).map((p) => `+ ${p}`),
  ...[...from.keys()].filter((p) => to.has(p) && !from.get(p)!.equals(to.get(p)!)).map((p) => `~ ${p}`),
  ...[...to.keys()].filter((p) => !from.has(p)).map((p) => `- ${p}`),
];

if (!changes.length) {
  console.log(`Already in sync (${hashTree(SKILL_DIR)}).`);
  process.exit(0);
}
console.log(changes.join("\n"));
if (flag("dryRun")) {
  console.log(`\n${changes.length} file(s) would change. Run without -n to copy.`);
  process.exit(0);
}
const before = hashTree(SKILL_DIR);
rmSync(SKILL_DIR, { recursive: true, force: true });
cpSync(skillSource, SKILL_DIR, { recursive: true });
console.log(`\nSynced ${changes.length} file(s): ${before} → ${hashTree(SKILL_DIR)}`);
