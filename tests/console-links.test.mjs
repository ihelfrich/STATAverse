import test from "node:test";
import assert from "node:assert/strict";
import { lineAt, offsetOf, pieces, shift } from "../src/console-links.js";
import { Session } from "../src/runtime/session.js";

const marksAt = (...lines) =>
  new Map(lines.map((line) => [line, { line, state: "done", blocks: [] }]));

test("marks move with their lines and are dropped from lines that changed", () => {
  const before = "a\nb\nc\nd",
    dropped = [];
  // A line added at the top moves every mark down one.
  let moved = shift(marksAt(1, 3, 4), before, "new\na\nb\nc\nd");
  assert.deepEqual([...moved.keys()], [2, 4, 5]);
  assert.deepEqual(
    [...moved.values()].map((mark) => mark.line),
    [2, 4, 5],
  );
  // Editing line 3 drops its mark and leaves the others where they were.
  moved = shift(marksAt(1, 3, 4), before, "a\nb\nC\nd", (mark) =>
    dropped.push(mark.line),
  );
  assert.deepEqual([...moved.keys()], [1, 4]);
  assert.deepEqual(dropped, [3]);
  // Removing line 2 moves later marks up.
  moved = shift(marksAt(1, 3, 4), before, "a\nc\nd");
  assert.deepEqual([...moved.keys()], [1, 2, 3]);
  // The same text leaves the marks alone.
  const same = marksAt(2);
  assert.equal(shift(same, before, before), same);
});

test("a position and its line convert both ways", () => {
  const text = "one\ntwo\n\nfour";
  assert.equal(offsetOf(text, 1), 0);
  assert.equal(offsetOf(text, 2), 4);
  assert.equal(offsetOf(text, 4), 9);
  assert.equal(offsetOf(text, 9), text.length);
  for (const line of [1, 2, 3, 4])
    assert.equal(lineAt(text, offsetOf(text, line)), line);
  assert.equal(lineAt(text, 6), 2);
});

test("output is cut into text, numbers and rules without changing it", () => {
  const text =
    "-------------+----------\n       hours |   3.176786   -.75\n  F(2, 18) = 621.83 e-class\n";
  const cut = pieces(text);
  assert.equal(cut.map((piece) => piece.text).join(""), text);
  assert.equal(cut[0].kind, "rule");
  assert.equal(cut[0].text, "-------------+----------");
  assert.deepEqual(
    cut.filter((piece) => piece.kind === "number").map((piece) => piece.text),
    ["3.176786", "-.75", "2,", "18", "621.83"],
  );
  // A short run of dashes, as in a range or an option, is not a rule.
  assert.ok(pieces("a --- b").every((piece) => piece.kind !== "rule"));
});

test("each record names the line of the do-file its command started on", () => {
  const session = new Session(),
    { output } = session.run(
      [
        "* a comment",
        "clear",
        "set obs 3",
        "generate x = _n ///",
        "  + 1",
        "",
        "forvalues k = 1/2 {",
        "  display `k'",
        "}",
        "program define hello",
        "  display 1",
        "  display 2",
        "end",
        "hello",
        "display missingname",
      ].join("\n"),
    );
  assert.deepEqual(
    output.map((record) => [record.command.split(" ")[0], record.line]),
    [
      ["clear", 2],
      ["set", 3],
      ["generate", 4],
      ["display", 8],
      ["display", 8],
      // What a program prints belongs to the line that called it.
      ["hello", 14],
      ["display", 15],
    ],
  );
  assert.equal(output.at(-1).rc, 111);
});
