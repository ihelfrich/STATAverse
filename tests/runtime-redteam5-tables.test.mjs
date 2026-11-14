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

// Second pass of the round, tables group. Values recorded from Stata 19
// (version 17, set processors 1) at the default linesize, 79.
const SIX_MODELS = `set seed 4205
set obs 74
generate mpg = 12 + floor(30 * runiform())
generate weight = 1800 + floor(3000 * runiform())
generate length = 140 + floor(90 * runiform())
generate turn = 30 + floor(20 * runiform())
generate foreign = runiform() > .7
label define origin5 0 "Domestic" 1 "Foreign"
label values foreign origin5
generate rep = 1 + floor(5 * runiform())
generate price = 12000 + 2 * weight - 50 * mpg + 1500 * foreign + 300 * rep + 1500 * invnormal(runiform())
quietly regress price mpg weight
estimates store m1
quietly regress price mpg weight length turn
estimates store m2
quietly regress price mpg
estimates store m3
quietly regress price weight
estimates store m4
quietly regress price length
estimates store m5
quietly regress price turn i.foreign
estimates store m6`;

test("estimates table splits its models into panels at the default width", () => {
  const { last } = run(`${SIX_MODELS}\nestimates table m1 m2 m3 m4 m5 m6`);
  const lines = last.lines.map((line) => line.trimEnd());
  // Five models fill 79 columns; the sixth starts a panel of its own.
  assert.equal(lines.filter((line) => /^ {4}Variable \|/.test(line)).length, 2);
  assert.ok(lines.includes("-".repeat(79)));
  assert.ok(
    lines.includes(
      "    Variable |     m1           m2           m3           m4           m5",
    ),
  );
  assert.ok(
    lines.includes(
      "       _cons |  14796.525    16137.178    20284.462    13733.239    20131.557",
    ),
  );
  assert.ok(lines.includes("    Variable |     m6"));
  assert.ok(lines.includes("        turn |  -27.45648"));
  assert.ok(lines.includes("    Foreign  |  1227.2299"));
  assert.ok(lines.includes("-".repeat(27)));
});

test("an exact fit and a one-observation ci show dots, not a crash", () => {
  // Stata 19: F(1, 0) = ., Adj R-squared = ., Root MSE = 0; ci shows the
  // mean with dots for the standard error and the bounds.
  const fit = run(`set obs 2
generate x = _n
generate y = 3 * _n + 1
regress y x`).last;
  assert.equal(fit.rc, 0);
  const text = fit.lines.join("\n");
  assert.match(text, /F\(1, 0\) {9}= {9}\./);
  assert.match(text, /Adj R-squared   = {9}\./);
  assert.match(text, /Root MSE {8}= {9}0/);
  const ci = run(`set obs 3
generate y = 10 * _n
ci means y in 1/1`).last;
  assert.equal(ci.rc, 0);
  assert.ok(
    ci.lines.includes(
      "           y |          1          10           .               .           .",
    ),
  );
});
