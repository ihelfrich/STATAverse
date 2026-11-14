// Fifth red-team round, tables group: what the recorded output cases cannot
// compare. Those run at linesize 200, so the default line width, 79 as in
// Stata's batch and console sessions, is checked here; the values were
// recorded from Stata 19 (version 17, set processors 1).
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";

const run = (source) => {
  const session = new Session(),
    output = session.run(source).output;
  return { session, output, last: output.at(-1) };
};

const LABELLED = `set seed 4101
set obs 600
generate g = 1 + floor(runiform() * 4)
label define gl5 1 "Less than HS" 2 "High school" 3 "Some college" 4 "Twenty characters xx"
label values g gl5
generate x = runiform() * 40 + 20
generate averyveryverylongname = runiform()
generate y = 1000 * g + 20 * x + 500 * invnormal(runiform())`;

test("the default line is 79 wide, as in Stata", () => {
  const { last } = run("display c(linesize)");
  assert.deepEqual(last.lines, ["79"]);
});

test("a level label of twelve characters is cut at the default width", () => {
  // Stata 19: at linesize 79 the first column stays twelve wide.
  const { last } = run(`${LABELLED}\nregress y x i.g`);
  const lines = last.lines.filter((line) => line.includes("|"));
  assert.ok(
    lines.includes(
      "High school  |   1020.589   56.04748    18.21   0.000     910.5144    1130.664",
    ),
  );
  assert.ok(
    lines.includes(
      "Some coll..  |   1924.135   57.22529    33.62   0.000     1811.747    2036.523",
    ),
  );
  assert.ok(
    lines.includes(
      "Twenty ch..  |   3013.878   57.69702    52.24   0.000     2900.563    3127.192",
    ),
  );
  assert.ok(last.lines.includes("-".repeat(78)));
});

test("estat vce options that are not laid out yet are refused", () => {
  for (const option of ["diag", "block", "nolines", "equation(y)"]) {
    const { last } = run(
      `set obs 20\ngenerate x = _n\ngenerate y = x + mod(_n, 3)\nquietly regress y x\nestat vce, ${option}`,
    );
    assert.equal(last.rc, 198, option);
    assert.match(last.lines.join("\n"), /not available in the browser yet/);
  }
});

test("tabstat, save is refused rather than ignored", () => {
  const { last } = run("set obs 20\ngenerate x = _n\ntabstat x, save");
  assert.equal(last.rc, 198);
});

test("the older ci varlist is refused as Stata 14 and later refuse it", () => {
  const { last } = run("set obs 20\ngenerate x = _n\nci x");
  assert.equal(last.rc, 198);
  assert.equal(
    last.lines[0],
    "you must specify one of means, proportions, or variances following ci",
  );
});

test("qreg with repeated regressor rows does not crash", () => {
  // Integer ages and four groups give many identical rows; the search used
  // to take a singular basis and fail with a JavaScript TypeError. Stata 19
  // gives x 702.3283 (58.06108) and _cons 18304.59 here.
  const { last } = run(`set seed 4109
set obs 401
generate g = 1 + floor(runiform() * 4)
generate x = 18 + floor(runiform() * 50)
generate y = 15000 + 600 * x + 8000 * g + 12000 * invnormal(runiform())
qreg y x i.g, nolog`);
  assert.equal(last.rc, 0);
  const text = last.lines.join("\n");
  assert.match(text, /x \|   702\.3283   58\.06108/);
  assert.match(text, /_cons \|   18304\.59/);
  assert.match(text, /\(about 61148\.332\)/);
});

test("qreg reports e(q_v) as the floor((n + 1) q)-th outcome", () => {
  // Stata 19, n = 401: q = .25 gives the 100th smallest outcome, 49825.156,
  // though the 101st minimises the sum; q = .5 gives the 201st.
  const { session } = run(`set seed 4109
set obs 401
generate g = 1 + floor(runiform() * 4)
generate x = 18 + floor(runiform() * 50)
generate y = 15000 + 600 * x + 8000 * g + 12000 * invnormal(runiform())
quietly qreg y x, quantile(.25)`);
  assert.equal(session.results.e.q_v, 49825.15625);
  assert.equal(Math.round(session.results.e.sum_rdev), 2184191);
});
