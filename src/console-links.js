// What ties a line of the do-file to what it printed. A mark sits on the
// line a command started on and holds the blocks of the Results window that
// came from it. When the do-file is edited, marks on untouched lines move
// with their lines and marks on changed lines are dropped.

/**
 * The marks of a file after its text changed from `before` to `after`.
 * Lines are numbered from 1. `dropped` is told of each mark that is lost.
 */
export function shift(marks, before, after, dropped = () => {}) {
  if (!marks.size || before === after) return marks;
  const a = before.split("\n"),
    b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const moved = new Map(),
    by = b.length - a.length;
  for (const [line, mark] of marks) {
    if (line <= head) moved.set(line, mark);
    else if (line > a.length - tail) {
      mark.line = line + by;
      moved.set(mark.line, mark);
    } else dropped(mark);
  }
  return moved;
}

/** Where line `line` (from 1) starts in `text`. */
export function offsetOf(text, line) {
  let at = 0;
  for (let k = 1; k < line; k++) {
    const next = text.indexOf("\n", at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  return at;
}

/** The line (from 1) that holds position `at` of `text`. */
export function lineAt(text, at) {
  let line = 1;
  for (
    let k = text.indexOf("\n");
    k >= 0 && k < at;
    k = text.indexOf("\n", k + 1)
  )
    line++;
  return line;
}

// A table rule as Stata prints it: dashes, with a plus where a column
// crosses. The page may draw these as a line; the text is unchanged.
const NUMBER = String.raw`(?<![\w.])-?(?:\d[\d,]*\.?\d*|\.\d+)(?:e[+-]?\d+)?(?![\w])`;
const PIECE = new RegExp(String.raw`(-{4,}(?:\+-+)*)|${NUMBER}`, "gi");

/** Output text cut into plain text, numbers and table rules, in order. */
export function pieces(text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(PIECE)) {
    if (m.index > at) out.push({ kind: "text", text: text.slice(at, m.index) });
    out.push({ kind: m[1] ? "rule" : "number", text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}
