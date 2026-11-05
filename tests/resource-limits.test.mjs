import { test } from "node:test";
import assert from "node:assert/strict";
import { PracticeSession } from "../src/engine.js";
import { RESOURCE_LIMITS, estimatedBytes } from "../src/resource-limits.js";
import { dataChanges } from "../src/data-changes.js";
import { retainResults } from "../src/output-history.js";
import { previewCSV } from "../src/csv.js";
import { createImportRecord, importCatalog } from "../src/import-library.js";

test("oversized literals and repeated concatenation fail atomically before strings expand", () => {
  const s = new PracticeSession();
  const initial = s.snapshot();
  assert.equal(
    s.run(`generate note = "${"a".repeat(10001)}"`)[0].kind,
    "error",
  );
  assert.deepEqual(s.snapshot(), initial);
  s.run(`generate note = "${"a".repeat(8000)}"`);
  s.run("regress score hours");
  const before = s.snapshot(),
    undos = s.undoStack.length;
  const result = s.run("replace note = note + note")[0];
  assert.equal(result.kind, "error");
  assert.match(result.message, /concatenation/);
  assert.deepEqual(s.snapshot(), before);
  assert.equal(s.undoStack.length, undos);
  assert.equal(s.data.rows[0].note.length, 8000);
});

test("aggregate text growth rolls back and undo retention accounts for text size", () => {
  const source =
    "id\n" + Array.from({ length: 200 }, (_, i) => i + 1).join("\n");
  const id = "local_0123456789abcdef";
  const s = new PracticeSession(
    id,
    importCatalog({
      [id]: createImportRecord(source, "ids.csv", previewCSV(source)),
    }),
  );
  assert.equal(
    s.run(`generate note = "${"x".repeat(7000)}"`)[0].kind,
    "generate",
  );
  const before = s.snapshot();
  const result = s.run(`generate extra = "${"y".repeat(4000)}"`)[0];
  assert.equal(result.kind, "error");
  assert.match(result.message, /2 million/);
  assert.deepEqual(s.snapshot(), before);
  for (let i = 0; i < 15; i++) s.run("count");
  assert.ok(s.undoStack.length < 15);
  assert.ok(
    s.undoStack.reduce((sum, state) => sum + estimatedBytes(state), 0) <=
      RESOURCE_LIMITS.undoBytes,
  );
  s.run('replace note = "short"');
  assert.equal(s.data.rows[0].note, "short");
  assert.equal(s.undo(), true);
  assert.equal(s.data.rows[0].note.length, 7000);
});

test("successful history stops at the same text bound that saved-work validation accepts", () => {
  const s = new PracticeSession(),
    command = `display "${"x".repeat(9990)}"`;
  let result;
  for (let i = 0; i < 105; i++) {
    result = s.run(command)[0];
    if (result.kind === "error") break;
  }
  assert.equal(result.kind, "error");
  assert.match(result.message, /saved-history/);
  assert.ok(
    s.history.reduce((sum, text) => sum + text.length, 0) <=
      RESOURCE_LIMITS.historyCharacters,
  );
  assert.ok(s.history.length > 90);
});

test("long changed-value previews and retained results cannot bypass text budgets", () => {
  const before = {
    columns: [{ name: "note", label: "", type: "string" }],
    rows: [{ note: "a".repeat(8000) }],
  };
  const after = { ...before, rows: [{ note: "b".repeat(9000) }] };
  const effect = dataChanges(before, after, "replace");
  assert.equal(effect.shortenedValues, true);
  assert.equal(effect.cells[0].before.length, 161);
  assert.equal(effect.cells[0].after.length, 161);
  assert.equal(before.rows[0].note.length, 8000);
  assert.equal(after.rows[0].note.length, 9000);
  const results = Array.from({ length: 20 }, (_, i) => ({
    kind: "list",
    command: "list note",
    sequence: i,
    rows: Array.from({ length: 2000 }, () => ({ values: ["x".repeat(400)] })),
  }));
  const retained = retainResults(results);
  assert.ok(retained.length < 20);
  assert.equal(retained.at(-1).sequence, 19);
  assert.ok(
    retained.reduce((sum, result) => sum + estimatedBytes(result), 0) <=
      RESOURCE_LIMITS.resultBytes,
  );
});
