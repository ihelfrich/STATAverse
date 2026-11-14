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

test("below the line size 79 mean over() keeps the table of 79", () => {
  // Stata 19 at set linesize 60 prints the same table as at 79, full
  // names in a 28-wide first column, and its text log wraps every line
  // past column 60. These are the lines as the Results window holds them;
  // the first 60 columns of each are the log's.
  const { last } = run(
    [
      "set obs 60",
      "generate id = _n",
      "generate thirteen_char = id",
      "generate another_long_group_variable = 1 + mod(_n, 2)",
      "set linesize 60",
      "mean thirteen_char, over(another_long_group_variable)",
    ].join("\n"),
  );
  assert.deepEqual(last.lines.filter(Boolean), [
    "Mean estimation                                            Number of obs = 60",
    "-".repeat(77),
    "                            |       Mean   Std. err.     [95% conf. interval]",
    `${"-".repeat(28)}+${"-".repeat(48)}`,
    "            c.thirteen_char@|",
    "another_long_group_variable |",
    "                         1  |         31    3.21455       24.5677     37.4323",
    "                         2  |         30    3.21455       23.5677     36.4323",
    "-".repeat(77),
  ]);
});

test("mean and total refuse what they cannot yet compute, with r(198)", () => {
  // Stata 19 runs these; the browser refuses them by name rather than
  // printing analytic standard errors under another heading.
  const setup = "set obs 25\ngenerate income = _n\ngenerate w = 1\n";
  for (const [command, message] of [
    [
      "total income, vce(bootstrap)",
      "vce(bootstrap) is not available in the browser yet for total",
    ],
    [
      "mean income, vce(jackknife)",
      "vce(jackknife) is not available in the browser yet for mean",
    ],
    [
      "total income, stdize(w) stdweight(w)",
      "option stdize() is not available in the browser yet for total",
    ],
    // Stata's own message for vce(robust).
    ["mean income, vce(robust)", "vcetype robust not allowed"],
  ]) {
    const { last } = run(setup + command);
    assert.equal(last.rc, 198, command);
    assert.equal(last.lines[0], message);
  }
});

test("_skip() and _col() of a missing value are invalid syntax", () => {
  // Stata 19: display _skip(.) "x" and display _col(.) "x" are r(198).
  for (const command of ['display _skip(.) "x"', 'display _col(.) "x"'])
    assert.equal(run(command).last.rc, 198);
});

test("total leaves r(table), 9 by the number of estimates", () => {
  // Stata 19: return list after total income sc shows r(mcmethod)
  // "noadjust" and r(table) 9 x 2; r(N) from an earlier cii is gone.
  const { session } = run(
    "cii means 30 5 2\nset obs 5\ngenerate income = _n\ngenerate sc = _n^2\ntotal income sc",
  );
  const table = session.results.r["matrix:table"];
  assert.equal(session.results.r.N, undefined);
  assert.equal(session.results.r.mcmethod, "noadjust");
  assert.equal(table.values.length, 9);
  assert.equal(table.values[0].length, 2);
  assert.deepEqual(table.colNames, ["income", "sc"]);
});
