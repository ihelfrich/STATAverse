import { test } from "node:test";
import assert from "node:assert/strict";
import { historyReceipt, retainResults } from "../src/output-history.js";
import { resultHTML } from "../src/render.js";

test("large numerical outputs do not accumulate unbounded rows behind lightweight history receipts", () => {
  const result = {
    kind: "list",
    command: "list x y",
    rows: Array.from({ length: 5000 }, (_, i) => ({
      position: i + 1,
      values: [i, i + 1],
    })),
    names: ["x", "y"],
    n: 5000,
    effect: { beforeRows: 5000, afterRows: 5000 },
  };
  const receipt = historyReceipt(result);
  assert.equal(Object.hasOwn(receipt, "rows"), false);
  assert.equal(receipt.command, "list x y");
  const retained = retainResults(
    Array.from({ length: 100 }, (_, i) => ({ ...result, sequence: i })),
  );
  assert.ok(retained.length < 100);
  assert.equal(retained.at(-1).sequence, 99);
  assert.equal(
    retainResults([{ ...result, rows: Array(600000).fill({ values: [1] }) }])
      .length,
    1,
  );
});

test("display truncation leaves the original result and complete export available", () => {
  const rows = Array.from({ length: 201 }, (_, i) => ({
    position: i + 1,
    values: [`record_${i + 1}`],
  }));
  const result = {
    kind: "list",
    command: "list label",
    names: ["label"],
    rows,
    n: 201,
  };
  const display = resultHTML(result, 0);
  assert.match(display, /first 200 of 201/);
  assert.doesNotMatch(display, /record_201/);
  assert.match(resultHTML(result, 0, { complete: true }), /record_201/);
  assert.equal(result.rows.length, 201);
  const frequency = {
    kind: "tabulate",
    command: "tab id",
    name: "id",
    n: 201,
    entries: rows.map((_, i) => ({
      value: i + 1,
      count: 1,
      percent: 100 / 201,
      cumulative: (100 * (i + 1)) / 201,
    })),
  };
  assert.match(resultHTML(frequency, 0), /first 200 of 201 categories/);
  assert.doesNotMatch(
    resultHTML(frequency, 0, { complete: true }),
    /Showing the first/,
  );
});
