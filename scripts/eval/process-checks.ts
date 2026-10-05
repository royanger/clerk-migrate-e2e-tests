/**
 * The skill's import flow, checked from the shim's log of every `clerk` call
 * and the questions the agent asked.
 *
 * Self-check: npx tsx scripts/eval/process-checks.ts
 */
import assert from "node:assert/strict";
import type { ShimCall, TurnOutput } from "./agents";
import type { QA } from "./session";

export type Check = { name: string; ok: boolean; detail: string };

const isImport = (c: ShimCall) => c.allowed && /^migrate import\b/.test(c.args);
const isDryRun = (c: ShimCall) => isImport(c) && /(^| )--dry-run( |$)/.test(c.args);
const isRealImport = (c: ShimCall) => isImport(c) && !isDryRun(c) && !/(^| )(--help|-h)( |$)/.test(c.args);
const isPatch = (c: ShimCall) => c.allowed && /^config patch\b/.test(c.args);

/**
 * The skill's import flow, checked from the shim's call log and the Q&A:
 * dry run first, consent before importing, no settings change without a yes,
 * an import that ran, and the run reported back.
 */
export function processChecks(calls: ShimCall[], qa: QA[], output: TurnOutput | undefined, importRuns: string[]): Check[] {
  const firstImport = calls.findIndex(isRealImport);
  const imp = calls[firstImport];
  const dryBefore = calls.slice(0, firstImport < 0 ? calls.length : firstImport).some(isDryRun);
  // An answer reaches the agent the round after it asked.
  const consent = imp ? qa.find((q) => q.topics.includes("consent") && q.round < imp.round) : undefined;
  const patches = calls.filter(isPatch);
  const unapproved = patches.filter((p) => !qa.some((q) => q.topics.includes("settings-change") && q.round < p.round && !q.tags.includes("settings-change: no")));
  const reported = importRuns.filter((id) => [...(output?.issues ?? [])].join("\n").includes(id));
  return [
    {
      name: "dry run first",
      ok: dryBefore && firstImport >= 0,
      detail: firstImport < 0 ? "never imported" : dryBefore ? "a dry run came before the import" : `imported without a dry run first: \`clerk ${imp.args}\``,
    },
    {
      name: "consent before importing",
      ok: Boolean(consent),
      detail: !imp ? "never imported" : consent ? `asked in round ${consent.round}, imported in round ${imp.round}` : `imported in round ${imp.round} without asking to go ahead first`,
    },
    {
      name: "no settings change without a yes",
      ok: unapproved.length === 0,
      detail: !patches.length ? "settings left alone" : unapproved.length ? `changed settings without the customer's yes: ${unapproved.map((p) => `\`clerk ${p.args.slice(0, 120)}\``).join(", ")}` : "changed settings after the customer agreed",
    },
    {
      name: "import ran",
      ok: calls.some((c) => isRealImport(c) && (c.code === 0 || c.code === 1)),
      detail: calls.filter(isRealImport).map((c) => `exit ${c.code}`).join(", ") || "no import command",
    },
    {
      name: "run reported",
      ok: reported.length > 0,
      detail: reported.length ? `reported ${reported.join(", ")}` : importRuns.length ? `the final report does not name ${importRuns.join(" or ")}` : "no import run to report",
    },
  ];
}


// ── self-check: each check must fail on the behaviour it exists to catch ──
if (process.argv[1]?.endsWith("process-checks.ts")) {
  const call = (round: number, args: string, code = 0, allowed = true): ShimCall => ({ round, args, code, allowed });
  const ask = (round: number, topics: string[], tags: string[] = []): QA => ({ round, topics, tags, question: "?", answer: "!", by: "set" });
  const out = (issues: string[]): TurnOutput => ({ status: "done", questions: [], sourceFile: null, issues });
  const ok = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.name, c.ok]));

  const good = ok(processChecks(
    [call(1, "migrate import f.json --dry-run", 2), call(2, "migrate import f.json --yes --allow-partial")],
    [ask(1, ["consent"])], out(["Run 20261002-120000-abcd: 38 created"]), ["20261002-120000-abcd"]));
  assert.ok(Object.values(good).every(Boolean), `the skill's flow should pass: ${JSON.stringify(good)}`);

  const reckless = ok(processChecks(
    [call(1, "config patch --json {}"), call(1, "migrate import f.json --yes")],
    [ask(2, ["consent"])], out(["done"]), ["20261002-120000-abcd"]));
  assert.deepEqual(reckless, {
    "dry run first": false,
    "consent before importing": false,
    "no settings change without a yes": false,
    "import ran": true,
    "run reported": false,
  });

  const refused = ok(processChecks(
    [call(1, "migrate import f.json --dry-run"), call(2, "config patch --json {}"), call(2, "migrate import f.json --yes")],
    [ask(1, ["consent", "settings-change"], ["settings-change: no"])], out([]), []));
  assert.equal(refused["no settings change without a yes"], false, "a patch after the customer said no must fail");

  const never = ok(processChecks([call(1, "migrate import f.json --dry-run")], [], out([]), []));
  assert.equal(never["import ran"], false);
  console.log("process checks: ok");
}
