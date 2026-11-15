// Eighth pass, data group: rnormal() and runiform() draw for draw with
// Stata's stream, summarize, detail with weights, the weight notes of tab1,
// tab2 and tabstat, list with no variables, reshape long with a stub whose
// suffixes are not numbers, and ranksum, kwallis and oneway.
// tools/output-cases.txt compares their printed text with Stata's (the
// pass8-data-* cases); this file checks what text cannot: the doubles
// drawn, r() to more digits than return list keeps reliably, the data left
// after an error and the return codes. Values were recorded from Stata 19
// MP (version 17, set processors 1) in batch mode.
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";
import { Generator } from "../src/runtime/random.js";
import { StataError } from "../src/runtime/errors.js";
import { list, weightedRows } from "../src/runtime/reports.js";

const run = (source) => {
  const session = new Session(),
    result = session.run(source);
  return { session, result, output: result.output };
};
const close = (actual, expected, tolerance = 1e-12) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} is not ${expected}`,
  );
const column = (session, name) => session.data.get(name).data;
const textOf = (output) =>
  output.flatMap((o) => o.lines.flatMap((line) => String(line).split("\n")));

test("rnormal() draws Stata's doubles after set seed, interleaved with runiform()", () => {
  // Stata 19: set seed 12345, then generate double x = rnormal() and
  // runiform(), read in %21x.
  const g = new Generator(12345);
  assert.deepEqual(
    Array.from({ length: 8 }, () => g.normal()),
    [
      0.95919998379642624, -0.0018050319261233294, 0.54407705019581565,
      0.0016287139391725353, 0.35768090610132686, 1.8788676809982929,
      2.7547459803043308, -0.6125968334256553,
    ],
  );
  const u = new Generator(12345);
  assert.deepEqual(
    Array.from({ length: 4 }, () => u.uniform()),
    [
      0.35762972288842587, 0.40044261704406126, 0.68938331700276845,
      0.55973557064111568,
    ],
  );
  // set seed 42, set obs 300000, then rnormal(), runiform(), rnormal(10, 2)
  // and rnormal(-3), each generated in turn. Draws 1737 and 36068 come
  // from the tail beyond 3.875.
  const h = new Generator(42),
    n = Array.from({ length: 300000 }, () => h.normal());
  assert.equal(n[1736], 3.9264825858026602);
  assert.equal(n[36067], 4.2649405183756377);
  assert.equal(n[299999], -0.48263462035180671);
  assert.equal(h.uniform(), 0.81831842276151245);
  for (let k = 1; k < 300000; k++) h.uniform();
  assert.equal(10 + 2 * h.normal(), 9.9849129345970766);
  for (let k = 1; k < 300000; k++) h.normal();
  assert.equal(-3 + h.normal(), -1.8177629742455583);
});

test("generate with rnormal() reproduces Stata's values and summary", () => {
  const { session } = run(`set obs 5
set seed 12345
generate double x = rnormal()
set seed 987
generate z = rnormal(2, 3)`);
  assert.deepEqual(
    [...column(session, "x")],
    [
      0.95919998379642624, -0.0018050319261233294, 0.54407705019581565,
      0.0016287139391725353, 0.35768090610132686,
    ],
  );
  // A float variable; Stata 19 printed 4.38199234 -1.183328271 1.914232254 .6099665761
  // 4.393675804 under %12.0g.
  [4.38199234, -1.183328271, 1.914232254, 0.6099665761, 4.393675804].forEach(
    (v, k) => close(column(session, "z")[k], v, 1e-9),
  );
  const s = run(`set obs 10000
set seed 7
generate n = rnormal()
summarize n`).session.results.r;
  // Stata: mean .0080258, sd 1.001074, min -3.82497, max 3.647815.
  close(s.mean, 0.0080258, 1e-5);
  close(s.sd, 1.001074, 1e-6);
  close(s.min, -3.82497, 1e-6);
  close(s.max, 3.647815, 1e-6);
});

test("rnormal() and runiform() with degenerate arguments take no draw", () => {
  // Stata 19: after set seed 5 and three draws each of rnormal(5, 0),
  // rnormal(5, -1), rnormal(., 1), runiform(5, 1), runiform(., 1) and
  // runiform(3, 3), runiform() continues the stream from its start.
  const { session } = run(`set obs 3
