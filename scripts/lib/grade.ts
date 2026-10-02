/**
 * Grades an import against an answer key from generate-custom-exports.ts.
 *
 * Every expected fact about a user is one check: it exists, each email and
 * phone (and whether it is verified), the primary of each, username, names,
 * banned, password, and each metadata key. Accuracy is checks passed over
 * checks made. A user that never landed fails every one of its checks, so
 * losing a user costs more than getting one field wrong.
 *
 * Failures are grouped by field + reason, so five users with a broken phone are
 * one problem listing five IDs, not five problems.
 */
import { isDeepStrictEqual } from "node:util";
import type { User } from "@clerk/backend";
import type { AnswerKey, Expected } from "../generate-custom-exports";

export type Problem = { field: string; reason: string; ids: string[]; example?: string };

export type Grade = {
  grade: string;
  accuracy: number;
  passed: number;
  total: number;
  users: { expected: number; shouldImport: number; imported: number; correct: number; withProblems: number; notImported: number };
  problems: Problem[];
  /** Not graded: advisory metadata placements and stray metadata keys. */
  notes: Problem[];
};

type Check = { field: string; ok: boolean; reason?: string; example?: string; note?: boolean };

const META = { publicMetadata: "public", privateMetadata: "private", unsafeMetadata: "unsafe" } as const;
type MetaField = keyof typeof META;

export function letter(accuracy: number): string {
  if (accuracy === 1) return "A+";
  if (accuracy >= 0.95) return "A";
  if (accuracy >= 0.85) return "B";
  if (accuracy >= 0.7) return "C";
  if (accuracy >= 0.5) return "D";
  return "F";
}

const show = (v: unknown) => (v === undefined || v === null || v === "" ? "none" : JSON.stringify(v));

