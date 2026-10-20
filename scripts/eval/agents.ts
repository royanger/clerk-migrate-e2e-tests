/**
 * Driving `claude -p` and `codex exec` the same way: one turn in, one
 * structured final message out, resumable by session ID.
 *
 * Isolation (verified live, 2026-10-02): the agent must see only the files
 * copied into its workspace and the skill, not the user's global setup.
 *   claude  --setting-sources project drops user skills, plugins, hooks and
 *           CLAUDE.md; --strict-mcp-config with an empty config drops the
 *           claude.ai connectors. Built-in Claude Code skills remain.
 *   codex   HOME and CODEX_HOME point at a temp home holding only a copy of
 *           auth.json, which drops ~/.codex/AGENTS.md, config and
 *           ~/.agents/skills. Codex's built-in system skills remain.
 */
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SetupError } from "../lib/clerk-run";
import { lockProviders } from "../lib/lock";
import { run } from "../lib/run";
import type { ClerkTarget } from "../lib/targets";
import { cliArgv, SKILL_DIR, type AgentName, type EvalConfig } from "./config";

/** What the agent's `clerk` may run. */
export type CliAccess = "none" | "sources" | "dry-run" | "import" | "migrate";
/** What eval:sources accepts; eval:imports always uses "import". */
export const CLI_ACCESS: CliAccess[] = ["none", "sources", "dry-run"];

/** Every turn ends with this, enforced by --json-schema / --output-schema. */
export type TurnOutput = {
  status: "question" | "done" | "blocked";
  questions: string[];
  sourceFile: string | null;
  issues: string[];
};

/** Strict-mode friendly: OpenAI requires every property listed and no extras. */
export const TURN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "questions", "sourceFile", "issues"],
  properties: {
    status: { type: "string", enum: ["question", "done", "blocked"] },
    questions: { type: "array", items: { type: "string" } },
    sourceFile: { type: ["string", "null"] },
    issues: { type: "array", items: { type: "string" } },
  },
};

export type Workspace = {
  /** The agent's working directory: the copied files and the skill, nothing else. */
  dir: string;
  /** Holds the `clerk` shim, kept out of the agent's directory. */
  bin: string;
  /** Codex's HOME. */
  home: string;
  /** The agent's TMPDIR, so no scratch file outlives the run or reaches another one. */
  tmp: string;
  root: string;
  /** The shim's log of every `clerk` call (JSONL). */
  calls: string;
  /** Holds the current question round, which the shim stamps on each call. */
  roundFile: string;
  /** The CLI's config folder (CLERK_CONFIG_DIR): the run's own link, never your linked projects. */
  clerkConfig: string;
  /** Set when the workspace is linked: the harness runs the agent's account-mode calls (see serveBroker). */
  broker?: { dir: string; target: ClerkTarget; cli: string };
};

/**
 * Builds `root/ws` with `files` copied in and the skill where `agent` looks for
 * project skills, plus a `clerk` shim limited to `access`.
 *
 * @param target - The Clerk instance the run claimed. Its secret key is baked
 *   into the shim for `dry-run`, `import` and `migrate`: Codex strips *KEY*
 *   variables from its shell, so the environment cannot carry it. For `import`
 *   and `migrate` the agent is also a logged-in customer (see linkAccount).
 */
