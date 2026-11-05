import { test } from "node:test";
import assert from "node:assert/strict";
import { previewCSV } from "../src/csv.js";
import {
  createImportRecord,
  validateImportLibrary,
  importCatalog,
  nativeImportCommand,
} from "../src/import-library.js";

const id = "local_0123456789abcdef";
const source = "Worker ID,Hourly wage\n001,12.5\n002,NA";
const record = () =>
  createImportRecord(
    source,
    "workers.csv",
    previewCSV(source, { missingValues: ["NA"] }),
    "2026-11-05T03:30:00.000Z",
  );

test("a stored import preserves original bytes and reconstructs the agreed types and names", () => {
  const library = validateImportLibrary({ [id]: record() });
  assert.equal(library[id].source, source);
  const entry = importCatalog(library)[id];
  assert.equal(entry.synthetic, false);
  assert.equal(entry.data.rows[0].Worker_ID, "001");
  assert.equal(entry.data.rows[1].Hourly_wage, null);
  assert.equal(entry.data.columns[1].label, "Hourly wage");
  const native = nativeImportCommand(entry.file, entry.data);
  assert.match(native, /case\(preserve\)/);
  assert.match(native, /asdouble/);
  assert.match(native, /stringcols\(1\)/);
  assert.match(native, /numericcols\(2\)/);
});

test("corrupt backup imports cannot inject unsafe names, unresolved coercions or extra decisions", () => {
  const candidates = [
    {
      ...record(),
      columns: [
        { name: "__proto__", type: "string" },
        { name: "wage", type: "numeric" },
      ],
    },
    {
      ...record(),
      missingValues: [],
      columns: [
        { name: "id", type: "string" },
        { name: "wage", type: "numeric" },
      ],
    },
    { ...record(), columns: [{ name: "id", type: "string" }] },
    {
      ...record(),
      columns: [
        { name: "id", type: "string" },
        { name: "wage", type: "numeric" },
        { name: "extra", type: "string" },
      ],
    },
    { ...record(), delimiter: "|" },
    { ...record(), header: "yes" },
    { ...record(), importedAt: "yesterday" },
  ];
  for (const value of candidates)
    assert.throws(() => validateImportLibrary({ [id]: value }));
  assert.throws(() => validateImportLibrary({ __proto__: record() }));
  assert.throws(() => validateImportLibrary({ study: record() }));
  assert.throws(() =>
    nativeImportCommand(
      'unsafe".csv',
      importCatalog({ [id]: record() })[id].data,
    ),
  );
});

test("the library has bounded entry and source sizes and discards unknown metadata", () => {
  const four = Object.fromEntries(
    [1, 2, 3, 4].map((n) => [`local_${String(n).padStart(16, "0")}`, record()]),
  );
  assert.throws(() => validateImportLibrary(four), /at most three/);
  const clean = validateImportLibrary({
    [id]: { ...record(), script: "arbitrary ignored property" },
  });
  assert.equal(Object.hasOwn(clean[id], "script"), false);
  const long = "text\n" + ("x".repeat(9999) + "\n").repeat(60);
  const value = createImportRecord(long, "text.csv", previewCSV(long));
  assert.throws(
    () =>
      validateImportLibrary(
        Object.fromEntries(
          [1, 2, 3].map((n) => [`local_${String(n).padStart(16, "0")}`, value]),
        ),
      ),
    /1.5 MB/,
  );
});