set seed 5
generate double a = rnormal(5, 0)
generate double c = rnormal(5, -1)
generate double e = rnormal(., 1)
generate double f = runiform(5, 1)
generate double h = runiform(., 1)
generate double k = runiform(3, 3)
generate double b = runiform()`);
  assert.deepEqual([...column(session, "a")], [5, 5, 5]);
  for (const name of ["c", "e", "f", "h", "k"])
    assert.ok(column(session, name).every((v) => v > 8e307));
  assert.deepEqual(
    [...column(session, "b")],
    [0.6730649039714279, 0.03849461080767902, 0.2252885569478601],
  );
});

const WEIGHTED = `set obs 50
set seed 7
generate x = rnormal()
generate y = 1 + 2*x + rnormal()
generate xx = 1 + mod(_n,7)
generate w2 = runiform()*3
generate r = round(x, .5)`;

test("summarize, detail with analytic weights gives Stata's r()", () => {
  let r = run(`${WEIGHTED}\nsummarize r [aw=xx], detail`).session.results.r;
  // Stata 19: return list after summarize r [aw=xx], detail.
  assert.equal(r.N, 50);
  assert.equal(r.sum_w, 198);
  close(r.mean, 0.1111111111111111);
  close(r.Var, 1.273219725600678);
  close(r.sd, 1.128370384936027);
  close(r.skewness, -0.2033691489057892);
  close(r.kurtosis, 2.943858377677496);
  close(r.sum, 22);
  assert.deepEqual(
    [r.p1, r.p5, r.p10, r.p25, r.p50, r.p75, r.p90, r.p95, r.p99],
    [-2.5, -2, -1, -0.5, 0, 1, 1.5, 2, 2.5],
  );
  r = run(`${WEIGHTED}\nsummarize r [aweight=w2], detail`).session.results.r;
  close(r.sum_w, 76.70110811851919);
  close(r.mean, 0.0266496296848892);
  close(r.Var, 1.317744446211968);
  close(r.skewness, -0.2871465999541216);
  close(r.kurtosis, 2.968979709433705);
  close(r.sum, 2.044056127779186);
  assert.deepEqual(
    [r.p1, r.p5, r.p10, r.p25, r.p50, r.p75, r.p90, r.p95, r.p99],
    [-2.5, -2.5, -2, -0.5, 0, 1, 1.5, 2, 2.5],
  );
  r = run(`${WEIGHTED}\nsummarize y [aw=xx] in 1/3, detail`).session.results.r;
  close(r.p1, -1.909131407737732);
  close(r.p25, -1.909131407737732);
  close(r.p50, -0.1816536486148834);
  close(r.p75, -0.1816536486148834);
  close(r.p90, -0.0916456431150436);
  close(r.kurtosis, 1.500180766683907);
  r = run(`${WEIGHTED}\nsummarize y [aw=xx] in 1, detail`).session.results.r;
  assert.equal(r.N, 1);
  assert.equal(r.sum_w, 2);
  assert.ok(r.Var > 8e307 && r.skewness > 8e307);
  r = run(`${WEIGHTED}\nsummarize y [aw=xx] if x > 10, detail`).session.results
    .r;
  assert.deepEqual(r, { N: 0, sum_w: 0, sum: 0 });
});

test("weighted percentiles meet their point within 1e-7 of the total weight", () => {
  // Stata 19 with x = _n on 100,001 observations: p1 and p99 are 1001 and
  // 99001 unweighted, 1000.5 and 99001.5 with weights of 1 of either kind.
  const base = `set obs 100001\ngenerate x = _n\ngenerate w = 1`;
  let r = run(`${base}\nsummarize x, detail`).session.results.r;
  assert.deepEqual([r.p1, r.p99, r.p5], [1001, 99001, 5001]);
  r = run(`${base}\nsummarize x [aw=w], detail`).session.results.r;
  assert.deepEqual([r.p1, r.p99, r.p5], [1000.5, 99001.5, 5001]);
  r = run(`${base}\nsummarize x [fw=w], detail`).session.results.r;
  assert.deepEqual([r.p1, r.p99, r.p5], [1000.5, 99001.5, 5001]);
  // Equal weights that do not add up exactly still meet their points:
  // Stata gives 1 1 1.5 3 5.5 8 9.5 10 10 for weights .37 on x = 1..10.
  r = run(
    `set obs 10\ngenerate x = _n\ngenerate double w = .37\nsummarize x [aw=w], detail`,
  ).session.results.r;
  assert.deepEqual(
    [r.p1, r.p5, r.p10, r.p25, r.p50, r.p75, r.p90, r.p95, r.p99],
    [1, 1, 1.5, 3, 5.5, 8, 9.5, 10, 10],
  );
  // One weight of 1 + e on four observations: the 25th percentile is the
  // mean of the first two up to e = 1.6e-6 (found by bisection in Stata).
  const quartile = (e) =>
    run(
      `set obs 4\ngenerate x = _n\ngenerate double w = cond(_n == 4, 1 + ${e}, 1)\nsummarize x [aw=w], detail`,
    ).session.results.r.p25;
  assert.equal(quartile(1.5e-6), 1.5);
  assert.equal(quartile(1.7e-6), 2);
});

test("tab1, tab2 and tabstat say once which weight [w=] is taken as", () => {
  const notes = (command) =>
    textOf(
      run(`${WEIGHTED}\ngenerate g = mod(_n,3)\n${command}`).output,
    ).filter((line) => / weights assumed\)$/.test(line));
  assert.deepEqual(notes("tab1 g r [weight=xx]"), [
    "(frequency weights assumed)",
  ]);
  assert.deepEqual(notes("tab2 g r [w=xx]"), ["(frequency weights assumed)"]);
  assert.deepEqual(notes("tabstat y [weight=xx], by(g)"), [
    "(analytic weights assumed)",
  ]);
  assert.deepEqual(notes("tab1 g r [fweight=xx]"), []);
});

test("list with observations but no variables prints nothing", () => {
  const { result, output } = run("set obs 3\nlist\nlist in 1\nlist, noobs");
  assert.equal(result.rc, 0);
  assert.deepEqual(
    output.slice(1).flatMap((o) => o.lines.filter((line) => line.trim())),
    [],
  );
  // list _all and summarize _all: Stata's r(111).
  for (const command of ["list _all", "summarize _all", "list x"]) {
    const r = run(`set obs 3\ncapture noisily ${command}`).session;
    assert.equal(r.rc, 111, command);
  }
});

test("reshape long with only non-numeric suffixes stops and keeps the data", () => {
  const { session } = run(`input id income