export function createWorkspace(
  root: string,
  agent: AgentName,
  cfg: EvalConfig,
  files: string[],
  access: CliAccess,
  target?: ClerkTarget,
): Workspace {
  const ws: Workspace = {
    root, dir: join(root, "ws"), bin: join(root, "bin"), home: join(root, "home"), tmp: join(root, "tmp"),
    calls: join(root, "log", "clerk-calls.jsonl"), roundFile: join(root, "round"), clerkConfig: join(root, "clerk-config"),
  };
  mkdirSync(join(root, "log"), { recursive: true });
  mkdirSync(ws.clerkConfig, { recursive: true });
  mkdirSync(ws.dir, { recursive: true });
  mkdirSync(ws.bin, { recursive: true });
  mkdirSync(ws.tmp, { recursive: true });
  for (const f of files) copyFileSync(f, join(ws.dir, basename(f)));
  const skills = agent === "claude" ? ".claude/skills" : ".agents/skills";
  cpSync(SKILL_DIR, join(ws.dir, skills, basename(SKILL_DIR)), { recursive: true });

  if (agent === "codex") {
    mkdirSync(join(ws.home, ".codex"), { recursive: true });
    copyFileSync(join(homedir(), ".codex/auth.json"), join(ws.home, ".codex/auth.json"));
    chmodSync(join(ws.home, ".codex/auth.json"), 0o600);
  }
  const linked = target && (access === "import" || access === "migrate");
  if (linked) {
    linkAccount(ws, cfg.cli, target);
    ws.broker = { dir: join(root, "log", "broker"), target, cli: cfg.cli };
    mkdirSync(ws.broker.dir, { recursive: true });
  }
  writeShim(ws, cfg.cli, access, target, linked);
  setRound(ws, 0);
  return ws;
}

/**
 * Makes the agent a customer who ran `clerk auth login` and `clerk link`: your
 * login (the CLI keeps it in the macOS keychain, so a changed HOME doesn't hide
 * it), and the workspace linked to the target app. A secret key alone gets the
 * keyless view, where `config patch` can't change sign-in settings; a link gets
 * the full configuration. The link lives in the run's own CLERK_CONFIG_DIR, so
 * your linked projects are untouched.
 */
function linkAccount(ws: Workspace, cli: string, target: ClerkTarget) {
  mkdirSync(ws.clerkConfig, { recursive: true });
  const [cmd, ...args] = cliArgv(cli);
  try {
    execFileSync(cmd, [...args, "link", "--app", target.app], {
      cwd: ws.dir,
      env: { ...process.env, CLERK_CONFIG_DIR: ws.clerkConfig, CLERK_TELEMETRY_DISABLED: "1" },
      stdio: "pipe",
    });
  } catch (e) {
    throw new SetupError(`clerk link --app ${target.app} (${target.name}) failed, is your clerk login current? ${String((e as { stderr?: Buffer }).stderr ?? e).trim().slice(-300)}`);
  }
  const { profiles = {} } = JSON.parse(readFileSync(join(ws.clerkConfig, "config.json"), "utf8"));
  const links = Object.values(profiles) as { appId?: string; instances?: { development?: string } }[];
  if (!links.some((p) => p.appId === target.app && p.instances?.development === target.instance))
    throw new SetupError(`clerk link did not link the workspace to ${target.name}'s development instance ${target.instance}`);
}

