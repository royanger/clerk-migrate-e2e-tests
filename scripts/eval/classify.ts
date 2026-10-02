/**
 * Maps an agent's questions onto answer-set topics with a small model, so the
 * agent never sees the topic list (which would hint at what to ask).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../lib/run";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matches"],
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "topics"],
        properties: { index: { type: "integer" }, topics: { type: "array", items: { type: "string" } } },
      },
    },
  },
};

/**
 * @returns For each question, the topics it asks about (possibly several, or none).
 */
export async function classify(questions: string[], topics: Record<string, string>, model = "haiku"): Promise<string[][]> {
  if (!questions.length) return [];
  const prompt = [
    "Classify each question a developer asked a customer about their user-export file.",
    "Topics (name: what it covers):",
    ...Object.entries(topics).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "Questions:",
    ...questions.map((q, i) => `${i}. ${q.replace(/\s+/g, " ")}`),
    "",
    "For every question index, list the topics it asks about. Usually one; several if the question bundles " +
      "them; none if no topic fits. Use only the topic names above.",
  ].join("\n");
  // An empty cwd and project-only settings: nothing of the user's or this repo's loads.
  const cwd = mkdtempSync(join(tmpdir(), "eval-classify-"));
  try {
    const r = await run("claude", [
      "-p", prompt, "--output-format", "json", "--model", model,
      "--json-schema", JSON.stringify(SCHEMA),
      "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--tools", "",
    ], process.env, { cwd, timeoutMs: 120_000 });
    const out = JSON.parse(r.stdout);
    const matches = (out.structured_output ?? JSON.parse(out.result)).matches as { index: number; topics: string[] }[];
    return questions.map((_, i) => (matches.find((m) => m.index === i)?.topics ?? []).filter((t) => t in topics));
  } catch {
    // Unclassified questions fall through to the set's fallback or the human.
    return questions.map(() => []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
