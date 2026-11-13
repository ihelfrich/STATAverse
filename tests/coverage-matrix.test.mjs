// The coverage matrix is the backlog for recording against Stata. A command
// that was recorded must stay recorded: losing one means a fixture or a case
// file lost the cases that compared it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { commandWords, coverage, resolve } from "../tools/coverage-matrix.mjs";

const receipt = JSON.parse(
  fs.readFileSync(
    new URL("../docs/verification/coverage-matrix.json", import.meta.url),
    "utf8",
  ),
);

test("no command recorded in the receipt has lost its recording", () => {
  const now = new Set(
    coverage()
      .commands.filter((c) => c.recorded)
      .map((c) => c.name),
  );
  const lost = receipt.commands
    .filter((c) => c.recorded && !now.has(c.name))
    .map((c) => c.name);
  assert.deepEqual(lost, []);
});

test("command words skip prefixes, comments and input data", () => {
  assert.deepEqual(
    commandWords(
      "clear\ninput x\n1\n2\nend\n* note\nquietly bysort g: summarize x // tail\ncapture noisily reg y x",
    ),
    ["clear", "input", "summarize", "reg"],
  );
  assert.equal(resolve("reg"), "regress");
  assert.equal(resolve("su"), "summarize");
});