1 10
2 20
end
capture reshape long inc, i(id) j(year)`);
  // Stata 19: variable year contains all missing values, r(498); the data
  // stay at 2 observations and 2 variables.
  assert.equal(session.rc, 498);
  assert.equal(session.data.n, 2);
  assert.deepEqual(session.data.names, ["id", "income"]);
  assert.deepEqual([...column(session, "income")], [10, 20]);
});

const RANKS = `set obs 300
set seed 99
generate g = 1 + floor(runiform()*3)
generate y = round(10*g + 3*rnormal(), 1)
generate b = g == 1`;

test("ranksum's porder, exact and errors follow Stata", () => {
  let r = run(`${RANKS}\nranksum y, by(b) porder`).session.results.r;
  // Stata 19: r(porder) .995979709675678615, r(z) 13.49192720605596385,
  // r(p_u) 8.72396578605325e-42; no exact p-value beyond 200 observations.
  close(r.porder, 0.995979709675678615);
  close(r.z, 13.49192720605596385);
  close(r.p_u, 8.72396578605325e-42, 1e-9);
  assert.equal(r.p_exact, undefined);
  r = run(`${RANKS}\nranksum y in 1/60, by(b) exact`).session.results.r;
  close(r.Var_a, 4152.376271186441);
  close(r.p_exact, 2.25437751494e-15, 1e-9);
  r = run(`${RANKS}\nranksum y in 1/60, by(b) noexact`).session.results.r;
  assert.equal(r.p_exact, undefined);
  r = run(
    `${RANKS}\ngenerate str5 s = cond(b, "alpha", "beta")\nranksum y in 1/40, by(s)`,
  ).session.results.r;
  assert.equal(r.group1, 1);
  close(r.p_exact, 3.32413023500816e-10, 1e-9);
  const rc = (command) =>
    run(`${RANKS}\ncapture noisily ${command}`).session.rc;
  assert.equal(rc("ranksum y if g == 1, by(b)"), 499);
  assert.equal(rc("ranksum y, by(g)"), 499);
  assert.equal(rc("ranksum y if y > 1000, by(b)"), 2000);
  assert.equal(rc("ranksum y, by(b) exact noexact"), 198);
  // Stata computes exact up to 1,000 observations; the browser refuses
  // past 200 rather than ignore the option, and past 1,000 says what
  // Stata says.
  assert.equal(rc("ranksum y, by(b) exact"), 198);
  assert.equal(
    run(
      `set obs 1500\ngenerate y = mod(_n, 17)\ngenerate b = _n > 700\ncapture ranksum y, by(b) exact`,
    ).session.rc,
    459,
  );
});

test("kwallis shows a probability below .0001 as 0.0001", () => {
  const { session, output } = run(`${RANKS}\nkwallis y, by(g)`);
  // Stata 19: chi2 257.9560132890367186, chi2_adj 258.3760225346596826.
  close(session.results.r.chi2, 257.9560132890367186, 1e-9);
  close(session.results.r.chi2_adj, 258.3760225346596826, 1e-9);
  const text = textOf(output);
  assert.ok(text.includes("     Prob =  0.0001"));
  assert.ok(text.includes("               Prob =  0.0001"));
});

const CELLS = `input g y
1 5
2 3
2 4
3 7
3 7
3 7
4 1
4 2
4 4
5 6
5 9
end`;

test("oneway leaves out cells without variance from Bartlett's test", () => {
  let r = run(`${CELLS}\noneway y g`).session.results.r;
  // Stata 19: return list and matrix list r(ANOVA), format(%20.0g).
  assert.equal(r.N, 11);
  close(r.mss, 50.33333333333333);
  close(r.rss, 9.666666666666668);
  close(r.F, 7.810344827586205);
  close(r.chi2bart, 0.7447496609477521);
  assert.equal(r.df_bart, 2);
  const anova = r["matrix:ANOVA"];
  assert.deepEqual(anova.rowNames, [
    "Between groups",
    "Within groups",
    "Total",
  ]);
  assert.deepEqual(anova.colNames, ["SS", "df", "MS", "F", "p"]);
  close(anova.values[0][4], 0.014706444330132613);
  assert.deepEqual(
    anova.values.map((row) => row[1]),
    [4, 6, 10],
  );
  r = run(`${CELLS}\noneway y g if g == 1 | g == 3`).session.results.r;
  // No variance within: F missing, Bartlett's test not formed.
  assert.ok(r.F > 8e307);
  assert.equal(r.chi2bart, 0);
  assert.equal(r.df_bart, 0);
  r = run(`${CELLS}\noneway y g if g == 2 | g == 4`).session.results.r;
  close(r.chi2bart, 0.4531664156777877);
  assert.equal(r.df_bart, 1);
});

// Second round of the eighth pass, data group. Values from Stata 19 MP
// (version 17, set processors 1) in batch mode; tools/output-cases.txt
// holds the printed text (the pass8-data2-* cases).

test("a weighted percentile averages the first value within 1e-7 of the total weight of its point and the first past it", () => {
  const p50 = (input, weight) =>
    run(`input x w\n${input}\nend\nquietly summarize x [${weight}=w], detail`)
      .session.results.r.p50;
  // Stata 19: r(p50) = 2 in each, where a tolerance alone gave 1 or 1.5.
  assert.equal(p50("1 9999999\n2 2\n3 9999999", "fw"), 2);
  assert.equal(p50("1 9999999\n2 2\n3 9999999", "aw"), 2);
  assert.equal(p50("1 499999990\n2 20\n3 499999990", "aw"), 2);
  assert.equal(p50("1 1\n2 1e-8\n3 1", "aw"), 2);
  // A cumulated weight within the tolerance below the point still ties.
  const { session } = run(`set obs 3
