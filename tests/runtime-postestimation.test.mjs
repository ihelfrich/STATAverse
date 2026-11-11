import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { measure } from "../tools/postestimation-probe.mjs";

// After each of 23 estimators, each of 39 follow-up commands either runs in
// both installed Stata and the runtime or is refused by both. The fixture
// holds Stata's return codes; what the commands print is compared elsewhere.
test("what follows a model runs here exactly when it runs in Stata", () => {
  const receipt = measure(
    JSON.parse(
      fs.readFileSync(
        new URL("./fixtures/stata-postestimation-rc.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.deepEqual(
    [...receipt.missing, ...receipt.permissive, ...receipt.crashed],
    [],
  );
  assert.equal(receipt.bothRun + receipt.bothRefuse, receipt.pairs);
});
