/**
 * Eval: can an agent, given only the clerk-migrate skill and one export, write
 * a custom source that imports the users correctly?
 *
 *   pnpm eval:sources --set clear-correct
 *   pnpm eval:sources --set clueless -a claude
 *   pnpm eval:sources --set mixed --agent-cli dry-run -a codex --exports gatekeep.csv,vaultrun.json
 *
 *   --set <name>            answer set in evals/answer-sets/ (required)
 *   --agent-cli <level>     what the agent's `clerk` may run: none (default), sources, dry-run
 *   -a, --agent <a[,b]>     claude, codex, or both comma-separated (default: both, Claude first)
 *   --exports <a,b>         default: all 8
 *
 * Per run (agent × export), in a temp workspace holding only the export and
 * the skill:
 *   agent turn → questions? answer from the set (or ask you) → resume → … →
 *   source written → test:custom grades it → result.md
 *
 * Writes evals/runs/<stamp>-<set>/{summary.md, summary.json, <agent>/<export>/…}.
 * Each run's folder also holds test:custom's report (test-custom/) and the
 * CLI's own import and undo runs (clerk-runs/).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { run } from "../lib/run";
import { clerkRun, cliVersion, pinCli, SetupError } from "../lib/clerk-run";
import { claimTarget, targetArgs, targetEnv } from "../lib/targets";
import { configForUsers, withBaseline } from "../lib/clerk-dest";
import { value } from "../lib/args";
import type { Grade } from "../lib/grade";
import type { AnswerKey } from "../generate-custom-exports";
import { claudeAccount, codexAccount, CLI_ACCESS, createWorkspace, type CliAccess, type TurnOutput } from "./agents";
import { loadSet, loadTopics, setsDir } from "./answers";
import { loadPrompts } from "./prompts";
import { answerer, contamination, counts, minutes, qaMarkdown, runSession, type QA } from "./session";
import { AGENTS, hashTree, loadConfig, SKILL_DIR, type AgentName } from "./config";

const EXPORTS = ["keyhole", "passly", "gatekeep", "vaultrun", "frostline", "nimbus"].flatMap((n) => [`${n}.json`, `${n}.csv`]);
/** Question rounds before the run is called stuck. */

// ── arguments ──

const usage = "Usage: pnpm eval:sources --set <name> [-a claude|codex] [--agent-cli none|sources|dry-run] [--exports a.json,b.csv]";
const setName = value("set");
const access = (value("agentCli") ?? "none") as CliAccess;
const agents = (value("agents")?.split(",") ?? AGENTS) as AgentName[];
const exports = value("exports")?.split(",") ?? EXPORTS;
const bad = [
  !setName && "--set is required",
  !CLI_ACCESS.includes(access) && `--agent-cli must be one of ${CLI_ACCESS.join(", ")}`,
  ...agents.filter((a) => !AGENTS.includes(a)).map((a) => `unknown agent "${a}"`),
  ...exports.filter((e) => !EXPORTS.includes(e)).map((e) => `unknown export "${e}" (have ${EXPORTS.join(" ")})`),
].filter(Boolean);
if (bad.length) {
  console.error(`${bad.join("\n")}\n${usage}`);
  process.exit(2);
}

const cfg = loadConfig();
const SETS = setsDir("sources");
const answers = answerer(loadSet(setName!, SETS), loadTopics(SETS));
const set = answers.set;

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const batchDir = resolve("evals/runs", `${stamp}-${set.name}`);
mkdirSync(batchDir, { recursive: true });
// Every run in the batch is graded on this one build, whatever happens to the checkout meanwhile.
cfg.cli = pinCli(cfg.cli, join(batchDir, "cli"));
const repoRoot = process.cwd();

// Only `dry-run` lets the agent touch Clerk, and its dry run should see an
// instance set up for these users, as a real customer's would be.

// ── one run ──

const ACCESS_LINE: Record<CliAccess, string> = {
  none: "The `clerk` CLI is not available in this session. Do not try to run it.",
  sources: "In this session `clerk migrate sources <file>` is available to check that your source loads. No other `clerk` command is.",
  "dry-run":
    "In this session `clerk migrate sources <file>` and `clerk migrate import <file> --source <source> --dry-run` " +
    "are available, against a test instance already configured for these users. Importing is not.",
  import: "The `clerk` CLI is available and points at the customer's Clerk instance.",
  migrate: "The `clerk` CLI is available and points at the customer's Clerk instance.",
};