generate x = _n
generate double w = cond(_n == 1, 1, cond(_n == 2, 1e-6, 1 - 1e-6 + 2e-8))
quietly summarize x [aw=w], detail`);
  assert.equal(session.results.r.p50, 1.5);
  // Unit weights on 1,000,001 observations: the 10th percentile ties,
  // the 25th does not (Stata 19: 100000.5 and 250001).
  const big = run(`set obs 1000001
generate x = _n
generate w = 1
quietly summarize x [fw=w], detail`).session.results.r;
  assert.equal(big.p10, 100000.5);
  assert.equal(big.p25, 250001);
});

test("frequency weights adding up to billions are summarized without expanding them", () => {
  const { session, result } = run(`input x w
1 99999990
2 20
3 99999990
end
summarize x [fw=w], detail`);
  assert.equal(result.rc, 0);
  // Stata 19: w is a float, so 99999990 is stored as 99999992.
  const r = session.results.r;
  assert.equal(r.N, 200000004);
  assert.equal(r.sum_w, 200000004);
  assert.equal(r.p50, 2);
  close(r.Var, 0.9999999050000015);
  close(r.kurtosis, 1.000000100000008);
  // A command that still repeats the observations stops with a StataError
  // instead of running out of memory.
  assert.equal(session.run("tabstat x [fw=w], stats(p50 n)").rc, 0);
  const histogram = session.run("histogram x [fw=w]");
  assert.equal(histogram.rc, 909);
  assert.match(histogram.output.at(-1).lines[0], /more than this command/);
  assert.throws(
    () =>
      weightedRows(
        session,
        session.parse("varname [fweight]", "x [fw=w]"),
        [0, 1, 2],
      ),
    (error) =>
      error instanceof StataError &&
      error.code === 909 &&
      /summarize and tabstat/.test(error.hint),
  );
});

test("tab1 and tab2 refuse non-integer frequency weights before any table", () => {
  const setup =
    "set obs 6\ngenerate x = _n\ngenerate v = _n/2\ngenerate g = mod(_n,2)";
  for (const command of [
    "tab1 x [w=v]",
    "tab1 x [fw=v]",
    "tab2 x g [w=v]",
    "tab2 x g [fw=v]",
  ]) {
    const { session, output } = run(`${setup}\ncapture noisily ${command}`);
    assert.equal(session.rc, 401, command);
    assert.ok(
      !textOf(output).some((line) => line.startsWith("-> tabulation")),
      command,
    );
  }
});

test("kwallis needs two populations, and spearman takes a matrix of variables", () => {
  const rc = (command) =>
    run(`set seed 97531
