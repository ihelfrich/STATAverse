// Sixth red-team round, display group: what the recorded output cases
// cannot compare. Stata's text log wraps a line longer than the line size
// with "> ", so a line the Results window holds whole is checked here, as
// are the default line size of 79 and an error's hint. The values were
// recorded from Stata 19 (version 17, set processors 1) in batch mode.
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";
import { renderSmcl } from "../src/runtime/smcl.js";

const run = (source) => {
  const session = new Session(),
    output = session.run(source).output;
  return { session, output, last: output.at(-1) };
};

test("{hline} runs to the default line size of 79", () => {
  const { last } = run('display "{hline 5}|{hline}"');
  assert.deepEqual(last.lines, [`-----|${"-".repeat(73)}`]);
});

test("a word longer than the line stays whole in a paragraph", () => {
  // Stata 19: the 107 a's and b make one line, which the log wraps at
  // column 79; the next word goes on from where the screen wrapped.
  const a = "a".repeat(107),
    b = "b".repeat(79);
  assert.equal(renderSmcl(`{p}${a} b`), `${a} b`);
  assert.equal(renderSmcl(`{p}${a} ${b} c`), `${a}\n${b}\nc`);
});

test("{right:} and {col} past the line are not cut", () => {
  // Stata 19 prints x in column 79 and y after it, and x after 84 blanks;
  // the log wraps both lines.
  const { last } = run('display "{right:x}" "y"');
  assert.deepEqual(last.lines, [`${" ".repeat(78)}xy`]);
  const { last: past } = run('display "{col 85}x"');
  assert.deepEqual(past.lines, [`${" ".repeat(84)}x`]);
});

test("a lone = is invalid syntax, with a hint", () => {
  const { last } = run("set obs 3\ngenerate x = _n\nsummarize x if x = 1");
  assert.equal(last.rc, 198);
  assert.deepEqual(last.lines.slice(0, 1), ["invalid syntax"]);
});

test("display's text in a macro keeps its SMCL", () => {
  // Stata 19: local x : display "a" _col(5) "b" holds a{col 5}b, whose
  // strlen() is 9.
  const { last } = run(
    'local x : display "a" _col(5) "b"\ndisplay strlen(`"`x\'"\')',
  );
  assert.deepEqual(last.lines, ["9"]);
});

test("cii leaves r() as Stata does, and udstrlen() counts columns", () => {
  // Stata 19: cii means 30 5 2 gives the bounds 4.2531877264838 and
  // 5.7468122735162; udstrlen("西部地区") is 8.
  const { session } = run("cii means 30 5 2");
  assert.equal(session.results.r.N, 30);
  assert.equal(session.results.r.lb, 4.2531877264838);
  assert.equal(session.results.r.ub, 5.7468122735162);
  assert.equal(session.results.r.citype, "normal");
  assert.deepEqual(run('display udstrlen("西部地区")').last.lines, ["8"]);
});
