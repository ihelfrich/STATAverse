// timer measures the machine's own time, so it cannot be compared with a
// recorded Stata run line for line. Stata 19 printed, in a native run,
//   "   1:      0.00 /        1 =       0.0000"
// and this checks that layout.
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

function labor() {
  const s = createConsoleSession();
  s.reset("labor");
  return s;
}

test("timer list prints Stata's layout and skips timers never stopped", () => {
  const out = labor().run(
    "timer clear\ntimer on 1\ntimer off 1\ntimer on 3\ntimer off 3\ntimer on 3\ntimer off 3\ntimer on 7\ntimer list",
  );
  assert.equal(out.rc, 0);
  const lines = out.output.flatMap((o) => o.lines ?? []).filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^ {3}1: {6}0\.\d\d \/ {8}1 = {7}0\.\d{4}$/);
  assert.match(lines[1], /^ {3}3: {6}0\.\d\d \/ {8}2 = {7}0\.\d{4}$/);
});

test("timer refuses what Stata refuses", () => {
  assert.equal(labor().run("timer off 2").rc, 198);
  assert.equal(labor().run("timer on 1\ntimer on 1").rc, 198);
  assert.equal(labor().run("timer on 101").rc, 198);
});