set obs 400
generate k = 1 + floor(12*runiform())
generate y = round(rnormal(50, 15) + k, 1)
capture noisily ${command}`).session.rc;
  assert.equal(rc("kwallis y if k == 1, by(k)"), 498);
  assert.equal(rc("kwallis y if k == 99, by(k)"), 2000);
  const { session } = run(`set seed 2468
set obs 250
generate g = 1 + floor(3*runiform())
generate female = runiform() < .45
generate y = round(10*rnormal() + 3*g, .5)
generate z = rnormal()
replace y = . in 7
replace z = . in 9/10
spearman y z g`);
  // Stata 19: return list.
  const r = session.results.r;
  assert.equal(r.N, 247);
  close(r.rho, 0.1987730651647424);
  close(r.p, 0.0016923394136519, 1e-10);
  assert.deepEqual(r["matrix:Nobs"].values, [
    [247, 247, 247],
    [247, 247, 247],
    [247, 247, 247],
  ]);
  assert.ok(r["matrix:P"].values[0][0] > 8e307);
  assert.equal(r["matrix:Rho"].values[2][2], 1);
  const strings = run(`set obs 5
generate y = _n
generate str3 s = "a"
capture noisily spearman y s`);
  assert.equal(strings.session.rc, 102);
  assert.ok(
    textOf(strings.output).includes("(s ignored because string variable)"),
  );
});

test("oneway takes frequency, analytic and importance weights", () => {
  const setup = `set seed 2468
