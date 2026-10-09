/**
 * Answer sets: pre-written answers to the questions an agent asks. Each eval
 * has its own folder of sets and its own topics.json, so its answers can be
 * tuned to exactly what that eval asks:
 *   evals/answer-sets/sources/      eval:sources (writing a source)
 *   evals/answer-sets/imports/      eval:imports (importing an export file)
 *   evals/answer-sets/migrations/   eval:migrations (exporting, then importing)
 * Layout and file format: evals/answer-sets/README.md. A set's `all.md`
 * answers for every provider; `<provider>.md` overrides it.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashTree } from "./config";

export type EvalKind = "sources" | "imports" | "migrations";
/** The folder holding one eval's answer sets. */
export const setsDir = (kind: EvalKind) => join("evals/answer-sets", kind);

export type Answer = { topic: string; tag?: string; text: string };

/**
 * `## late`: not an answer to anything. The runner sends it once, unasked, the
 * first time the agent says it's done: the customer changing their mind.
 */
export const LATE = "late";

export type AnswerSet = {
  name: string;
  /** The folder of sets this one lives in. */
  dir: string;
  version: number;
  description: string;
  /** "ask-human", or the text sent for any question the set does not cover. */
  fallback: string;
  /** Content hash of the whole set, so a result names exactly what was told. */
  hash: string;
  /** provider (or "all") → topic → answer. */
  answers: Map<string, Map<string, Answer>>;
  /** Everything else in set.json, for eval-specific settings. */
  meta: Record<string, unknown>;
};

/** topic → what it covers, from topics.json. */
export function loadTopics(dir: string): Record<string, string> {
  return JSON.parse(readFileSync(join(dir, "topics.json"), "utf8"));
}

export function listSets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "set.json")))
    .map((d) => d.name);
}

/** `## hasher (wrong)` → { topic: "hasher", tag: "wrong" }, then the text up to the next heading. */
export function parseAnswers(md: string): Map<string, Answer> {
  const out = new Map<string, Answer>();
  const parts = md.split(/^## +/m).slice(1);
  for (const part of parts) {
    const [heading, ...body] = part.split("\n");
    const m = heading.trim().match(/^([\w-]+)(?:\s*\(([^)]*)\))?\s*$/);
    if (!m) throw new Error(`Bad answer heading "## ${heading.trim()}": expected "## <topic>" or "## <topic> (<tag>)"`);
    out.set(m[1], { topic: m[1], tag: m[2]?.trim() || undefined, text: body.join("\n").trim() });
  }
  return out;
}

export function loadSet(name: string, folder: string): AnswerSet {
  const dir = join(folder, name);
  if (!existsSync(join(dir, "set.json"))) {
    throw new Error(`No answer set "${name}" in ${folder}. Have: ${listSets(folder).join(", ")}`);
  }
  const meta = JSON.parse(readFileSync(join(dir, "set.json"), "utf8"));
  const topics = loadTopics(folder);
  const answers = new Map<string, Map<string, Answer>>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const parsed = parseAnswers(readFileSync(join(dir, file), "utf8"));
    for (const topic of parsed.keys()) {
      if (!topics[topic] && topic !== LATE) throw new Error(`${dir}/${file}: topic "${topic}" is not in topics.json`);
    }
    answers.set(file.replace(/\.md$/, ""), parsed);
  }
  return {
    name,
    dir: folder,
    meta,
    version: Number(meta.version ?? 1),
    description: meta.description ?? "",
    fallback: meta.fallback ?? "ask-human",
    hash: hashTree(dir),
    answers,
  };
}

const ENV_REF = /\{\{env:(\w+)\}\}/g;

/**
 * `{{env:NAME}}` → that environment variable, filled in only when an answer is
 * sent, so set files hold no secrets (pnpm's `op run` puts them in the env).
 */
export function resolveEnv(text: string): string {
  return text.replace(ENV_REF, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`An answer uses {{env:${name}}}, which is not set: add it to op.env`);
    return v;
  });
}

/** Every `{{env:NAME}}` the set's answers for `providers` use (all.md included). */
export function envRefs(set: AnswerSet, providers?: string[]): string[] {
  const files = [...set.answers].filter(([p]) => p === "all" || !providers || providers.includes(p));
  return [...new Set(files.flatMap(([, a]) => [...a.values()].flatMap((x) => [...x.text.matchAll(ENV_REF)].map((m) => m[1]))))];
}

/** The set's answer for `provider` on `topic`: its own file first, then all.md. */
export function lookup(set: AnswerSet, provider: string, topic: string): Answer | undefined {
  return set.answers.get(provider)?.get(topic) ?? set.answers.get("all")?.get(topic);
}

/**
 * Adds an answer typed during an eval to the set, under each of `topics`,
 * tagged with the date, and bumps the set's version once. Replaces nothing: if
 * a topic already has an answer, the new heading is added below it and the
 * first one keeps winning, so check before saving.
 */
export function saveAnswer(set: AnswerSet, provider: string, topics: string[], text: string, date = new Date()) {
  const dir = join(set.dir, set.name);
  const file = join(dir, `${provider}.md`);
  for (const topic of topics) {
    const sep = existsSync(file) && readFileSync(file, "utf8").trim() ? "\n" : "";
    appendFileSync(file, `${sep}## ${topic} (added ${date.toISOString().slice(0, 10)})\n${text.trim()}\n`);
  }
  const metaFile = join(dir, "set.json");
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  meta.version = Number(meta.version ?? 1) + 1;
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");
  return meta.version as number;
}