/** Resolved now, so a `cli` of `clerk` cannot find the shim itself on PATH. */
function writeShim(ws: Workspace, cli: string, access: CliAccess, target?: ClerkTarget, linked?: boolean) {
  const argv = cliArgv(cli).map((a, i) =>
    i === 0 ? execFileSync("/bin/sh", ["-c", `command -v ${a}`], { encoding: "utf8" }).trim() : a,
  );
  const sources = `[[ "$1 $2" == "migrate sources" ]] || is_help`;
  const dryRun = `{ [[ "$1 $2" == "migrate import" && "$a" == *" --dry-run "* && "$a" != *" --yes "* && "$a" != *" -y "* ]]; }`;
  const allowed = {
    none: "false",
    sources,
    "dry-run": `${sources} || ${dryRun}`,
    // Everything an import needs, including changing instance settings (which
    // the skill only allows after the user's yes) and reading users back to
    // check the import; never undo or export.
    import: `${sources} || [[ "$1 $2" == "migrate import" || "$1 $2" == "migrate runs" || "$1 $2" == "config pull" || "$1 $2" == "config patch" || "$1 $2" == "config schema" || "$1 $2" == "users list" || "$1" == "doctor" ]]`,
    // Everything a whole migration needs: export from the source, then import.
    migrate: `${sources} || [[ "$1 $2" == "migrate export" || "$1 $2" == "migrate import" || "$1 $2" == "migrate runs" || "$1 $2" == "config pull" || "$1 $2" == "config patch" || "$1 $2" == "config schema" || "$1 $2" == "users list" || "$1" == "doctor" ]]`,
  }[access];
  const key = (access === "dry-run" || access === "import" || access === "migrate") && target ? `export CLERK_SECRET_KEY='${target.secretKey}'` : "";
  const account = linked ? `export CLERK_CONFIG_DIR='${ws.clerkConfig}'` : "";
  // Your login reaches every app in the account; the agent gets only the target.
  // ponytail: checks the first --app and --instance only; one call naming two is refused by the CLI anyway.
  const pinned = account && target
    ? `app_re=' --app[ =]([^ ]+) '; ins_re=' --instance[ =]([^ ]+) '
if { [[ "$a" =~ $app_re ]] && [[ "\${BASH_REMATCH[1]}" != '${target.app}' ]]; } ||
   { [[ "$a" =~ $ins_re ]] && [[ " dev development ${target.instance} " != *" \${BASH_REMATCH[1]} "* ]]; }; then
  echo "clerk: this eval only opens ${target.app}'s development instance ${target.instance}" >&2
  ALLOWED=false CODE=2 log "$@"
  exit 2
fi`
    : "";
  // bash 3.2 (macOS /bin/bash): no $EPOCHREALTIME, so calls are ordered by the
  // question round the runner writes before each turn.
  const shim = `#!/bin/bash
# \`clerk\` for an eval agent. Agent CLI access: ${access}.
a=" $* "
# Lets the readiness check confirm the agent's \`clerk\` is this shim.
[[ "$1" == "--eval-shim" ]] && { echo "eval-shim ${access}"; exit 0; }
is_help() { [[ "$a" == *" --help "* || "$a" == *" -h "* ]]; }
log() {
  local e="$*"; e="\${e//\\\\/\\\\\\\\}"; e="\${e//\\"/\\\\\\"}"; e="\${e//$'\\n'/\\\\n}"; e="\${e//$'\\t'/\\\\t}"
  printf '{"round":%s,"allowed":%s,"code":%s,"args":"%s"}\\n' "$(cat '${ws.roundFile}' 2>/dev/null || echo 0)" "$ALLOWED" "$CODE" "$e" >> '${ws.calls}'
}
if ! { ${allowed}; }; then
  echo "clerk: \\"clerk $*\\" is not available in this eval (agent CLI access: ${access})" >&2
  ALLOWED=false CODE=2 log "$@"
  exit 2
fi
${pinned}
${ws.broker ? brokerShim(ws.broker.dir) : ""}
export CLERK_TELEMETRY_DISABLED=1
${key}
${account}
${argv.map((a) => `'${a}'`).join(" ")} "$@"
CODE=$?
ALLOWED=true log "$@"
exit $CODE
`;
  writeFileSync(join(ws.bin, "clerk"), shim, { mode: 0o755 });
}

/**
 * Calls that need your `clerk auth login`. The login is in the macOS keychain,
 * which Codex's sandbox can't reach, so the shim hands these to the harness
 * (outside any sandbox) for both agents alike, and prints what comes back.
 */
const brokered = (args: string[]) => ["config pull", "config patch", "config schema"].includes(args.slice(0, 2).join(" ")) || args[0] === "doctor";

/**
 * The shim's half: write the request, wait for the harness's answer. NUL-separated args keep quoting intact.
 * ponytail: stdin isn't passed on, so `config patch` must take its JSON as an argument or a file.
 */
