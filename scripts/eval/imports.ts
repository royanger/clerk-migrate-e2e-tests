/**
 * Eval: given only the clerk-migrate skill and a provider's export, does the
 * agent import the users correctly, and follow the skill's import flow?
 *
 *   pnpm eval:ready && pnpm eval:imports -a claude
 *   pnpm eval:imports --set strict -a codex -p firebase,supabase
 *
 *   --set <a[,b]>           import answer sets (default: all of them, e.g. permissive, strict)
 *   -a, --agent <a[,b]>     claude, codex (default: both, Claude first)
 *   -p, --provider <a[,b]>  default: all seven
 *
 * Per run (set × agent × provider), on a Clerk target claimed from the pool
 * (evals/targets.json; it waits for a free one), emptied and set to the answer
 * set's Clerk settings, in a temp workspace holding only the export (as
 * users-export.json) and the skill:
 *   agent turns, questions answered from the set (or you) → whatever the agent
 *   imported is graded against the golden key → process checks from the shim's
 *   log of every `clerk` call → every user deleted.
 *
 * Inputs: pnpm eval:provider-exports, then pnpm eval:imports:golden.
 * Writes evals/runs/<stamp>-imports/{summary.md, summary.json, <set>/<agent>/<provider>/…}.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { value } from "../lib/args";
import { clerkRun, cliVersion, pinCli, SetupError } from "../lib/clerk-run";
import { claimTarget, targetArgs } from "../lib/targets";
import { DESTS, withBaseline, type DestId } from "../lib/clerk-dest";
import { deleteAllUsers } from "../lib/clerk-source";
import { grade, section, type Grade } from "../lib/grade";
import { claudeAccount, codexAccount, createWorkspace, readCalls, type ShimCall } from "./agents";
import { processChecks, type Check } from "./process-checks";
import { envRefs, listSets, loadSet, loadTopics, setsDir, type AnswerSet } from "./answers";
import { AGENTS, hashTree, loadConfig, SKILL_DIR, type AgentName } from "./config";
import { goldenFile, settingsOf, runUsers, sha256, type GoldenKey } from "./golden";
import { exportFile, PROVIDER_EXPORTS, PROVIDER_NAMES } from "./provider-exports";
import { loadPrompts } from "./prompts";
import { answerer, contamination, counts, minutes, qaMarkdown, runSession, type Answerer, type QA } from "./session";

const SETS = setsDir("imports");
const PROVIDERS = Object.keys(PROVIDER_EXPORTS);
const MARKERS = ["provider-exports", "golden", "answer-sets", "evals/runs", "users-eval.json"];

// ── arguments ──

const usage = "Usage: pnpm eval:imports [--set permissive,strict] [-a claude|codex] [-p auth0,firebase]";
const setNames = value("set")?.split(",") ?? listSets(SETS);
const agents = (value("agents")?.split(",") ?? AGENTS) as AgentName[];
const providers = value("provider")?.split(",") ?? PROVIDERS;
const bad = [
  ...setNames.filter((s) => !listSets(SETS).includes(s)).map((s) => `unknown set "${s}" (have ${listSets(SETS).join(", ")})`),
  ...agents.filter((a) => !AGENTS.includes(a)).map((a) => `unknown agent "${a}"`),
  ...providers.filter((p) => !PROVIDERS.includes(p)).map((p) => `unknown provider "${p}" (have ${PROVIDERS.join(" ")})`),
  ...providers.filter((p) => !existsSync(exportFile(p))).map((p) => `no export for ${p}: run pnpm eval:provider-exports -p ${p}`),
  ...setNames.filter((s) => listSets(SETS).includes(s)).flatMap((s) => providers.filter((p) => !existsSync(goldenFile(settingsOf(loadSet(s, SETS)), p))).map((p) => `no golden key for ${s}/${p}: run pnpm eval:imports:golden -p ${p}`)),
];
if (bad.length) {
  console.error(`${bad.join("\n")}\n${usage}`);
  process.exit(2);
}

const cfg = loadConfig();
const topics = loadTopics(SETS);
const missingEnv = setNames.flatMap((n) => envRefs(loadSet(n, SETS), providers)).filter((v) => process.env[v] === undefined);
if (missingEnv.length) {
  console.error(`Answers need ${[...new Set(missingEnv)].join(", ")}, not set: run through op (pnpm eval:imports does) and check op.env`);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const batchDir = resolve("evals/runs", `${stamp}-imports`);
mkdirSync(batchDir, { recursive: true });
// Every run in the batch is graded on this one build, whatever happens to the checkout meanwhile.
cfg.cli = pinCli(cfg.cli, join(batchDir, "cli"));

// ── one run ──

const prompts = loadPrompts("imports", cfg);

type Result = {
  set: string;
  agent: AgentName;
  provider: string;
  model: string;
  effort: string;
  status: string;
  rounds: number;
  seconds: number;
  qa: QA[];
  issues: string[];
  checks: Check[];
  calls: ShimCall[];
  importRuns: string[];
  contaminated: string[];
  grade?: Grade;
  error?: string;
  setVersion: number;
  goldenWarnings: string[];
  /** Set when the run's setup failed: nothing was graded, so it is not an F. */
  notRun?: string;
  /** The Clerk target (evals/targets.json) the run claimed. */
  target?: string;
};

