/**
 * CSV both ways, RFC 4180: quoted cells, doubled quotes, newlines inside quotes.
 *
 * Self-check: npx tsx scripts/lib/csv.ts
 */

/** Rows to CSV with a header row: null and undefined become empty cells, objects their JSON. */
export function toCsv(rows: Record<string, unknown>[]): string {
  const cols = [...new Set(rows.flatMap(Object.keys))];
  const cell = (v: unknown) => {
    const s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

/** CSV text to rows of cells. A trailing newline makes no empty last row. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') cell += text[++i];
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows;
}

/** CSV text with a header row to objects keyed by it. `headers` names the columns of a header-less file. */
export function csvObjects(text: string, headers?: string[]): Record<string, string>[] {
  const [first, ...rest] = parseCsv(text.replace(/^﻿/, ""));
  const cols = headers ?? first;
  return (headers ? [first, ...rest] : rest).filter(Boolean).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""])));
}

if (process.argv[1]?.endsWith("csv.ts")) {
  const { default: assert } = await import("node:assert");
  const rows = [{ id: "1", note: 'say "hi", ok', meta: { a: 1 }, gone: null }, { id: "2", note: "two\nlines" }];
  assert.deepEqual(csvObjects(toCsv(rows)), [
    { id: "1", note: 'say "hi", ok', meta: '{"a":1}', gone: "" },
    { id: "2", note: "two\nlines", meta: "", gone: "" },
  ]);
  assert.deepEqual(csvObjects("a,b\r\n1,2\r\n", ["x", "y"]), [{ x: "a", y: "b" }, { x: "1", y: "2" }]);
  console.log("csv: ok");
}