const prompts = loadPrompts("sources", cfg);

type Result = {
  agent: AgentName;
  export: string;
  model: string;
  effort: string;
  status: TurnOutput["status"] | "error" | "stuck";
  rounds: number;
  seconds: number;
  qa: QA[];
  issues: string[];
  sourceFile?: string;
  contaminated: string[];
  grade?: Grade;
  gradeError?: string;
  testReport?: string;
  setVersion: number;
  /** The CLI build test:custom graded with. */
  cliVersion?: string;
  /** Set when setup failed: nothing was graded, so it is not an F. */
  notRun?: string;
  /** The Clerk target (evals/targets.json) the run claimed. */
  target?: string;
  /** What test:custom graded as notes, because the agent was never told (lib/grade.ts Lenient). */
  lenient?: string[];
};

/**
 * The grade column: "—" when setup failed, "blocked" when the agent stopped
 * itself and left nothing to grade (refusing a wrong answer is not a fail),
 * else the grade.
 */
const gradeCell = (r: Result) =>
  r.notRun ? "—" : r.status === "blocked" && !r.grade ? "blocked" : (r.grade?.grade ?? "F");

/** The source the agent wrote: the file it named, else the newest .ts/.js it created. */
function findSource(wsDir: string, named: string | null | undefined): string | undefined {
  if (named) {
    const p = isAbsolute(named) ? named : join(wsDir, named);
    if (existsSync(p) && !relative(wsDir, p).startsWith("..")) return p;
  }
  return readdirSync(wsDir)
    .filter((f) => /\.(ts|js|mjs)$/.test(f))
    .map((f) => join(wsDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const MARKERS = ["custom-sources-answers", "answer-sets", "expected.json", "evals/runs"];

async function runOne(agent: AgentName, exportName: string): Promise<Result> {
  const provider = exportName.split(".")[0];
  const dir = join(batchDir, agent, exportName);
  mkdirSync(dir, { recursive: true });
  const { model, effort } = cfg.agents[agent];
  const result: Result = {
    agent, export: exportName, model, effort, status: "error", rounds: 0, seconds: 0,
    qa: [], issues: [], contaminated: [], setVersion: answers.set.version,
  };
  const root = mkdtempSync(join(tmpdir(), `eval-${agent}-${provider}-`));
  const transcript = join(dir, "transcript.jsonl");
  const started = Date.now();
  // One pool target for the agent's dry runs and test:custom's grading.
  let claim: Awaited<ReturnType<typeof claimTarget>> | undefined;

  try {
    claim = await claimTarget(`eval:sources ${stamp} ${agent}/${exportName}`);
    result.target = claim.target.name;
    const key = JSON.parse(readFileSync(`data/custom-sources-answers/${provider}.expected.json`, "utf8")) as AnswerKey;
    if (access === "dry-run") {
      const clerk = clerkRun({ cli: cfg.cli, secretKey: claim.target.secretKey, log: join(batchDir, "clerk.log") });
      await clerk.patchConfig(targetArgs(claim.target), withBaseline(configForUsers(key.users)));
    }
    const ws = createWorkspace(root, agent, cfg, [resolve("data/custom-sources", exportName)], access, claim.target.secretKey);

    const vars = { file: exportName, provider, cliAccess: ACCESS_LINE[access] };
    const s = await runSession({
      agent, cfg, ws, access, prompt: prompts.user(vars), system: prompts.system(vars), provider,
      label: `${agent} · ${exportName}`, answers, transcript,
    });
    Object.assign(result, { status: s.status, rounds: s.rounds, qa: s.qa, issues: s.issues });

    const source = findSource(ws.dir, s.output?.sourceFile);
    if (source) {
      result.sourceFile = `source${source.match(/\.\w+$/)![0]}`;
      copyFileSync(source, join(dir, result.sourceFile));
    }
  } catch (error) {
    result.issues.push(`runner: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof SetupError) result.notRun = String(error.message);
  } finally {
    result.seconds = Math.round((Date.now() - started) / 1000);
    rmSync(root, { recursive: true, force: true });
  }

  result.contaminated = existsSync(transcript) ? contamination(readFileSync(transcript, "utf8"), MARKERS) : [];

  // ── grade with test:custom ──
  // What the agent was never told (no answer, a fallback, or an "unknown" one) is graded as a note.
  const told = (topic: string) =>
    result.qa.some((q) => q.topics.includes(topic) && q.by !== "fallback" && !q.tags.includes(`${topic}: unknown`));
  result.lenient = [
    ...(told("email-verification") ? [] : ["email"]),
    ...(told("phone-verification") ? [] : ["phone"]),
    ...(told("metadata") ? [] : ["placement"]),
  ];
  if (result.sourceFile && claim) {
    // The child grades on this run's target: it inherits the lock (PROVIDER_LOCKS) and is told which one.
    const lenientArgs = result.lenient.length ? ["--lenient", result.lenient.join(",")] : [];
    // What this set's answers change about the right result (set.json "expect", per provider).
    const expect = (set.meta.expect as Record<string, unknown> | undefined)?.[provider];
    if (expect) writeFileSync(join(dir, "expect.json"), JSON.stringify(expect, null, 2));
    const expectArgs = expect ? ["--expect", join(dir, "expect.json")] : [];
    const t = await run("tsx", ["scripts/test-custom-source.ts", "-e", exportName, "-s", join(dir, result.sourceFile), "--cli", cfg.cli, "--out", dir, ...lenientArgs, ...expectArgs], {
      ...process.env, ...targetEnv(claim.target),
    }).finally(() => claim?.release());
    writeFileSync(join(dir, "test-custom.log"), t.stdout + t.stderr);
    const report = join(dir, "test-custom", "report.md");
    if (existsSync(report)) {
      result.testReport = readFileSync(report, "utf8");
      const json = JSON.parse(readFileSync(join(dir, "test-custom", "report.json"), "utf8"));
      result.grade = json.results[0]?.grade;
      result.gradeError = json.results[0]?.error;
      result.cliVersion = json.cliVersion;
      if (!result.grade && String(result.gradeError ?? "").startsWith("not run")) result.notRun = result.gradeError;
    } else {
      result.gradeError = `test:custom exited ${t.code} without a report: ${(t.stderr || t.stdout).trim().split("\n").slice(-3).join(" ")}`;
    }
  } else {
    claim?.release();
    result.gradeError = result.notRun ?? (result.status === "blocked" ? "blocked: the agent stopped without a source" : "the agent wrote no source file");
  }

  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(dir, "result.md"), resultMarkdown(result));
  return result;
}

// ── reports ──

const pct = (g?: Grade) => (g ? `${(Math.floor(g.accuracy * 1000) / 10).toFixed(1)}%` : "—");

function resultMarkdown(r: Result): string {
  const c = counts(r.qa);
  const lines = [
    `# ${r.agent} · ${r.export}: ${gradeCell(r)} (${pct(r.grade)})`,
    "",
    `| | |`,
    `|---|---|`,
    `| Agent | ${r.agent} (${r.model}, effort ${r.effort}) |`,
    `| Clerk target | ${r.target ?? "none claimed"} |`,
    `| Lenient grading | ${r.lenient?.length ? `${r.lenient.join(", ")} (the agent was never told)` : "none"} |`,
    `| Answer set | ${set.name} v${r.setVersion} |`,
    `| Skill | ${skillHash} |`,
    `| Prompts | ${prompts.dir} (${prompts.hash}) |`,
    `| Agent CLI access | ${access} |`,
    `| Status | ${r.status} after ${r.rounds} round(s), ${minutes(r.seconds)} min |`,
    `| Questions | ${r.qa.length}: ${c.set} from the set, ${c.fallback} fallback, ${c.you} from you |`,
    `| Source | ${r.sourceFile ? `\`${r.sourceFile}\`` : "none"} |`,
    `| CLI | ${r.cliVersion ?? "not run"} |`,
    `| Files | [test-custom/report.md](test-custom/report.md) · [clerk-runs/](clerk-runs/) (the CLI's import and undo runs) · \`transcript.jsonl\` |`,
    "",
  ];
  if (r.contaminated.length) {
    lines.push(`> **Contaminated:** the transcript mentions ${r.contaminated.map((s) => `\`${s}\``).join(", ")}. The agent may have seen the answers.`, "");
  }
  lines.push("## Issues and blockers the agent reported", "");
  lines.push(...(r.issues.length ? r.issues.map((i) => `- ${i}`) : ["None."]), "");
  lines.push(...qaMarkdown(r.qa));
  lines.push("## test:custom", "");
  if (r.gradeError) lines.push(`**Not graded / failed:** ${r.gradeError}`, "");
  if (r.testReport) lines.push(r.testReport.replace(/^# .*\n/, "").replace(/^(#+) /gm, "#$1 "));
  return lines.join("\n") + "\n";
}

function summaryMarkdown(results: Result[], meta: Record<string, string>): string {
  const versions = new Set(results.map((r) => r.setVersion));
  const clis = new Set(results.flatMap((r) => (r.cliVersion ? [r.cliVersion] : [])));
  const rows = results.map((r) => {
    const c = counts(r.qa);
    const notes = [
      r.status !== "done" && r.status,
      r.contaminated.length && "**contaminated**",
      r.gradeError && !r.grade && r.gradeError,
      versions.size > 1 && `set v${r.setVersion}`,
      clis.size > 1 && `CLI ${r.cliVersion ?? "?"}`,
    ].filter(Boolean).join("; ");
    return `| ${r.agent} | ${r.export} | ${gradeCell(r)} | ${pct(r.grade)} | ${r.grade ? `${r.grade.users.correct}/${r.grade.users.expected}` : "—"} | ` +
      `${c.set}/${c.fallback}/${c.you} | ${minutes(r.seconds)} | [result](${r.agent}/${r.export}/result.md) | ${notes} |`;
  });
  return [
    `# Source eval: ${meta.set}`,
    "",
    ...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`),
    ...(versions.size > 1 ? ["", `> The answer set changed during this batch (versions ${[...versions].join(", ")}): answers were saved mid-run.`] : []),
    ...(clis.size > 1 ? ["", `> **The CLI changed during this batch** (${[...clis].join(", ")}). Runs graded on different builds are not comparable.`] : []),
    "",
    "| Agent | Export | Grade | Accuracy | Users correct | Questions (set/fallback/you) | Minutes | Result | Notes |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

// ── main ──

const skillHash = hashTree(SKILL_DIR);
const accounts = Object.fromEntries(
  await Promise.all(agents.map(async (a) => [a, await (a === "claude" ? claudeAccount() : codexAccount())] as const)),
);
for (const a of agents) {
  if (!accounts[a].ok) {
    console.error(`${a}: ${accounts[a].detail}`);
    process.exit(2);
  }
}
const meta: Record<string, string> = {
  set: `${set.name} v${set.version} (${set.hash})`,
  skill: `${SKILL_DIR} (${skillHash})`,
  prompts: `${prompts.dir} (${prompts.hash})`,
  "agent CLI access": access,
  cli: `${cfg.cli} @ ${cliVersion(cfg.cli)}`,
  ...Object.fromEntries(agents.map((a) => [a, `${cfg.agents[a].model}, effort ${cfg.agents[a].effort} · ${accounts[a].version} · ${accounts[a].detail}`])),
  started: new Date().toISOString(),
};
console.log(`Eval → ${relative(repoRoot, batchDir)}`);
for (const [k, v] of Object.entries(meta)) console.log(`  ${k}: ${v}`);
console.log(`  ${agents.length * exports.length} runs\n`);

const results: Result[] = [];
for (const agent of agents) {
  for (const exportName of exports) {
    process.stdout.write(`${agent.padEnd(7)} ${exportName.padEnd(14)} … `);
    const r = await runOne(agent, exportName);
    results.push(r);
    const c = counts(r.qa);
    console.log(
      `${(gradeCell(r)).padEnd(3)} ${pct(r.grade).padStart(6)}   ${r.status}, ${r.qa.length} questions ` +
        `(${c.set} set, ${c.fallback} fallback, ${c.you} you), ${minutes(r.seconds)} min` +
        (r.contaminated.length ? "   CONTAMINATED" : "") + (r.gradeError && !r.grade ? `   ✗ ${r.gradeError}` : ""),
    );
    writeFileSync(join(batchDir, "summary.md"), summaryMarkdown(results, meta));
    writeFileSync(join(batchDir, "summary.json"), JSON.stringify({ meta, results }, null, 2));
  }
}
console.log(`\nSummary: ${relative(repoRoot, join(batchDir, "summary.md"))}`);
