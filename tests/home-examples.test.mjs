import test from "node:test";
import assert from "node:assert/strict";
import { HOME_EXAMPLES } from "../src/home-examples.js";
import { PracticeSession } from "../src/engine.js";
import fs from "node:fs";
import { gzipSync } from "node:zlib";
test("lightweight landing examples retain the browser engine results", () => {
  const session = new PracticeSession();
  for (const [id, command] of Object.entries({
    scatter: "scatter score hours",
    summarize: "summarize hours score",
    regress: "regress score hours",
  })) {
    session.load("study");
    const r = session.run(command).at(-1);
    const expected =
      id === "scatter"
        ? { graph: { points: r.graph.points } }
        : id === "summarize"
          ? { stats: r.stats }
          : {
              model: {
                n: r.model.n,
                r2: r.model.r2,
                coefficients: r.model.coefficients,
              },
            };
    assert.deepEqual(HOME_EXAMPLES[id], expected);
  }
});
test("landing and saved-work bundles stay below their compressed transfer budgets", () => {
  assert.ok(gzipSync(fs.readFileSync("assets/js/home.js")).length < 5000);
  assert.ok(gzipSync(fs.readFileSync("assets/js/workspace.js")).length < 53000);
});
