/**
 * The part every eval shares: run an agent turn by turn, answer its questions
 * from an answer set (or the person at the terminal), until it says it is done
 * or blocked.
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { runTurn, setRound, type CliAccess, type TurnOutput, type Workspace } from "./agents";
import { loadSet, lookup, saveAnswer, type AnswerSet } from "./answers";
import { classify } from "./classify";
import type { AgentName, EvalConfig } from "./config";

/** Question rounds before a run is called stuck. */
export const MAX_ROUNDS = 6;

export type QA = {
  /** The round the agent asked in; the answer arrives in the next one. */
  round: number;
  question: string;
  topics: string[];
  answer: string;
  by: "set" | "fallback" | "you";
  tags: string[];
};

const tty = process.stdin.isTTY;
/** Opens the terminal only while asking, so keys pressed during a run are not swallowed into an answer. */
async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/**
 * Answers questions from `set`; the set is reloaded when an answer typed at
 * the terminal is saved into it, so later runs in the batch use it.
 */
export function answerer(initial: AnswerSet, topics: Record<string, string>) {
  let set = initial;
  return {
    get set() {
      return set;
    },
    async answer(label: string, provider: string, round: number, questions: string[]): Promise<QA[]> {
      const matched = await classify(questions, topics);
      const out: QA[] = [];
      for (const [i, question] of questions.entries()) {
        const found = matched[i].map((t) => lookup(set, provider, t)).filter((a) => a !== undefined);
        if (found.length) {
          out.push({
            round, question, topics: matched[i], by: "set",
            answer: found.map((a) => a.text).join("\n\n"),
            tags: found.flatMap((a) => (a.tag ? [`${a.topic}: ${a.tag}`] : [])),
          });
          continue;
        }
        if (set.fallback !== "ask-human") {
          out.push({ round, question, topics: matched[i], by: "fallback", answer: set.fallback, tags: [] });
          continue;
        }
        if (!tty) {
          out.push({ round, question, topics: matched[i], by: "fallback", answer: "I don't know.", tags: ["no terminal to ask"] });
          continue;
        }
        console.log(`\n── Question from ${label} · round ${round} ──\n${question}`);
        console.log(`(set "${set.name}" has no answer${matched[i].length ? ` for ${matched[i].join(", ")}` : ""})`);
        const text = (await ask("Your answer: ")).trim() || "I don't know.";
        out.push({ round, question, topics: matched[i], by: "you", answer: text, tags: [] });

        const save = (await ask(`Save to set "${set.name}" for ${provider}? [y/N] `)).trim().toLowerCase();
        if (save === "y" || save === "yes") {
          let topic = matched[i].length === 1 ? matched[i][0] : "";
          while (!(topic in topics)) topic = (await ask(`Topic (${Object.keys(topics).join(", ")}): `)).trim();
          if (lookup(set, provider, topic)) console.log(`${provider} already answers ${topic}; the new answer is added below it and the first one still wins.`);
          const version = saveAnswer(set, provider, topic, text);
          set = loadSet(set.name, set.dir);
          console.log(`Saved as ${topic}; "${set.name}" is now v${version}.`);
        }
      }
      return out;
    },
  };
}

export type Answerer = ReturnType<typeof answerer>;

/** The rules of the conversation, shared by every eval's first prompt. */
export const SESSION_RULES = [
  "How this session works:",
  "- You cannot talk to the customer directly. When you need information or a decision from them, end your turn with " +
    'status "question" and put each question in `questions`, one question per item. Their answers arrive as the next message.',
  '- If you cannot finish, end with status "blocked" and explain in `issues`.',
  "- Use `issues` for any problem, assumption or blocker worth a reviewer's attention.",
];

const answersPrompt = (qa: QA[]) =>
  ["The customer answered:", "", ...qa.flatMap((q) => [`Q: ${q.question}`, `A: ${q.answer}`, ""])].join("\n");

export type Session = {
  status: TurnOutput["status"] | "error" | "stuck";
  rounds: number;
  qa: QA[];
  issues: string[];
  /** The agent's last structured output. */
  output?: TurnOutput;
};

/**
 * Turns until the agent is done, blocked, errors or runs out of rounds.
 * Everything the agent and runner say is appended to `transcript`.
 *
 * @param label - Shown with a question at the terminal, e.g. "claude · gatekeep.csv".
 */
export async function runSession(opts: {
  agent: AgentName;
  cfg: EvalConfig;
  ws: Workspace;
  access: CliAccess;
  prompt: string;
  provider: string;
  label: string;
  answers: Answerer;
  transcript: string;
}): Promise<Session> {
  const s: Session = { status: "error", rounds: 0, qa: [], issues: [] };
  let prompt = opts.prompt;
  let session: string | undefined;
  for (let round = 1; ; round++) {
    s.rounds = round;
    setRound(opts.ws, round);
    appendFileSync(opts.transcript, JSON.stringify({ eval: "prompt", round, prompt }) + "\n");
    const turn = await runTurn(opts.agent, opts.cfg, opts.ws, prompt, { access: opts.access, resume: session });
    appendFileSync(opts.transcript, turn.events + (turn.stderr ? JSON.stringify({ eval: "stderr", round, stderr: turn.stderr }) + "\n" : ""));
    session = turn.sessionId ?? session;
    s.output = turn.output ?? s.output;
    if (turn.code !== 0 || !turn.output) {
      s.status = "error";
      s.issues.push(`turn ${round}: exit ${turn.code}${turn.code === 124 ? " (timed out)" : ""}, ${turn.output ? "" : "no structured output: "}${turn.stderr.trim().split("\n").slice(-2).join(" ")}`);
      return s;
    }
    s.issues.push(...turn.output.issues.map((i) => (round > 1 ? `[round ${round}] ${i}` : i)));
    if (turn.output.status !== "question") {
      s.status = turn.output.status;
      return s;
    }
    if (round >= MAX_ROUNDS) {
      s.status = "stuck";
      s.issues.push(`still asking questions after ${MAX_ROUNDS} rounds`);
      return s;
    }
    const qa = await opts.answers.answer(opts.label, opts.provider, round, turn.output.questions);
    s.qa.push(...qa);
    prompt = answersPrompt(qa);
  }
}

/** Anything in a transcript pointing at the answers, or at this repo at all. */
export function contamination(transcript: string, markers: string[]): string[] {
  return [process.cwd(), ...markers].filter((m) => transcript.includes(m));
}

export const minutes = (s: number) => `${(s / 60).toFixed(1)}`;

export const counts = (qa: QA[]) => ({
  set: qa.filter((q) => q.by === "set").length,
  fallback: qa.filter((q) => q.by === "fallback").length,
  you: qa.filter((q) => q.by === "you").length,
});

/** The Q&A section of a result.md. */
export function qaMarkdown(qa: QA[]): string[] {
  const lines = ["## Questions and answers", ""];
  if (!qa.length) lines.push("The agent asked nothing.", "");
  for (const q of qa) {
    lines.push(
      `**Round ${q.round} · ${q.topics.join(", ") || "no topic"} · answered by ${q.by}${q.tags.length ? ` · ${q.tags.join(", ")}` : ""}**`,
      "",
      `> ${q.question.replace(/\n/g, "\n> ")}`,
      "",
      q.answer,
      "",
    );
  }
  return lines;
}
