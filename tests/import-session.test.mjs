import { test } from "node:test";
import assert from "node:assert/strict";
import { PracticeSession } from "../src/engine.js";
import { previewCSV } from "../src/csv.js";
import {
  createImportRecord,
  importCatalog,
  nativeImportCommand,
} from "../src/import-library.js";
import { emptyStore, parseStore } from "../src/persistence.js";

const id = "local_0123456789abcdef";
function sourceLibrary(source = "id,x,y\n001,1,4\n002,2,5\n003,3,7\n004,4,8") {
  return {
    [id]: createImportRecord(source, "students.csv", previewCSV(source)),
  };
}

test("an imported dataset can be analyzed, reloaded and replayed without changing its original", () => {
  const catalog = importCatalog(sourceLibrary());
  const s = new PracticeSession(id, catalog);
  const original = structuredClone(catalog[id].data);
  const results = s.run("regress y x\ngenerate double x2 = x^2\nkeep if x > 1");
  assert.equal(
    results.some((r) => r.kind === "error"),
    false,
  );
  assert.equal(s.data.rows.length, 3);
  assert.deepEqual(catalog[id].data, original);
  assert.equal(
    s.run(nativeImportCommand(catalog[id].file, original))[0].kind,
    "import",
  );
  assert.deepEqual(s.data, original);
  const replay = new PracticeSession(id, catalog);
  for (const command of s.history)
    assert.notEqual(replay.run(command)[0].kind, "error");
  assert.deepEqual(replay.data, s.data);
  const before = s.snapshot();
  assert.equal(
    s.run(`import delimited using "${id}.csv", clear stringcols(all)`)[0].kind,
    "error",
  );
  assert.deepEqual(s.snapshot(), before);
});

test("imported records and their work survive backup validation while v2 lessons migrate", () => {
  const store = emptyStore();
  store.imports = sourceLibrary();
  store.free[id] = {
    step: 0,
    history: ["regress y x"],
    code: "summarize y",
    note: "My units",
    completed: [],
  };
  assert.deepEqual(parseStore(JSON.stringify(store)), store);
  const migrated = parseStore(
    JSON.stringify({
      version: 2,
      lessons: {},
      free: {},
      current: "regression",
    }),
  );
  assert.equal(migrated.version, 3);
  assert.equal(migrated.current, "regression");
  assert.deepEqual(migrated.imports, {});
  const corrupt = {
    ...store,
    imports: {
      ...store.imports,
      [id]: { ...store.imports[id], source: "id,x\n1,bad" },
    },
  };
  assert.throws(() => parseStore(JSON.stringify(corrupt)));
});

test("large-dataset undo history is bounded while keeping a usable recent restoration", () => {
  const source =
    "id,x,y\n" +
    Array.from({ length: 5000 }, (_, i) => `${i + 1},${i},${2 * i + 3}`).join(
      "\n",
    );
  const s = new PracticeSession(id, importCatalog(sourceLibrary(source)));
  s.run("preserve");
  for (let i = 0; i < 35; i++) s.run("count");
  assert.ok(s.undoStack.length < 35);
  assert.ok(s.undoStack.length >= 1);
  s.run("replace x = 0");
  assert.equal(s.data.rows[10].x, 0);
  s.undo();
  assert.equal(s.data.rows[10].x, 10);
  assert.equal(s.preservedData.rows[10].x, 10);
});
