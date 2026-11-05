import { test } from "node:test";
import assert from "node:assert/strict";
import { PracticeSession } from "../src/engine.js";

test("preserve and restore recover values, variables, labels and ordering", () => {
  const s = new PracticeSession();
  const original = structuredClone(s.data);
  const output = s.run(
    'preserve\nkeep if group == "A"\ngen double minutes = hours * 60\nlabel variable hours "Changed"\nsort score\nrestore',
  );
  assert.equal(
    output.some((r) => r.kind === "error"),
    false,
  );
  assert.deepEqual(s.data, original);
  assert.equal(s.preservedData, null);
  assert.equal(output.at(-1).effect.reloaded, true);
  assert.equal(output.at(-1).effect.changedCells, 0);
  assert.equal(s.run("restore")[0].code, 622);
});

test("retained and discarded copies are distinct and undoable", () => {
  const s = new PracticeSession();
  s.run('preserve\nkeep if group == "A"\nrestore, preserve');
  assert.equal(s.data.rows.length, 24);
  assert.equal(s.preservedData.rows.length, 24);
  assert.equal(s.run("preserve")[0].code, 621);
  s.run('keep if group == "B"\nrestore, not');
  assert.equal(s.data.rows.length, 12);
  assert.equal(s.preservedData, null);
  assert.equal(s.last.effect.reloaded, false);
  s.undo();
  assert.equal(s.preservedData.rows.length, 24);
  s.run("restore");
  assert.equal(s.data.rows.length, 24);
  s.undo();
  assert.equal(s.data.rows.length, 12);
  assert.equal(s.preservedData.rows.length, 24);
});

test("failed options are atomic and clearing data does not discard the copy", () => {
  const s = new PracticeSession();
  s.run("preserve");
  const snapshot = s.snapshot();
  for (const command of [
    "preserve, changed",
    "restore, unknown",
    "restore, not preserve",
    "restore id",
  ]) {
    assert.equal(s.run(command)[0].kind, "error", command);
    assert.deepEqual(s.snapshot(), snapshot);
  }
  s.run("clear\nrestore");
  assert.equal(s.data.rows.length, 24);
  s.run('preserve\nimport delimited using "wages.csv", clear\nrestore');
  assert.equal(s.data.id, "study");
  assert.equal(s.data.rows.length, 24);
  const replay = new PracticeSession();
  for (const command of s.history)
    assert.notEqual(replay.run(command).at(-1).kind, "error");
  assert.deepEqual(replay.data, s.data);
  assert.deepEqual(replay.preservedData, s.preservedData);
});
