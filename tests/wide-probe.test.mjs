// Every case the wide probe's receipt records as passing must still pass, and
// no case may crash. A case that starts passing is progress: rerun
// `node tools/wide-probe.mjs --write` to record it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readCases, runProbe } from "../tools/wide-probe.mjs";

const receipt = JSON.parse(
  fs.readFileSync(
    new URL("../docs/verification/wide-probe.json", import.meta.url),
    "utf8",
  ),
);
const results = runProbe(readCases());
const now = new Map(results.map((r) => [r.key, r]));

test("no wide-probe case crashes", () => {
  const crashed = results.filter((r) => r.outcome === "crash");
  assert.deepEqual(
    crashed.map((r) => `${r.key}: ${r.detail}`),
    [],
  );
});

test("no wide-probe case goes from pass to anything else", () => {
  const lost = receipt.results
    .filter((r) => r.outcome === "pass")
    .map((r) => [r.key, now.get(r.key)])
    .filter(([, r]) => r?.outcome !== "pass")
    .map(([key, r]) =>
      r ? `${key}: ${r.outcome}, ${r.detail}` : `${key}: case removed`,
    );
  assert.deepEqual(lost, []);
});

test("the receipt's counts match its own results", () => {
  const counted = { pass: 0, refused: 0, wrong: 0, crash: 0 };
  for (const r of receipt.results) counted[r.outcome] += 1;
  assert.equal(receipt.cases, receipt.results.length);
  for (const outcome of Object.keys(counted))
    assert.equal(receipt[outcome], counted[outcome], outcome);
});