/** Checks for one expected user against what Clerk holds (`u` absent = not imported). */
function checksFor(e: Expected, u: User | undefined, badPasswords: Set<string>, placement: AnswerKey["metadataPlacement"]): Check[] {
  const checks: Check[] = [{ field: "user", ok: Boolean(u), reason: "not imported" }];

  // ── identifiers: each expected one present, verified as expected, nothing extra ──
  const idChecks = (
    kind: "email" | "phone",
    verified: string[],
    unverified: string[],
    primary: string | undefined,
    held: { value: string; verified: boolean; id: string }[],
    primaryId: string | null | undefined,
  ) => {
    const find = (v: string) => held.find((h) => h.value.toLowerCase() === v.toLowerCase());
    for (const v of verified) {
      const h = find(v);
      checks.push({ field: kind, ok: Boolean(h?.verified), reason: h ? "not verified" : "missing", example: `expected ${v}` });
    }
    for (const v of unverified) {
      const h = find(v);
      checks.push({ field: kind, ok: Boolean(h && !h.verified), reason: h ? "verified, should be unverified" : "missing", example: `expected ${v} (unverified)` });
    }
    if (primary) {
      const got = held.find((h) => h.id === primaryId)?.value;
      checks.push({ field: `primary ${kind}`, ok: got?.toLowerCase() === primary.toLowerCase(), reason: "wrong value", example: `expected ${primary}, got ${show(got)}` });
    }
    const want = new Set([...verified, ...unverified].map((v) => v.toLowerCase()));
    for (const h of held) {
      if (!want.has(h.value.toLowerCase())) checks.push({ field: kind, ok: false, reason: "unexpected value", example: `got ${h.value}` });
    }
  };
  idChecks(
    "email", e.emails, e.unverifiedEmails, e.primaryEmail,
    (u?.emailAddresses ?? []).map((a) => ({ value: a.emailAddress, verified: a.verification?.status === "verified", id: a.id })),
    u?.primaryEmailAddressId,
  );
  idChecks(
    "phone", e.phones, e.unverifiedPhones, e.primaryPhone,
    (u?.phoneNumbers ?? []).map((p) => ({ value: p.phoneNumber, verified: p.verification?.status === "verified", id: p.id })),
    u?.primaryPhoneNumberId,
  );

  // ── plain fields: checked when either side has a value ──
  for (const field of ["username", "firstName", "lastName"] as const) {
    const want = e[field];
    const got = u?.[field] ?? undefined;
    if (!want && !got) continue;
    // Clerk lowercases usernames.
    const same = field === "username" ? want?.toLowerCase() === got?.toLowerCase() : want === got;
    checks.push({
      field,
      ok: same,
      reason: !got ? "missing" : !want ? "unexpected value" : "wrong value",
      example: `expected ${show(want)}, got ${show(got)}`,
    });
  }
  checks.push({ field: "banned", ok: Boolean(u?.banned) === e.banned, reason: "wrong value", example: `expected ${e.banned}, got ${Boolean(u?.banned)}` });

  if (e.hasPassword) {
    const ok = Boolean(u?.passwordEnabled) && !badPasswords.has(u!.id);
    checks.push({ field: "password", ok, reason: u?.passwordEnabled ? "won't sign in" : "missing" });
  } else if (u?.passwordEnabled) {
    checks.push({ field: "password", ok: false, reason: "unexpected value" });
  }

  // ── metadata: each expected key, by value, wherever it landed ──
  const fields = Object.keys(META) as MetaField[];
  const held = (f: MetaField) => ((u?.[f] ?? {}) as Record<string, unknown>);
  const expectedKeys = new Set<string>();
  for (const want of fields) {
    for (const [k, v] of Object.entries(e[want])) {
      expectedKeys.add(k);
      const where = fields.filter((f) => isDeepStrictEqual(held(f)[k], v));
      const there = fields.find((f) => k in held(f));
      const reason = where.length ? "wrong metadata field" : there ? "wrong value" : "missing";
      const example = where.length
        ? `${k} expected in ${META[want]}, found in ${where.map((f) => META[f]).join(" + ")}`
        : `${k} expected ${show(v)}, got ${there ? show(held(there)[k]) : "none"}`;
      if (placement === "strict") {
        checks.push({ field: "metadata", ok: where.includes(want), reason, example });
      } else {
        checks.push({ field: "metadata", ok: where.length > 0, reason, example });
        if (where.length && !where.includes(want)) checks.push({ field: "metadata", ok: false, reason, example, note: true });
      }
    }
  }
  for (const f of fields) {
    for (const k of Object.keys(held(f))) {
      if (!expectedKeys.has(k)) checks.push({ field: "metadata", ok: false, reason: "unexpected key", example: `${META[f]}.${k} = ${show(held(f)[k])}`, note: true });
    }
  }
  return checks;
}

/**
 * @param users - Everything in the Clerk instance after the import.
 * @param rejected - Source ID → why the CLI did not create that user.
 * @param badPasswords - Clerk IDs whose password did not verify.
 */
