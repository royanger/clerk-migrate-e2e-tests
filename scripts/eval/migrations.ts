/**
 * Eval: told only "I want to migrate from <provider> to Clerk", with the
 * clerk-migrate skill and the Clerk CLI, does the agent get the users out of
 * the provider and into Clerk the way the skill says?
 *
 *   pnpm eval:ready && pnpm eval:migrations -a claude
 *   pnpm eval:migrations --set strict -a codex -p supabase,workos
 *
 *   --set <a[,b]>           import answer sets (default: all); they also hold each provider's credentials
 *   -a, --agent <a[,b]>     claude, codex (default: both, Claude first)
 *   -p, --provider <a[,b]>  default: all seven (Clerk needs the source instance in evals/targets.json)
 *   --prompt-dir <dir>      prompts other than evals/prompts
 *
 * Providers are worked through under their locks, skipping any another run
 * holds and coming back to it (scripts/lib/lock.ts schedule: 5-min polls,
 * giving up on one after an hour). Per provider: seed data/users-eval.json into
 * it (once: exporting only reads), run every set × agent, put the provider's
 * standard users back, release.
 *
 * Per run, on a Clerk target claimed from the pool (evals/targets.json),
 * emptied and set to the answer set's Clerk settings, in a workspace holding
 * only the skill: the agent gets the prompt, asks
 * for what it needs (credentials come from the set, filled in from op.env),
 * exports, imports. Then: export checks, import process checks, and the
 * import graded against the golden key, matching users by email, phone or
 * username (a fresh seed gives every user a new provider ID). Every user is
 * deleted afterwards.
 *
 * Writes evals/runs/<stamp>-migrations/{summary.md, summary.json, <set>/<agent>/<provider>/…}.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { value } from "../lib/args";
import { clerkRun, cliVersion, SetupError } from "../lib/clerk-run";
import { claimTarget, sourceTarget, targetArgs } from "../lib/targets";
import { DESTS, type DestId } from "../lib/clerk-dest";
import { deleteAllUsers } from "../lib/clerk-source";
import { grade, section, type Grade } from "../lib/grade";
import { rowIdentifiers, sourceIdOf } from "../lib/identifiers";
import { clerkLock, schedule } from "../lib/lock";
import { run } from "../lib/run";
import { claudeAccount, codexAccount, createWorkspace, readCalls, type ShimCall } from "./agents";
import { envRefs, listSets, loadSet, loadTopics, setsDir, type AnswerSet } from "./answers";
import { AGENTS, hashTree, loadConfig, SKILL_DIR, type AgentName } from "./config";
import { agentFiles, CLI_SOURCE, exportChecks, type ExportRun } from "./export-checks";
import { goldenFile, settingsOf, runUsers, type GoldenKey } from "./golden";
import { processChecks, type Check } from "./process-checks";
import { loadPrompts } from "./prompts";
import { exportFile, PROVIDER_EXPORTS, PROVIDER_NAMES, usersFor } from "./provider-exports";
import { answerer, contamination, counts, minutes, qaMarkdown, runSession, type Answerer, type QA } from "./session";

const SETS = setsDir("migrations");
const PROVIDERS = Object.keys(CLI_SOURCE);
const TEMP_ROOTS = [...new Set(["/tmp/", "/private/tmp/", `${realpathSync(tmpdir())}/`, `${tmpdir()}/`])];
const MARKERS = ["provider-exports", "golden", "answer-sets", "evals/runs", "users-eval.json"];

// ── arguments ──

const usage = "Usage: pnpm eval:migrations [--set permissive,strict] [-a claude|codex] [-p auth0,supabase] [--prompt-dir <dir>]";
const setNames = value("set")?.split(",") ?? listSets(SETS);
const agents = (value("agents")?.split(",") ?? AGENTS) as AgentName[];
const providers = value("provider")?.split(",") ?? PROVIDERS;
const bad = [
  ...setNames.filter((s) => !listSets(SETS).includes(s)).map((s) => `unknown set "${s}" (have ${listSets(SETS).join(", ")})`),
  ...agents.filter((a) => !AGENTS.includes(a)).map((a) => `unknown agent "${a}"`),
  ...providers.filter((p) => !PROVIDERS.includes(p)).map((p) => `unknown provider "${p}" (have ${PROVIDERS.join(" ")})`),
  ...providers.filter((p) => !existsSync(exportFile(p))).map((p) => `no reference export for ${p}: run pnpm eval:provider-exports -p ${p}`),
  ...setNames.filter((s) => listSets(SETS).includes(s)).flatMap((s) => providers.filter((p) => !existsSync(goldenFile(settingsOf(loadSet(s, SETS)), p))).map((p) => `no golden key for ${s}/${p}: run pnpm eval:imports:golden -p ${p}`)),
];
if (bad.length) {
  console.error(`${bad.join("\n")}\n${usage}`);
  process.exit(2);
}

const cfg = loadConfig();
const prompts = loadPrompts("migrations", cfg);
const topics = loadTopics(SETS);
const sets = setNames.map((n) => loadSet(n, SETS));
// Clerk as a provider exports from its own source instance; without one, Clerk sits this batch out.
const asked = Boolean(value("provider"));
const source = providers.includes("clerk") ? await sourceTarget().catch((e: Error) => e) : undefined;
if (source instanceof Error) {
  if (asked) {
    console.error(`clerk: ${source.message}`);
    process.exit(2);
  }
  console.log(`Clerk skipped: ${source.message}`);
  providers.splice(providers.indexOf("clerk"), 1);
} else if (source) {
  // test:migrate children seed and restore it as Clerk-the-source.
  Object.assign(process.env, { CLERK_AS_SOURCE_SECRET_KEY: source.secretKey, CLERK_AS_SOURCE_APP: source.app, CLERK_AS_SOURCE_INSTANCE: source.instance });
}
const missingEnv = [...new Set(sets.flatMap((s) => envRefs(s, providers)))].filter((v) => process.env[v] === undefined);
if (missingEnv.length) {
  console.error(`Not set: ${missingEnv.join(", ")}. Run through op (pnpm eval:migrations does) and check op.env.`);
  process.exit(2);
}
/** How the customer names where they are coming from: "I want to migrate from <this> to Clerk." */
const FROM: Record<string, string> = { ...PROVIDER_NAMES, clerk: "another Clerk application" };

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const batchDir = resolve("evals/runs", `${stamp}-migrations`);
mkdirSync(batchDir, { recursive: true });