set obs 250
generate g = 1 + floor(3*runiform())
generate female = runiform() < .45
generate y = round(10*rnormal() + 3*g, .5)
generate z = rnormal()
replace y = . in 7
generate w = 1 + floor(4*runiform())`;
  // Stata 19: return list.
  let r = run(`${setup}\noneway y g [fw=w]`).session.results.r;
  assert.equal(r.N, 629);
  assert.equal(r.df_r, 626);
  close(r.mss, 5670.071052086831);
  close(r.rss, 68362.88125315959);
  close(r.chi2bart, 6.61644504875383);
  r = run(`${setup}\noneway y g [iw=w]`).session.results.r;
  assert.equal(r.N, 629);
  r = run(`${setup}\noneway y g [aw=w]`).session.results.r;
  assert.equal(r.N, 249);
  close(r.mss, 2244.590925229921);
  close(r.rss, 27062.57143408067);
  close(r.chi2bart, 2.686976138476277, 1e-12);
  const generic = run(`${setup}\noneway y g [w=w]`);
  assert.ok(textOf(generic.output).includes("(analytic weights assumed)"));
  assert.equal(
    run(`${setup}\ngenerate v = w/2\ncapture oneway y g [fw=v]`).session.rc,
    401,
  );
});

test("list, sort and gsort with observations and no variables", () => {
  const rc = (command) =>
    run(`set obs 3\ncapture noisily ${command}`).session.rc;
  // Stata 19.
  assert.equal(rc("list, sepby(x)"), 198);
  assert.equal(rc("list, sepby(_all)"), 0);
  assert.equal(rc("sort _all"), 0);
  assert.equal(rc("sort x"), 111);
  assert.equal(rc("gsort _all"), 100);
  assert.equal(rc("list, N"), 0);
  assert.equal(rc("list, n"), 198);
  assert.equal(
    run("set obs 3\ngenerate a = _n\ncapture noisily list, sepby(x)").session
      .rc,
    198,
  );
  // list's footer rows are refused with a hint, not with Stata's own
  // wording for an option it lacks.
  const { session } = run("set obs 3\ngenerate a = _n");
  assert.throws(
    () => list(session, "a, N", { out: () => {} }),
    (error) =>
      error instanceof StataError &&
      error.code === 198 &&
      error.message === "option N is not available in the browser yet" &&
      /summarize/.test(error.hint),
  );
});

test("the trigonometric and hyperbolic functions, and rt() draw for draw", () => {
  const { session } = run(`set obs 4
generate double z = tanh(_n/4)
generate double a = asin(_n - 2)
generate double d = acosh(_n - 1)
generate double e = atanh(_n/2 - 1)
set seed 777
generate double t = rt(5)`);
  // Stata 19: .2449187 .4621172 .6351489 .7615942.
  const z = column(session, "z");
  [
    0.2449186624037092, 0.4621171572600098, 0.6351489523872873,
    0.7615941559557649,
  ].forEach((value, k) => close(z[k], value, 1e-15));
  assert.ok(column(session, "a")[3] > 8e307);
  assert.ok(column(session, "d")[0] > 8e307);
  assert.ok(column(session, "e")[3] > 8e307);
  // Stata 19, set seed 777, rt(5) read in %21x.
  assert.deepEqual(
    Array.from(column(session, "t")).slice(0, 3),
    [2.8830197783686815, 1.131073052850975, 1.157743972343512],
  );
  // A df below 1 or missing gives missing and takes no draw.
  const only = run(`set obs 1
set seed 777
generate double a = rt(0)
generate double b = rt(.)
generate double u = runiform()`);
  assert.ok(column(only.session, "a")[0] > 8e307);
  assert.equal(column(only.session, "u")[0], new Generator(777).uniform());
});