export function grade(key: AnswerKey, users: User[], rejected: Map<string, string>, badPasswords: Set<string>): Grade {
  const problems = new Map<string, Problem>();
  const notes = new Map<string, Problem>();
  const add = (into: Map<string, Problem>, field: string, reason: string, id: string, example?: string) => {
    const k = `${field}\u0000${reason}`;
    const p = into.get(k) ?? into.set(k, { field, reason, ids: [], example }).get(k)!;
    if (!p.ids.includes(id)) p.ids.push(id);
  };

  const byExternal = new Map(users.filter((u) => u.externalId).map((u) => [u.externalId!, u]));
  const claimed = new Set<string>();
  let passed = 0;
  let total = 0;
  let imported = 0;
  let correct = 0;
  let importedCorrect = 0;
  let notImported = 0;

  for (const e of key.users) {
    let u = byExternal.get(e.externalId);
    let idProblem: string | undefined;
    // A wrong userId mapping still lands the user: find it by identifier so the
    // rest of its fields are graded, and report the ID once.
    if (!u) {
      const mine = new Set([...e.emails, ...e.unverifiedEmails, ...e.phones, ...e.unverifiedPhones, e.username].filter(Boolean).map((v) => v!.toLowerCase()));
      u = users.find((c) => !claimed.has(c.id) && [
        ...c.emailAddresses.map((a) => a.emailAddress), ...c.phoneNumbers.map((p) => p.phoneNumber), c.username ?? "",
      ].some((v) => mine.has(v.toLowerCase())));
      if (u) idProblem = `expected ${e.externalId}, got ${show(u.externalId)}`;
    }
    if (u) claimed.add(u.id);

    if (e.skip) {
      total++;
      if (u) add(problems, "user", "should have been skipped", e.externalId, e.skip);
      else {
        passed++;
        correct++;
      }
      continue;
    }

    const checks = checksFor(e, u, badPasswords, key.metadataPlacement);
    if (idProblem) checks.push({ field: "userId", ok: false, reason: "wrong value", example: idProblem });
    const graded = checks.filter((c) => !c.note);
    total += graded.length;
    passed += graded.filter((c) => c.ok).length;
    for (const c of checks.filter((c) => c.note)) add(notes, c.field, c.reason!, e.externalId, c.example);

    if (!u) {
      // One problem for the user, not one per field it would have had.
      notImported++;
      add(problems, "user", `not imported: ${rejected.get(e.externalId) ?? rejected.get("*") ?? "no reason recorded"}`, e.externalId);
      continue;
    }
    imported++;
    const failed = graded.filter((c) => !c.ok);
    if (!failed.length) {
      correct++;
      importedCorrect++;
    }
    for (const c of failed) add(problems, c.field, c.reason!, e.externalId, c.example);
  }

  for (const u of users.filter((c) => !claimed.has(c.id))) {
    total++;
    add(problems, "user", "unexpected user", u.externalId ?? u.id, "in Clerk but not in the answer key");
  }

  const accuracy = total ? passed / total : 0;
  const byCount = (a: Problem, b: Problem) => b.ids.length - a.ids.length;
  const shouldImport = key.users.filter((e) => !e.skip).length;
  return {
    grade: letter(accuracy),
    accuracy,
    passed,
    total,
    users: { expected: key.users.length, shouldImport, imported, correct, withProblems: imported - importedCorrect, notImported },
    problems: [...problems.values()].sort(byCount),
    notes: [...notes.values()].sort(byCount),
  };
}

const pct = (n: number) => `${(Math.floor(n * 1000) / 10).toFixed(1)}%`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** One line for the terminal. */
export function summaryLine(name: string, g: Grade) {
  return `${name.padEnd(14)} ${g.grade.padEnd(3)} ${pct(g.accuracy).padStart(6)}   ${g.users.correct}/${g.users.expected} users correct` +
    (g.problems.length ? `   ${plural(g.problems.length, "problem")}` : "");
}

/** The report section for one export. */
export function section(name: string, source: string, g: Grade, error?: string): string {
  const out = [`## ${name}: ${g.grade} (${pct(g.accuracy)}, ${g.passed} / ${g.total} checks)`, "", `Source: \`${source}\``, ""];
  if (error) out.push(`**Run failed:** ${error}`, "");
  const u = g.users;
  out.push(
    `Users: ${u.expected} in export · ${u.shouldImport} should import · ${u.imported} imported · ` +
      `${u.correct} correct · ${u.withProblems} with problems · ${u.notImported} not imported`,
    "",
  );
  const list = (title: string, ps: Problem[]) => {
    if (!ps.length) return;
    out.push(`### ${title} (${ps.length})`, "");
    ps.forEach((p, i) => {
      out.push(`${i + 1}. **${p.field} · ${p.reason}** · ${plural(p.ids.length, "user")}`);
      out.push(`   ${p.ids.map((id) => `\`${id}\``).join(" ")}`);
      if (p.example) out.push(`   e.g. ${p.example}`);
    });
    out.push("");
  };
  if (!g.problems.length && !error) out.push("✅ Every user fully and correctly imported.", "");
  list("Problems", g.problems);
  list("Notes (not graded)", g.notes);
  return out.join("\n");
}