const brokerShim = (dir: string) => `if [[ "$1 $2" == "config pull" || "$1 $2" == "config patch" || "$1 $2" == "config schema" || "$1" == "doctor" ]]; then
  req='${dir}'/"$$-$RANDOM"
  printf '%s' "$PWD" > "$req.cwd"
  printf '%s\\0' "$@" > "$req.tmp" && mv "$req.tmp" "$req.args"
  for ((i = 0; i < 1200; i++)); do [[ -f "$req.code" ]] && break; sleep 0.1; done
  if [[ -f "$req.code" ]]; then
    cat "$req.out"; cat "$req.err" >&2; CODE=$(cat "$req.code")
  else
    echo "clerk: no answer from the eval harness in 120s" >&2; CODE=2
  fi
  rm -f "$req".*
  ALLOWED=true log "$@"
  exit $CODE
fi`;

/** Whether `dir` is `root` or below it. Real paths: macOS's temp folder is /var to one process and /private/var to another. */
const inside = (root: string, dir: string) => {
  try {
    const rel = relative(realpathSync(root), realpathSync(dir));
    return !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
};

/** The value after `flag` (`--app x` or `--app=x`), if given. */
const flagValue = (args: string[], flag: string) => {
  const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  return i < 0 ? undefined : args[i].includes("=") ? args[i].slice(flag.length + 1) : args[i + 1];
};

/**
 * The harness's half of the broker: while a turn runs, runs each request the
 * shim leaves with your login and the workspace's link, and writes back stdout,
 * stderr and the exit code (the code last, which is what the shim waits for).
 * The request folder is writable from the sandbox, so the shim's checks are
 * repeated here: only brokered commands, only the target, only in the workspace.
 *
 * @returns Stops serving once every request already picked up has been answered.
 */
export function serveBroker(ws: Workspace): () => Promise<void> {
  const b = ws.broker;
  if (!b) return async () => {};
  const pending = new Set<Promise<void>>();
  const seen = new Set<string>();
  const answer = async (id: string) => {
    const base = join(b.dir, id);
    const args = readFileSync(`${base}.args`, "utf8").split("\0").slice(0, -1);
    const cwd = existsSync(`${base}.cwd`) ? readFileSync(`${base}.cwd`, "utf8") : ws.dir;
    const app = flagValue(args, "--app");
    const instance = flagValue(args, "--instance");
    const refusal =
      !brokered(args) ? `"clerk ${args.join(" ")}" is not run by the eval harness`
      : !inside(ws.dir, cwd) ? "clerk calls must run inside the workspace"
      : (app && app !== b.target.app) || (instance && !["dev", "development", b.target.instance].includes(instance))
        ? `this eval only opens ${b.target.app}'s development instance ${b.target.instance}`
        : undefined;
    const [cmd, ...pre] = cliArgv(b.cli);
    const r = refusal
      ? { code: 2, stdout: "", stderr: `clerk: ${refusal}\n` }
      : await run(cmd, [...pre, ...args], {
          ...process.env, CLERK_CONFIG_DIR: ws.clerkConfig, CLERK_SECRET_KEY: b.target.secretKey, CLERK_TELEMETRY_DISABLED: "1",
        }, { cwd, timeoutMs: 110_000 }).catch((e: Error) => ({ code: 2, stdout: "", stderr: `clerk: ${e.message}\n` }));
    writeFileSync(`${base}.out`, r.stdout);
    writeFileSync(`${base}.err`, r.stderr);
    writeFileSync(`${base}.code.tmp`, String(r.code));
    renameSync(`${base}.code.tmp`, `${base}.code`);
  };
  const timer = setInterval(() => {
    for (const f of readdirSync(b.dir)) {
      const id = f.endsWith(".args") ? f.slice(0, -5) : undefined;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const p = answer(id).catch(() => {}).finally(() => pending.delete(p));
      pending.add(p);
    }
  }, 100);
  return async () => {
    clearInterval(timer);
    await Promise.all(pending);
  };
}

/** One line per `clerk` call the agent made, from the shim's log. */
export type ShimCall = { round: number; allowed: boolean; code: number; args: string };

export function readCalls(ws: Workspace): ShimCall[] {
  if (!existsSync(ws.calls)) return [];
  return readFileSync(ws.calls, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    const c = parseJson<ShimCall>(l);
    return c ? [c] : [];
  });
}

