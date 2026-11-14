// tabulate results the output fixture cannot compare: r() after Cramér's V
// and after summarize(), and the return codes of options two-way tabulate
// refuses. Every expected value was recorded from Stata 19 MP (version 17,
// set processors 1) on the same do-file lines; the printed tables are in
// the tabulate-cramers-v, tabulate-two-summarize, tabulate-wide-numbers and
// tabulate-unicode-stub cases of tools/output-cases.txt.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";

function run(source) {
  const session = new Session(),
    out = session.run(source);
  return { rc: out.rc, r: session.results.r };
}
function close(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= 1e-15 * Math.max(1, Math.abs(expected)),
    `${label}: ${actual} vs Stata ${expected}`,
  );
}

const CRAMER = [
  "clear",
  "set obs 400",
  "set seed 21",
  "gen a = 1 + floor(runiform()*2)",
  "gen c = floor(runiform()*20)",
  "gen b = 1 + (runiform() < .4)",
  "gen nb = 3 - b",
].join("\n");

test("tab ..., V stores r(CramersV) after r(chi2) and r(p)", () => {
  let { rc, r } = run(`${CRAMER}\nquietly tab a c, V`);
  assert.equal(rc, 0);
  assert.deepEqual(Object.keys(r), ["N", "r", "c", "CramersV"]);
  assert.deepEqual([r.N, r.r, r.c], [400, 2, 20]);
  close(r.CramersV, 0.216222186841759062, "r(CramersV)");
  ({ r } = run(`${CRAMER}\nquietly tab a b, V`));
  close(r.CramersV, 0.0163372850517226956, "r(CramersV) 2 x 2");
  // In a 2 x 2 table V carries the sign of ad - bc.
  ({ r } = run(`${CRAMER}\nquietly tab a nb, V chi2`));
  assert.deepEqual(Object.keys(r), ["N", "r", "c", "chi2", "p", "CramersV"]);
  close(r.CramersV, -0.0163372850517226956, "r(CramersV) negative");
  close(r.chi2, 0.1067627531444959588, "r(chi2)");
  close(r.p, 0.7438602313069692107, "r(p)");
  ({ r } = run(`${CRAMER}\nquietly tab c b if c < 4, chi2 V`));
  close(r.CramersV, 0.3083526729401727673, "r(CramersV) 4 x 2");
  close(r.chi2, 7.226184189110535172, "r(chi2) 4 x 2");
});

test("a table with one row stores neither chi2 nor V", () => {
  const { rc, r } = run(`${CRAMER}\nquietly tab a c if a == 1, V chi2`);
  assert.equal(rc, 0);
  assert.deepEqual(Object.keys(r), ["N", "r", "c"]);
});

test("V is case-sensitive and two-way only", () => {
  assert.equal(run(`${CRAMER}\ncapture tab a c, v\nexit _rc`).rc, 198);
  assert.equal(run(`${CRAMER}\ncapture tab a, V\nexit _rc`).rc, 198);
});

test("two-way tabulate refuses generate(), sort, and statistics with summarize()", () => {
  for (const options of [
    "generate(dd)",
    "sort",
    "summarize(b) chi2",
    "summarize(b) V",
    "summarize(b) row",
  ]) {
    const out = new Session().run(`${CRAMER}\ntab a c, ${options}`);
    assert.equal(out.rc, 198, options);
  }
});

test("summarize() leaves r() empty, one way and two ways", () => {
  const source = [
    "clear",
    "set obs 60",
    "set seed 5",
    "gen g = 1 + floor(runiform()*3)",
    "gen h = 1 + floor(runiform()*7)",
    "gen x = runiform()",
    "tab g",
  ].join("\n");
  let { rc, r } = run(`${source}\ntab g, summarize(x)`);
  assert.equal(rc, 0);
  assert.deepEqual(r, {});
  ({ rc, r } = run(`${source}\ntab g h, summarize(x)`));
  assert.equal(rc, 0);
  assert.deepEqual(r, {});
});
