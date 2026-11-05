import test from "node:test";
import assert from "node:assert/strict";
import { PracticeSession } from "../src/engine.js";
import { commandBlocks, executionRange } from "../src/do-file.js";
import { LESSONS, checkStep } from "../src/lessons.js";
const run = (session, command) => session.run(command).at(-1);

test("source ranges preserve continued commands, comments and quoted comment markers", () => {
  const text =
    '* A comment with an unmatched " and /*\n\nregress score ///\n hours /* units */\ncount if group == "A" // note\n';
  const blocks = commandBlocks(text);
  assert.deepEqual(
    blocks.map((b) => [b.line, b.endLine]),
    [
      [3, 4],
      [5, 5],
    ],
  );
  assert.match(blocks[0].command, /^regress score\s+hours$/);
  assert.equal(
    text.slice(blocks[1].from, blocks[1].to),
    'count if group == "A"',
  );
  assert.equal(
    executionRange(text, text.indexOf("hours")).from,
    blocks[0].from,
  );
  assert.equal(executionRange(text, 0).from, blocks[0].from);
  const selection = executionRange(text, blocks[1].from, blocks[1].to);
  assert.equal(selection.selection, true);
  assert.equal(selection.line, 5);
  assert.equal(executionRange(text, text.length), null);
});
test("parser reports the source of an unclosed quote or comment", () => {
  for (const text of ['count\ngen x = "oops', "count\n/* nope"])
    assert.throws(
      () => commandBlocks(text),
      (error) => error.source.line === 2,
    );
  const result = new PracticeSession().run("describe\nsummarize absent\nclear");
  assert.equal(result.length, 2);
  assert.equal(result[1].source.line, 2);
});
test("data-change receipts distinguish edits, added columns, row removal and sort", () => {
  const session = new PracticeSession();
  const created = run(session, "gen minutes = hours * 60");
  assert.deepEqual(created.effect.added, ["minutes"]);
  const edited = run(session, "replace minutes = 0 in 1/2");
  assert.equal(edited.effect.changedCells, 2);
  assert.equal(edited.effect.cells[0].after, 0);
  assert.equal(edited.effect.cells[0].before, 120);
  const sorted = run(session, "sort score");
  assert.equal(sorted.effect.reordered, true);
  assert.equal(sorted.effect.changedCells, 0);
  const dropped = run(session, "drop in 1/2");
  assert.equal(dropped.effect.afterRows, 22);
  assert.equal(dropped.effect.changedCells, 0);
});
test("task checks accept helper columns and reordered or additional summaries", () => {
  const session = new PracticeSession();
  run(session, "gen helper = hours * 2");
  assert.equal(
    checkStep(LESSONS[0], 0, session, run(session, "describe")),
    true,
  );
  assert.equal(
    checkStep(LESSONS[0], 2, session, run(session, "sum score hours helper")),
    true,
  );
  run(session, "sort score");
  assert.equal(
    checkStep(LESSONS[0], 2, session, run(session, "sum hours score")),
    true,
  );
  assert.equal(
    checkStep(
      LESSONS[0],
      1,
      session,
      run(session, "list id hours score in 1/5"),
    ),
    false,
  );
});
test("equivalent transformation workflows pass but unknown values cannot become zero", () => {
  const lesson = LESSONS.find((l) => l.id === "transformations");
  const session = new PracticeSession();
  run(session, "gen minutes = .");
  assert.equal(
    checkStep(lesson, 0, session, run(session, "replace minutes = hours * 60")),
    true,
  );
  assert.equal(
    checkStep(
      lesson,
      0,
      session,
      run(session, "replace minutes = 0 if missing(hours)"),
    ),
    false,
  );
});
test("a matching count from the wrong observations cannot pass", () => {
  const lesson = LESSONS.find((l) => l.id === "missing-values");
  const session = new PracticeSession();
  const correct = run(session, 'count if group == "A"');
  const wrong = run(session, 'count if group == "B"');
  assert.equal(correct.n, wrong.n);
  assert.equal(checkStep(lesson, 0, session, wrong), false);
  assert.equal(checkStep(lesson, 0, session, correct), true);
});
test("an unrelated failed assertion cannot impersonate the expected age check", () => {
  const lesson = LESSONS.find((l) => l.dataset === "clinic");
  const session = new PracticeSession("clinic");
  assert.equal(
    checkStep(lesson, 2, session, run(session, "assert 1 == 2")),
    false,
  );
  assert.equal(
    checkStep(
      lesson,
      2,
      session,
      run(session, "assert inrange(age, 0, 120) if !missing(age)"),
    ),
    true,
  );
});