/** The values a set's answers give for `provider`: none may be written to a file. */
function secretsFor(set: AnswerSet, provider: string): string[] {
  return envRefs(set, [provider])
    .filter((n) => /SECRET|TOKEN|KEY|CONNECTION|JSON/.test(n))
    .flatMap((n) => {
      const v = process.env[n] ?? "";
      // A JSON credential (Firebase's) is matched by its key ID, which survives reformatting.
      try {
        const id = (JSON.parse(v) as { private_key_id?: string }).private_key_id;
        return id ? [id] : [v];
      } catch {
        return [v];
      }
    });
}

// ── one run ──

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
  exportChecks: Check[];
  checks: Check[];
  calls: ShimCall[];
  exportRuns: string[];
  importRuns: string[];
  /** `clerk` calls that failed or were refused before the export worked. */
  stumbles: number;
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

type AgentRun = { id: string; kind: string; created: number; dir: string };
function agentRuns(wsDir: string): AgentRun[] {
  const store = join(wsDir, ".clerk", "migrate");
  if (!existsSync(store)) return [];
  return readdirSync(store)
    .filter((id) => existsSync(join(store, id, "run.json")))
    .map((id) => {
      const r = JSON.parse(readFileSync(join(store, id, "run.json"), "utf8"));
      return { id, kind: r.kind as string, created: Number(r.counts?.created ?? 0), dir: join(store, id) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function readExport(r: AgentRun): ExportRun | undefined {
  const f = readdirSync(r.dir).find((n) => n.endsWith(".json") && n !== "run.json");
  if (!f) return undefined;
  const envelope = JSON.parse(readFileSync(join(r.dir, f), "utf8")) as Record<string, unknown> & { users?: unknown[] };
  return { id: r.id, users: envelope.users?.length ?? 0, envelope };
}

async function runOne(set: AnswerSet, answers: Answerer, agent: AgentName, provider: string): Promise<Result> {
  const dir = join(batchDir, set.name, agent, provider);
  mkdirSync(dir, { recursive: true });
  const { model, effort } = cfg.agents[agent];
  const golden = JSON.parse(readFileSync(goldenFile(settingsOf(set), provider), "utf8")) as GoldenKey;
  const reference = (JSON.parse(readFileSync(exportFile(provider), "utf8")).users as unknown[]).length;
  const result: Result = {
    set: set.name, agent, provider, model, effort, status: "error", rounds: 0, seconds: 0, qa: [], issues: [],
    exportChecks: [], checks: [], calls: [], exportRuns: [], importRuns: [], stumbles: 0, contaminated: [],
    setVersion: answers.set.version, goldenWarnings: [],
  };
  const version = cliVersion(cfg.cli);
  if (golden.cliVersion !== version) result.goldenWarnings.push(`golden key made with CLI ${golden.cliVersion}, now ${version}`);

  const root = mkdtempSync(join(tmpdir(), `eval-migrate-${agent}-${provider}-`));
  let outside: string[] = [];
  const transcript = join(dir, "transcript.jsonl");
  const started = Date.now();
  let claim: Awaited<ReturnType<typeof claimTarget>> | undefined;
  let clerk: ReturnType<typeof clerkRun> | undefined;
  try {
    claim = await claimTarget(`eval:migrations ${stamp} ${set.name}/${agent}/${provider}`);
    result.target = claim.target.name;
    clerk = clerkRun({ cli: cfg.cli, secretKey: claim.target.secretKey, log: join(batchDir, "clerk.log") });
    // A target left with users by a crashed run: empty it rather than grade on top of them.
    if (await clerk.settledCount()) await deleteAllUsers(clerk.clerk);
    await clerk.patchConfig(targetArgs(claim.target), DESTS[set.meta.dest as DestId]);

    const ws = createWorkspace(root, agent, cfg, [], "migrate", claim.target.secretKey);
    const vars = { provider: FROM[provider] };
    const s = await runSession({
      agent, cfg, ws, access: "migrate", prompt: prompts.user(vars), system: prompts.system(vars), provider,
      label: `${agent} · ${provider} · ${set.name}`, answers, transcript,
    });
    Object.assign(result, { status: s.status, rounds: s.rounds, qa: s.qa, issues: s.issues });

    result.calls = readCalls(ws);
    if (existsSync(ws.calls)) cpSync(ws.calls, join(dir, "clerk-calls.jsonl"));
    const runs = agentRuns(ws.dir);
    if (runs.length) cpSync(join(ws.dir, ".clerk", "migrate"), join(dir, "clerk-runs"), { recursive: true });
    const exports = runs.filter((r) => r.kind === "export");
    const imports = runs.filter((r) => r.kind === "import");
    result.exportRuns = exports.map((r) => r.id);
    result.importRuns = imports.map((r) => r.id);

    // ── export ──
    const latestExport = exports.length ? readExport(exports[exports.length - 1]) : undefined;
    const firstGood = result.calls.findIndex((c) => c.allowed && /^migrate export\b/.test(c.args) && c.code === 0);
    result.stumbles = result.calls.slice(0, firstGood < 0 ? result.calls.length : firstGood).filter((c) => !c.allowed || (c.code !== 0 && !/--dry-run/.test(c.args))).length;
    // Files a `clerk` call pointed at outside the workspace (a key written to
    // /tmp, say) count too if they are still there; they are deleted below.
    outside = [...new Set(result.calls.flatMap((c) => c.args.match(/(?:^|\s)(\/[^\s'"]+)/g) ?? []).map((m) => m.trim()))]
      // Temp folders only: never touch a path elsewhere, whatever the agent typed.
      .filter((p) => TEMP_ROOTS.some((t) => p.startsWith(t)) && !p.startsWith(ws.dir) && existsSync(p) && statSync(p).isFile());
    const files = [
      ...agentFiles(ws.dir).map((p) => ({ path: relative(ws.dir, p), content: readFileSync(p, "utf8") })),
      ...outside.map((p) => ({ path: `${p} (outside the workspace, left behind)`, content: readFileSync(p, "utf8") })),
    ];
    result.exportChecks = exportChecks({ provider, calls: result.calls, exportRun: latestExport, reference, files, secrets: secretsFor(set, provider), qa: result.qa });

    // ── import ──
    result.checks = processChecks(result.calls, result.qa, s.output, result.importRuns);
    const created = imports.reduce((n, r) => n + r.created, 0);
    await clerk.settledCount(60_000, created);
    let users = await clerk.clerkUsers();
    for (let i = 0; users.length !== created && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      users = await clerk.clerkUsers();
    }
    const pw = await clerk.verifyPasswords(users, golden.seedPassword);
    // The agent's run names users by this seeding's IDs; key its reasons by identifier too.
    const rows = new Map(((latestExport?.envelope.users ?? []) as Record<string, unknown>[]).map((r) => [sourceIdOf(r), r]));
    const rejected = new Map<string, string>();
    for (const r of imports) {
      for (const [id, l] of runUsers(join(r.dir, "users.ndjson"))) {
        if (l.status === "created") continue;
        const reason = l.reason ?? l.error ?? l.status;
        for (const k of [id, ...rowIdentifiers(rows.get(id))]) rejected.set(k, reason);
      }
    }
    result.grade = grade(golden, users, rejected, new Set(pw.failed), { matchBy: "identifiers" });
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (error instanceof SetupError) result.notRun = result.error;
  } finally {
    result.seconds = Math.round((Date.now() - started) / 1000);
    rmSync(root, { recursive: true, force: true });
    for (const p of outside) rmSync(p, { force: true });
    if (clerk) {
      const c = clerk;
      await deleteAllUsers(c.clerk).catch((e) => (result.error = `${result.error ? `${result.error}; ` : ""}cleanup: ${e.message}`));
      const left = await c.settledCount().catch(() => -1);
      if (left !== 0) result.error = `${result.error ? `${result.error}; ` : ""}${left} users left after cleanup`;
    }
    claim?.release();
  }
  result.contaminated = existsSync(transcript) ? contamination(readFileSync(transcript, "utf8"), MARKERS) : [];
  writeFileSync(join(dir, "result.json"), JSON.stringify(redacted(result), null, 2));
  writeFileSync(join(dir, "result.md"), resultMarkdown(result, set, golden));
  return result;
}

// ── reports ──

const pct = (g?: Grade) => (g ? `${(Math.floor(g.accuracy * 1000) / 10).toFixed(1)}%` : "—");
const score = (c: Check[]) => `${c.filter((k) => k.ok).length}/${c.length}`;
const checkList = (c: Check[]) => c.map((k) => `- ${k.ok ? "✅" : "❌"} **${k.name}:** ${k.detail}`);

function resultMarkdown(r: Result, set: AnswerSet, golden: GoldenKey): string {
  const c = counts(r.qa);
  const lines = [
    `# ${r.agent} · ${r.provider} · ${r.set}: export ${score(r.exportChecks)}, import ${(r.notRun ? "—" : (r.grade?.grade ?? "F"))} (${pct(r.grade)}), process ${score(r.checks)}`,
    "",
    "| | |",
    "|---|---|",
    `| Agent | ${r.agent} (${r.model}, effort ${r.effort}) |`,
    `| Clerk target | ${r.target ?? "none claimed"} |`,
    `| Answer set | ${set.name} v${r.setVersion} · Clerk settings ${set.meta.dest} |`,
    `| Prompts | ${prompts.dir} (${prompts.hash}) |`,
    `| Skill | ${skillHash} |`,
    `| CLI | ${cliVersion(cfg.cli)} (golden key: ${golden.cliVersion}) |`,
    `| Status | ${r.status} after ${r.rounds} round(s), ${minutes(r.seconds)} min |`,
    `| Questions | ${r.qa.length}: ${c.set} from the set, ${c.fallback} fallback, ${c.you} from you |`,
    `| Runs | export ${r.exportRuns.join(", ") || "none"} · import ${r.importRuns.join(", ") || "none"} |`,
    `| Stumbles | ${r.stumbles} failed or refused \`clerk\` call(s) before the export worked |`,
    `| Files | [clerk-runs/](clerk-runs/) (the agent's CLI runs) · \`clerk-calls.jsonl\` · \`transcript.jsonl\` (holds the credentials it was given) |`,
    "",
  ];
  if (r.error) lines.push(`> **Run error:** ${r.error}`, "");
  if (r.contaminated.length) lines.push(`> **Contaminated:** the transcript mentions ${r.contaminated.map((m) => `\`${m}\``).join(", ")}.`, "");
  for (const w of r.goldenWarnings) lines.push(`> ⚠ ${w}: run pnpm eval:imports:golden to refresh it.`, "");
  lines.push("## Export", "", ...checkList(r.exportChecks), "");
  lines.push("## Import process", "", ...checkList(r.checks), "");
  lines.push("## Every `clerk` call", "");
  lines.push(...(r.calls.length ? r.calls.map((k) => `- round ${k.round} · ${k.allowed ? `exit ${k.code}` : "**refused**"} · \`clerk ${redact(k.args).slice(0, 200)}\``) : ["None."]), "");
  lines.push("## Issues and blockers the agent reported", "", ...(r.issues.length ? r.issues.map((i) => `- ${redact(i)}`) : ["None."]), "");
  lines.push(...qaMarkdown(r.qa));
  lines.push("## Import data", "", r.grade ? section(r.provider, `the agent's import vs. golden key (${golden.users.length} users), matched by identifier`, r.grade).replace(/^## .*\n/, "") : "Not graded.");
  return lines.join("\n") + "\n";
}

/**
 * A credential and the parts an agent may reuse on their own: an agent rewrites
 * a connection string (another port, another scheme) but keeps its password.
 */
function secretParts(v: string): string[] {
  const out = [v];
  try {
    const u = new URL(v);
    if (u.password) out.push(u.password, decodeURIComponent(u.password));
    const token = u.searchParams.get("authToken");
    if (token) out.push(token);
  } catch {
    /* not a URL */
  }
  try {
    const j = JSON.parse(v) as { private_key_id?: string; private_key?: string };
    if (j.private_key_id) out.push(j.private_key_id);
    if (j.private_key) out.push(j.private_key);
  } catch {
    /* not JSON */
  }
  return out.filter((x) => x.length >= 8);
}

/** Credentials stay in the transcript only, not in result.md or the summary. */
const allSecrets = () =>
  [...new Set(sets.flatMap((s) => providers.flatMap((p) => envRefs(s, [p]))))].flatMap((n) => secretParts(process.env[n] ?? ""));
/** Any `scheme://user:password@`, whatever the agent did to the rest of the URL. */
const URL_PASSWORD = /(:\/\/[^:/\s@]+:)[^@\s]+@/g;
function redact(text: string): string {
  return allSecrets()
    .reduce((t, s) => t.split(s).join("‹redacted›"), text)
    .replace(URL_PASSWORD, "$1‹redacted›@");
}

/** A result as written to disk: its free text redacted. */
const redacted = (r: Result): Result => ({
  ...r,
  error: r.error && redact(r.error),
  issues: r.issues.map(redact),
  calls: r.calls.map((k) => ({ ...k, args: redact(k.args) })),
  exportChecks: r.exportChecks.map((c) => ({ ...c, detail: redact(c.detail) })),
  checks: r.checks.map((c) => ({ ...c, detail: redact(c.detail) })),
});

function summaryMarkdown(results: Result[], meta: Record<string, string>): string {
  const rows = results.map((r) => {
    const c = counts(r.qa);
    const notes = [
      r.status !== "done" && r.status,
      r.error && `error: ${redact(r.error).slice(0, 80)}`,
      r.contaminated.length && "**contaminated**",
      r.goldenWarnings.length && "stale golden key",
      ...[...r.exportChecks, ...r.checks].filter((k) => !k.ok).map((k) => k.name),
    ].filter(Boolean).join("; ");
    return `| ${r.set} | ${r.agent} | ${r.provider} | ${score(r.exportChecks)} | ${(r.notRun ? "—" : (r.grade?.grade ?? "F"))} | ${pct(r.grade)} | ${r.grade ? `${r.grade.users.correct}/${r.grade.users.expected}` : "—"} | ` +
      `${score(r.checks)} | ${r.stumbles} | ${c.set}/${c.fallback}/${c.you} | ${minutes(r.seconds)} | [result](${r.set}/${r.agent}/${r.provider}/result.md) | ${notes} |`;
  });
  return [
    "# Migration eval",
    "",
    ...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`),
    "",
    "| Set | Agent | Provider | Export | Import | Accuracy | Users correct | Process | Stumbles | Questions (set/fallback/you) | Minutes | Result | Notes |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
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
const meta: Record<string, string> = {
  sets: sets.map((s) => `${s.name} v${s.version} (${s.hash}, Clerk settings ${s.meta.dest})`).join(" · "),
  prompts: `${prompts.dir} (${prompts.hash})`,
  skill: `${SKILL_DIR} (${skillHash})`,
  cli: `${cfg.cli} @ ${cliVersion(cfg.cli)}`,
  ...Object.fromEntries(agents.map((a) => [a, `${cfg.agents[a].model}, effort ${cfg.agents[a].effort} · ${accounts[a].version} · ${accounts[a].detail}`])),
  started: new Date().toISOString(),
};
console.log(`Migration eval → ${relative(process.cwd(), batchDir)}`);
for (const [k, v] of Object.entries(meta)) console.log(`  ${k}: ${v}`);
console.log(`  ${sets.length * agents.length * providers.length} runs\n`);

/** test:migrate under the locks this process holds (the child inherits them). */
async function testMigrate(args: string[], log: string) {
  const r = await run("tsx", ["scripts/test-migrate.ts", ...args], process.env);
  writeFileSync(log, r.stdout + r.stderr);
  if (r.code !== 0) throw new Error(`test:migrate ${args.join(" ")} exited ${r.code}; see ${relative(process.cwd(), log)}`);
}

const results: Result[] = [];
const work = mkdtempSync(join(tmpdir(), "eval-migrations-"));
/** Each provider's lock; Clerk as a provider also locks its source instance. */
const providerLocks = (p: string) => [p, ...(p === "clerk" && source && !(source instanceof Error) ? [clerkLock(source.instance)] : [])];
let unreached: { item: string; holder: { what: string; pid: number } }[] = [];
try {
  unreached = await schedule(providers, providerLocks, `eval:migrations batch ${stamp}`, async (provider) => {
    try {
      process.stdout.write(`Seeding ${provider} with data/users-eval.json … `);
      await testMigrate(["-p", provider, "-v", PROVIDER_EXPORTS[provider], "--users-file", usersFor(provider, work), "--seed-only"], join(batchDir, `seed-${provider}.log`));
      console.log("done");
      for (const set of sets) {
        const answers = answerer(set, topics);
        for (const agent of agents) {
          process.stdout.write(`${set.name.padEnd(10)} ${agent.padEnd(7)} ${provider.padEnd(12)} … `);
          const r = await runOne(set, answers, agent, provider);
          results.push(r);
          const c = counts(r.qa);
          console.log(
            `export ${score(r.exportChecks)}   ${((r.notRun ? "—" : (r.grade?.grade ?? "F"))).padEnd(3)} ${pct(r.grade).padStart(6)}   process ${score(r.checks)}   ` +
              `${r.status}, ${r.qa.length} questions (${c.set} set, ${c.fallback} fallback, ${c.you} you), ${minutes(r.seconds)} min` +
              (r.target ? `   on ${r.target}` : "") + (r.contaminated.length ? "   CONTAMINATED" : "") + (r.error ? `   ✗ ${redact(r.error)}` : ""),
          );
          writeFileSync(join(batchDir, "summary.md"), summaryMarkdown(results, meta));
          writeFileSync(join(batchDir, "summary.json"), JSON.stringify({ meta, results: results.map(redacted) }, null, 2));
        }
      }
    } catch (error) {
      console.log(`✗ ${provider}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      process.stdout.write(`Restoring ${provider} … `);
      // Reseeding the standard users is hundreds of API calls; a few can drop ("fetch failed"). Try twice.
      await testMigrate(["-p", provider, "--restore-source"], join(batchDir, `restore-${provider}.log`))
        .catch(() => testMigrate(["-p", provider, "--restore-source"], join(batchDir, `restore-${provider}-retry.log`)))
        .then(() => console.log("done"))
        .catch((e) => console.log(`!! ${e.message}: run pnpm test:migrate -p ${provider} --restore-source`));
    }
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}
for (const u of unreached) console.log(`✗ ${u.item}: not run, locked by ${u.holder.what} (pid ${u.holder.pid}) for over an hour`);
if (unreached.length) {
  meta["not run"] = unreached.map((u) => `${u.item} (locked by ${u.holder.what})`).join(", ");
  writeFileSync(join(batchDir, "summary.md"), summaryMarkdown(results, meta));
}
console.log(`\nSummary: ${relative(process.cwd(), join(batchDir, "summary.md"))}`);
