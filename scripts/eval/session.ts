/**
 * The part every eval shares: run an agent turn by turn, answer its questions
 * from an answer set (or the person at the terminal), until it says it is done
 * or blocked.
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { runTurn, setRound, type CliAccess, type TurnOutput, type Workspace } from "./agents";
import { LATE, loadSet, lookup, resolveEnv, saveAnswer, type AnswerSet } from "./answers";
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
          // One answer often covers several topics ("yes to both"): Enter saves it under all of them.
          const suggested = matched[i].join(",");
          let chosen = matched[i].length === 1 ? matched[i] : [];
          while (!chosen.length || chosen.some((t) => !(t in topics))) {
            const raw = (await ask(
              `Topic(s), comma-separated${suggested ? ` [Enter = ${suggested}]` : ""} (${Object.keys(topics).join(", ")}): `,
            )).trim();
            chosen = (raw || suggested).split(",").map((t) => t.trim()).filter(Boolean);
            const unknown = chosen.filter((t) => !(t in topics));
            if (unknown.length) console.log(`Not a topic: ${unknown.join(", ")}`);
          }
          for (const t of chosen.filter((t) => lookup(set, provider, t))) {
            console.log(`${provider} already answers ${t}; the new answer is added below it and the first one still wins.`);
          }
          const version = saveAnswer(set, provider, chosen, text);
          set = loadSet(set.name, set.dir);
          console.log(`Saved as ${chosen.join(", ")}; "${set.name}" is now v${version}.`);
        }
      }
      return out;
    },
  };
}

export type Answerer = ReturnType<typeof answerer>;

/** QA keeps `{{env:…}}` as written, so result.md shows no secrets; only the agent gets the values. */
const answersPrompt = (qa: QA[]) =>
  ["The customer answered:", "", ...qa.flatMap((q) => [`Q: ${q.question}`, `A: ${resolveEnv(q.answer)}`, ""])].join("\n");

export type Session = {
  /** "timeout": a turn stalled twice (seen when the model's stream breaks and never resumes). */
  status: TurnOutput["status"] | "error" | "stuck" | "timeout";
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
  /** Appended to the agent's system prompt on every turn. */
  system?: string;
}): Promise<Session> {
  const s: Session = { status: "error", rounds: 0, qa: [], issues: [] };
  let prompt = opts.prompt;
  let session: string | undefined;
  let late = lookup(opts.answers.set, opts.provider, LATE);
  for (let round = 1; ; round++) {
    s.rounds = round;
    setRound(opts.ws, round);
    appendFileSync(opts.transcript, JSON.stringify({ eval: "prompt", round, prompt, ...(round === 1 && opts.system ? { system: opts.system } : {}) }) + "\n");
    let turn = await runTurn(opts.agent, opts.cfg, opts.ws, prompt, { access: opts.access, resume: session, system: opts.system });
    appendFileSync(opts.transcript, turn.events + (turn.stderr ? JSON.stringify({ eval: "stderr", round, stderr: turn.stderr }) + "\n" : ""));
    session = turn.sessionId ?? session;
    // A stalled turn (a broken stream that never resumed) is not the agent's
    // answer: resume the session once before calling it.
    if (turn.code === 124 && session) {
      s.issues.push(`[harness] round ${round} stalled with no output for ${Math.round(turn.seconds / 60)} min; resumed once`);
      const retry = "Your last turn was interrupted before it finished. Continue from where you were.";
      appendFileSync(opts.transcript, JSON.stringify({ eval: "prompt", round, prompt: retry, retryOfStall: true }) + "\n");
      turn = await runTurn(opts.agent, opts.cfg, opts.ws, retry, { access: opts.access, resume: session, system: opts.system });
      appendFileSync(opts.transcript, turn.events + (turn.stderr ? JSON.stringify({ eval: "stderr", round, stderr: turn.stderr }) + "\n" : ""));
      session = turn.sessionId ?? session;
      if (turn.code === 124) {
        s.status = "timeout";
        s.issues.push(`[harness] round ${round} stalled again after resuming; stopped`);
        return s;
      }
    }
    s.output = turn.output ?? s.output;
    if (turn.code !== 0 || !turn.output) {
      s.status = "error";
      s.issues.push(`turn ${round}: exit ${turn.code}${turn.code === 124 ? " (timed out)" : ""}, ${turn.output ? "" : "no structured output: "}${turn.stderr.trim().split("\n").slice(-2).join(" ")}`);
      return s;
    }
    s.issues.push(...turn.output.issues.map((i) => (round > 1 ? `[round ${round}] ${i}` : i)));
    if (turn.output.status === "done" && late && round < MAX_ROUNDS) {
      s.qa.push({
        round, question: "(nothing asked: the customer wrote in after the agent said it was done)", topics: [LATE],
        answer: late.text, by: "set", tags: late.tag ? [`${LATE}: ${late.tag}`] : [],
      });
      prompt = `The customer wrote back:\n\n${resolveEnv(late.text)}`;
      late = undefined;
      continue;
    }
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