/** The agent's own import runs, from the CLI's run store in its workspace. */
function agentRuns(wsDir: string): { id: string; kind: string; created: number; dir: string }[] {
  const store = join(wsDir, ".clerk", "migrate");
  if (!existsSync(store)) return [];
  return readdirSync(store)
    .filter((id) => existsSync(join(store, id, "run.json")))
    .map((id) => {
      const run = JSON.parse(readFileSync(join(store, id, "run.json"), "utf8"));
      return { id, kind: run.kind as string, created: Number(run.counts?.created ?? 0), dir: join(store, id) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function runOne(set: AnswerSet, answers: Answerer, agent: AgentName, provider: string): Promise<Result> {
  const dir = join(batchDir, set.name, agent, provider);
  mkdirSync(dir, { recursive: true });
  const { model, effort } = cfg.agents[agent];
  const golden = JSON.parse(readFileSync(goldenFile(settingsOf(set), provider), "utf8")) as GoldenKey;
  const result: Result = {
    set: set.name, agent, provider, model, effort, status: "error", rounds: 0, seconds: 0, qa: [], issues: [],
    checks: [], calls: [], importRuns: [], contaminated: [], setVersion: answers.set.version, goldenWarnings: [],
  };
  const version = cliVersion(cfg.cli);
  if (golden.cliVersion !== version) result.goldenWarnings.push(`golden key made with CLI ${golden.cliVersion}, now ${version}`);
  if (golden.exportSha !== sha256(exportFile(provider))) result.goldenWarnings.push("the export changed since the golden key was made");

  const root = mkdtempSync(join(tmpdir(), `eval-import-${agent}-${provider}-`));
  const transcript = join(dir, "transcript.jsonl");
  const started = Date.now();
  // Claimed per run, so parallel batches share the pool without colliding.
  let claim: Awaited<ReturnType<typeof claimTarget>> | undefined;
  let clerk: ReturnType<typeof clerkRun> | undefined;
  try {
    claim = await claimTarget(`eval:imports ${stamp} ${set.name}/${agent}/${provider}`);
    result.target = claim.target.name;
    clerk = clerkRun({ cli: cfg.cli, secretKey: claim.target.secretKey, log: join(batchDir, "clerk.log") });
    const existing = await clerk.settledCount();
    // A target left with users by a crashed run: empty it rather than grade on top of them.
    if (existing) await deleteAllUsers(clerk.clerk);
    await clerk.patchConfig(targetArgs(claim.target), withBaseline(DESTS[set.meta.dest as DestId]));

    copyFileSync(exportFile(provider), join(root, "users-export.json"));
    const ws = createWorkspace(root, agent, cfg, [join(root, "users-export.json")], "import", claim.target.secretKey);
    const vars = { file: "users-export.json", provider: PROVIDER_NAMES[provider] };
    const s = await runSession({
      agent, cfg, ws, access: "import", prompt: prompts.user(vars), system: prompts.system(vars), provider,
      label: `${agent} · ${provider} · ${set.name}`, answers, transcript,
    });
    Object.assign(result, { status: s.status, rounds: s.rounds, qa: s.qa, issues: s.issues });

    result.calls = readCalls(ws);
    copyFileSync(ws.calls, join(dir, "clerk-calls.jsonl"));
    const runs = agentRuns(ws.dir);
    if (runs.length) cpSync(join(ws.dir, ".clerk", "migrate"), join(dir, "clerk-runs"), { recursive: true });
    const imports = runs.filter((r) => r.kind === "import");
    result.importRuns = imports.map((r) => r.id);
    result.checks = processChecks(result.calls, result.qa, s.output, result.importRuns);

    // ── grade what landed against the golden key ──
    const created = imports.reduce((n, r) => n + r.created, 0);
    await clerk.settledCount(60_000, created);
    let users = await clerk.clerkUsers();
    for (let i = 0; users.length !== created && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      users = await clerk.clerkUsers();
    }
    const pw = await clerk.verifyPasswords(users, golden.seedPassword);
    const rejected = new Map<string, string>();
    for (const r of imports) {
      for (const [id, l] of runUsers(join(r.dir, "users.ndjson"))) if (l.status !== "created") rejected.set(id, l.reason ?? l.error ?? l.status);
    }
    result.grade = grade(golden, users, rejected, new Set(pw.failed));
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (error instanceof SetupError) result.notRun = result.error;
  } finally {
    result.seconds = Math.round((Date.now() - started) / 1000);
    rmSync(root, { recursive: true, force: true });
    // Whatever the agent did, the next run on this target starts empty.
    if (clerk) {
      const c = clerk;
      await deleteAllUsers(c.clerk).catch((e) => (result.error = `${result.error ? `${result.error}; ` : ""}cleanup: ${e.message}`));
      const left = await c.settledCount().catch(() => -1);
      if (left !== 0) result.error = `${result.error ? `${result.error}; ` : ""}${left} users left after cleanup`;
    }
    claim?.release();
  }
  result.contaminated = existsSync(transcript) ? contamination(readFileSync(transcript, "utf8"), MARKERS) : [];
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(dir, "result.md"), resultMarkdown(result, set, golden));
  return result;
}

// ── reports ──

/** "—" when setup failed, "blocked" when the agent stopped itself without doing anything, else the grade. */
const gradeCell = (r: Result) => (r.notRun ? "—" : r.status === "blocked" && r.importRuns.length === 0 ? "blocked" : (r.grade?.grade ?? "F"));

const pct = (g?: Grade) => (g ? `${(Math.floor(g.accuracy * 1000) / 10).toFixed(1)}%` : "—");
const passed = (r: Result) => `${r.checks.filter((c) => c.ok).length}/${r.checks.length}`;

function resultMarkdown(r: Result, set: AnswerSet, golden: GoldenKey): string {
  const c = counts(r.qa);
  const lines = [
    `# ${r.agent} · ${r.provider} · ${r.set}: ${gradeCell(r)} (${pct(r.grade)}), process ${passed(r)}`,
    "",
    "| | |",
    "|---|---|",
    `| Agent | ${r.agent} (${r.model}, effort ${r.effort}) |`,
    `| Clerk target | ${r.target ?? "none claimed"} |`,
    `| Answer set | ${set.name} v${r.setVersion} · Clerk settings ${set.meta.dest}${set.meta.allowPartial ? " · told to import the rest" : ""} |`,
    `| Skill | ${skillHash} |`,
    `| Prompts | ${prompts.dir} (${prompts.hash}) |`,
    `| CLI | ${cliVersion(cfg.cli)} (golden key: ${golden.cliVersion}) |`,
    `| Status | ${r.status} after ${r.rounds} round(s), ${minutes(r.seconds)} min |`,
    `| Questions | ${r.qa.length}: ${c.set} from the set, ${c.fallback} fallback, ${c.you} from you |`,
    `| Import runs | ${r.importRuns.join(", ") || "none"} |`,
    `| Files | [clerk-runs/](clerk-runs/) (the agent's CLI runs) · \`clerk-calls.jsonl\` (every \`clerk\` call) · \`transcript.jsonl\` |`,
    "",
  ];
  if (r.error) lines.push(`> **Run error:** ${r.error}`, "");
  if (r.contaminated.length) lines.push(`> **Contaminated:** the transcript mentions ${r.contaminated.map((m) => `\`${m}\``).join(", ")}.`, "");
  for (const w of r.goldenWarnings) lines.push(`> ⚠ ${w}: run pnpm eval:imports:golden to refresh it.`, "");
  lines.push("## Process", "", ...r.checks.map((k) => `- ${k.ok ? "✅" : "❌"} **${k.name}:** ${k.detail}`), "");
  lines.push("## Every `clerk` call", "");
  lines.push(...(r.calls.length ? r.calls.map((k) => `- round ${k.round} · ${k.allowed ? `exit ${k.code}` : "**refused**"} · \`clerk ${k.args.replace(/\n/g, " ").slice(0, 200)}\``) : ["None."]), "");
  lines.push("## Issues and blockers the agent reported", "", ...(r.issues.length ? r.issues.map((i) => `- ${i}`) : ["None."]), "");
  lines.push(...qaMarkdown(r.qa));
  lines.push("## Data", "", r.grade ? section(r.provider, `the agent's import vs. golden key (${golden.users.length} users)`, r.grade).replace(/^## .*\n/, "") : "Not graded.");
  return lines.join("\n") + "\n";
}

function summaryMarkdown(results: Result[], meta: Record<string, string>): string {
  const versions = new Set(results.map((r) => `${r.set} v${r.setVersion}`));
  const rows = results.map((r) => {
    const c = counts(r.qa);
    const notes = [
      r.status !== "done" && r.status,
      r.error && `error: ${r.error.slice(0, 80)}`,
      r.contaminated.length && "**contaminated**",
      r.goldenWarnings.length && "stale golden key",
      ...r.checks.filter((k) => !k.ok).map((k) => k.name),
    ].filter(Boolean).join("; ");
    return `| ${r.set} | ${r.agent} | ${r.provider} | ${gradeCell(r)} | ${pct(r.grade)} | ${r.grade ? `${r.grade.users.correct}/${r.grade.users.expected}` : "—"} | ` +
      `${passed(r)} | ${c.set}/${c.fallback}/${c.you} | ${minutes(r.seconds)} | [result](${r.set}/${r.agent}/${r.provider}/result.md) | ${notes} |`;
  });
  return [
    "# Import eval",
    "",
    ...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`),
    ...(versions.size > setNames.length ? ["", "> An answer set changed during this batch: answers were saved mid-run."] : []),
    "",
    "| Set | Agent | Provider | Grade | Accuracy | Users correct | Process | Questions (set/fallback/you) | Minutes | Result | Notes |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

// ── main ──

const skillHash = hashTree(SKILL_DIR);
const accounts = Object.fromEntries(await Promise.all(agents.map(async (a) => [a, await (a === "claude" ? claudeAccount() : codexAccount())] as const)));
for (const a of agents) {
  if (!accounts[a].ok) {
    console.error(`${a}: ${accounts[a].detail}`);
    process.exit(2);
  }
}
const sets = setNames.map((n) => loadSet(n, SETS));
const meta: Record<string, string> = {
  sets: sets.map((s) => `${s.name} v${s.version} (${s.hash}, Clerk settings ${s.meta.dest})`).join(" · "),
  skill: `${SKILL_DIR} (${skillHash})`,
  prompts: `${prompts.dir} (${prompts.hash})`,
  cli: `${cfg.cli} @ ${cliVersion(cfg.cli)}`,
  ...Object.fromEntries(agents.map((a) => [a, `${cfg.agents[a].model}, effort ${cfg.agents[a].effort} · ${accounts[a].version} · ${accounts[a].detail}`])),
  started: new Date().toISOString(),
};
console.log(`Import eval → ${relative(process.cwd(), batchDir)}`);
for (const [k, v] of Object.entries(meta)) console.log(`  ${k}: ${v}`);
console.log(`  ${sets.length * agents.length * providers.length} runs\n`);

const results: Result[] = [];
{
  for (const set of sets) {
    const answers = answerer(set, topics);
    for (const agent of agents) {
      for (const provider of providers) {
        process.stdout.write(`${set.name.padEnd(10)} ${agent.padEnd(7)} ${provider.padEnd(12)} … `);
        const r = await runOne(set, answers, agent, provider);
        results.push(r);
        const c = counts(r.qa);
        console.log(
          `${(gradeCell(r)).padEnd(3)} ${pct(r.grade).padStart(6)}   process ${passed(r)}   ${r.status}, ${r.qa.length} questions ` +
            `(${c.set} set, ${c.fallback} fallback, ${c.you} you), ${minutes(r.seconds)} min` +
            (r.contaminated.length ? "   CONTAMINATED" : "") + (r.error ? `   ✗ ${r.error}` : ""),
        );
        writeFileSync(join(batchDir, "summary.md"), summaryMarkdown(results, meta));
        writeFileSync(join(batchDir, "summary.json"), JSON.stringify({ meta, results }, null, 2));
      }
    }
  }
}
console.log(`\nSummary: ${relative(process.cwd(), join(batchDir, "summary.md"))}`);