/** Tells the shim which question round the next turn is, for ordering its log. */
export const setRound = (ws: Workspace, round: number) => writeFileSync(ws.roundFile, String(round));

export type Turn = {
  code: number;
  sessionId?: string;
  output?: TurnOutput;
  /** Raw JSONL events, for the transcript. */
  events: string;
  stderr: string;
  seconds: number;
  /** Claude only: skills from the init event. */
  skills?: string[];
};

/**
 * One agent turn: a new session, or `resume` an earlier one with `prompt` as
 * the next user message.
 */
export async function runTurn(
  agent: AgentName,
  cfg: EvalConfig,
  ws: Workspace,
  prompt: string,
  opts: { resume?: string; access: CliAccess; timeoutMs?: number; system?: string },
): Promise<Turn> {
  const { model, effort } = cfg.agents[agent];
  // pnpm puts this repo's node_modules/.bin on PATH; that would hand the agent
  // the repo's location (and its tools), so only directories outside it pass.
  const path = (process.env.PATH ?? "").split(":").filter((d) => !d.startsWith(process.cwd())).join(":");
  const env = { ...process.env, PATH: `${ws.bin}:${path}`, TMPDIR: ws.tmp };
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;

  if (agent === "claude") {
    const args = [
      "-p", prompt,
      "--output-format", "stream-json", "--verbose",
      "--model", model, "--effort", effort,
      "--json-schema", JSON.stringify(TURN_SCHEMA),
      "--setting-sources", "project",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--permission-mode", "acceptEdits",
      // node/bun/python3/jq for analysing the export and running the source: Codex can run anything in its
      // sandbox, so without these Claude would be the only one reading JSON by eye.
      "--allowedTools", [
        "Skill", "Read", "Write", "Edit", "Glob", "Grep", "Bash(node:*)", "Bash(bun:*)", "Bash(python3:*)", "Bash(jq:*)",
        ...(opts.access === "none" ? [] : ["Bash(clerk:*)"]),
      ].join(","),
      // Questions go through the turn output, so the runner can answer them.
      "--disallowedTools", "AskUserQuestion,WebFetch,WebSearch",
      // Sent on every turn: a resumed print-mode session takes its system prompt from the flags.
      ...(opts.system ? ["--append-system-prompt", opts.system] : []),
      ...(opts.resume ? ["--resume", opts.resume] : []),
    ];
    const stopBroker = serveBroker(ws);
    const r = await run("claude", args, env, { cwd: ws.dir, timeoutMs }).finally(stopBroker);
    const events = r.stdout.split("\n").filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return {};
      }
    });
    const init = events.find((e) => e.type === "system" && e.subtype === "init");
    const result = events.find((e) => e.type === "result");
    let output = result?.structured_output as TurnOutput | undefined;
    if (!output && typeof result?.result === "string") output = parseJson(result.result);
    return {
      code: r.code,
      sessionId: result?.session_id ?? init?.session_id,
      output,
      events: r.stdout,
      stderr: r.stderr,
      seconds: Math.round((Date.now() - started) / 1000),
      skills: init?.skills,
    };
  }

  const schemaFile = join(ws.root, "turn-schema.json");
  const lastFile = join(ws.root, "last-message.json");
  writeFileSync(schemaFile, JSON.stringify(TURN_SCHEMA));
  writeFileSync(lastFile, "");
  const flags = [
    "--json", "--skip-git-repo-check",
    "-m", model,
    "-c", `model_reasoning_effort="${effort}"`,
    "-c", 'sandbox_mode="workspace-write"',
    // A login shell runs macOS path_helper, which puts /opt/homebrew/bin (and
    // any real `clerk` there) ahead of the shim.
    "-c", "allow_login_shell=false",
    // The shared /tmp carried one run's scratch scripts into later runs; TMPDIR (ws.tmp) stays writable.
    "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
    // The shim runs inside the sandbox: it appends to the call log, and the CLI
    // writes its config. Neither is under the workspace or TMPDIR.
    "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([dirname(ws.calls), ws.clerkConfig])}`,
    // The dry run and import call Clerk; the workspace-write sandbox blocks the network otherwise.
    "-c", `sandbox_workspace_write.network_access=${opts.access !== "none" && opts.access !== "sources"}`,
    ...(opts.system ? ["-c", `developer_instructions=${JSON.stringify(opts.system)}`] : []),
    "--output-schema", schemaFile,
    "-o", lastFile,
  ];
  const args = opts.resume ? ["exec", "resume", ...flags, opts.resume, prompt] : ["exec", ...flags, prompt];
  await syncCodexLogin(ws, "in");
  const stopBroker = serveBroker(ws);
  const r = await run("codex", args, { ...env, HOME: ws.home, CODEX_HOME: join(ws.home, ".codex") }, { cwd: ws.dir, timeoutMs }).finally(stopBroker);
  await syncCodexLogin(ws, "out");
  const thread = r.stdout.split("\n").map((l) => parseJson<{ type?: string; thread_id?: string }>(l)).find((e) => e?.type === "thread.started");
  return {
    code: r.code,
    sessionId: thread?.thread_id ?? opts.resume,
    output: parseJson(readFileSync(lastFile, "utf8")),
    events: r.stdout,
    stderr: r.stderr,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

function parseJson<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

/**
 * Codex refresh tokens rotate: a refresh in one temp home kills the token every
 * other copy holds. So whichever copy is newer wins, both ways: before a turn
 * the workspace takes a newer login (another run refreshed it), after a turn
 * the real ~/.codex/auth.json takes a newer one. Under a lock, since parallel
 * batches each have their own temp homes.
 */
async function syncCodexLogin(ws: Workspace, direction: "in" | "out") {
  const real = join(homedir(), ".codex/auth.json");
  const temp = join(ws.home, ".codex/auth.json");
  if (!existsSync(temp)) return;
  const release = await lockProviders(["codex-auth"], "codex login sync", 200);
  try {
    const a = readFileSync(real, "utf8");
    const b = readFileSync(temp, "utf8");
    if (a === b) return;
    const refreshed = (s: string) => Date.parse(parseJson<{ last_refresh?: string }>(s)?.last_refresh ?? "") || 0;
    if (direction === "out" && refreshed(b) > refreshed(a)) writeFileSync(real, b, { mode: 0o600 });
    if (direction === "in" && refreshed(a) > refreshed(b)) writeFileSync(temp, a, { mode: 0o600 });
  } finally {
    release();
  }
}

// ── accounts ──

export type Account = { ok: boolean; version: string; detail: string };

export async function claudeAccount(): Promise<Account> {
  const version = (await run("claude", ["--version"])).stdout.trim();
  const s = parseJson<{ loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string; orgName?: string }>(
    (await run("claude", ["auth", "status", "--json"])).stdout,
  );
  if (!s?.loggedIn) return { ok: false, version, detail: "not signed in: run `claude auth login`" };
  return { ok: true, version, detail: `${s.email} (${s.subscriptionType ?? s.authMethod}, org "${s.orgName}")` };
}

export async function codexAccount(): Promise<Account> {
  const version = (await run("codex", ["--version"])).stdout.trim();
  const status = await run("codex", ["login", "status"]);
  if (status.code !== 0) return { ok: false, version, detail: "not signed in: run `codex login`" };
  const auth = parseJson<{ tokens?: { id_token?: string }; OPENAI_API_KEY?: string | null }>(
    readFileSync(resolve(homedir(), ".codex/auth.json"), "utf8"),
  );
  const token = auth?.tokens?.id_token;
  if (!token) return { ok: true, version, detail: `${(status.stdout + status.stderr).trim()} (no ChatGPT account: API key)` };
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  const plan = claims["https://api.openai.com/auth"]?.chatgpt_plan_type;
  return { ok: true, version, detail: `${claims.email} (ChatGPT ${plan ?? "plan unknown"})` };
}
