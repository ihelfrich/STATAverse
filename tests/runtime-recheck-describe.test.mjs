// Recheck, describe group: mean, total, proportion and ratio post their
// results as an estimation command does, their tables at the default line
// size of 79, sdtest's labels and sdtesti, and the messages for a by() or
// over() typed without its comma. The expected values were recorded from
// Stata 19 (version 17, set processors 1) in batch mode.
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";

const run = (source) => {
  const session = new Session(),
    output = session.run(source).output;
  return { session, output, last: output.at(-1) };
};
const lines = (record) => record.lines.filter((line) => line.trim());
const DATA = [
  "set seed 12345",
  "set obs 30",
  "generate y = round(runiform()*10, .01)",
  "generate x = round(runiform()*5, .01)",
  "generate g = 1 + floor(runiform()*3)",
  "generate w = 1 + floor(runiform()*4)",
  "generate c = ceil(_n/3)",
  'label define gl 1 "North" 2 "South" 3 "West"',
  "label values g gl",
].join("\n");

test("mean posts e(b), e(V), e(sd) and e(_N), which lincom, test and _b read", () => {
  const { session, output } = run(
    `${DATA}\nmean y x\nlincom y - x\ntest y = x\ndisplay _b[y] " " _se[y]`,
  );
  const e = session.results.e;
  assert.equal(output.at(-4).command, "mean y x");
  const model = session.estimates;
  assert.equal(model.command, "mean");
  // Stata 19: e(V) = (.30471701, -.04272343 \ -.04272343, .07494232).
  assert.ok(Math.abs(model.V[0][0] - 0.30471701) < 1e-8);
  assert.ok(Math.abs(model.V[1][0] + 0.04272343) < 1e-8);
  assert.ok(Math.abs(model.V[1][1] - 0.07494232) < 1e-8);
  assert.deepEqual(e["matrix:_N"].values, [[30, 30]]);
  assert.ok(Math.abs(e["matrix:sd"].values[0][0] - 3.0234931) < 1e-7);
  assert.equal(
    lines(output.at(-3)).at(-2),
    "         (1) |       1.85   .6819869     2.71   0.011       .45518     3.24482",
  );
  assert.deepEqual(lines(output.at(-2)), [
    " ( 1)  y - x = 0",
    "       F(  1,    29) =    7.36",
    "            Prob > F =    0.0111",
  ]);
  assert.deepEqual(output.at(-1).lines, ["4.3516666 .55201179"]);
});

test("the covariance of weighted and clustered means is Stata's", () => {
  for (const [command, expected] of [
    // Stata 19: e(V)[1,1], e(V)[2,1], e(V)[2,2], e(sd)[1,1].
    ["mean y x [pw=w]", [0.3764306, -0.01760131, 0.06696952, 3.0347169]],
    ["mean y x [aw=w]", [0.30698356, -0.02403265, 0.06123145, 3.0347169]],
    ["mean y x [iw=w]", [0.11128154, -0.00871184, 0.0221964, 3.0022999]],
    ["mean y x [fw=w]", [0.11128154, -0.00871184, 0.0221964, 3.0022999]],
    [
      "mean y x, vce(cluster c)",
      [0.55165137, -0.04451253, 0.05734401, 3.0234931],
    ],
  ]) {
    const { session } = run(`${DATA}\n${command}`),
      { V } = session.estimates,
      sd = session.results.e["matrix:sd"].values[0][0];
    [V[0][0], V[1][0], V[1][1], sd].forEach((value, k) =>
      assert.ok(
        Math.abs(value - expected[k]) <
          5e-8 * Math.max(1, Math.abs(expected[k])),
        `${command}: ${value} against ${expected[k]}`,
      ),
    );
  }
  // Clustered, the groups of over() covary: e(V)[2,1] = .33313651.
  const { session } = run(`${DATA}\nmean y x, over(g) vce(cluster c)`);
  assert.ok(Math.abs(session.estimates.V[1][0] - 0.33313651) < 1e-8);
  assert.ok(Math.abs(session.estimates.V[3][0] + 0.46118365) < 1e-8);
});

test("weighted mean, total and proportion post e() in Stata's order", () => {
  for (const [command, scalars, macros] of [
    [
      "mean y [fw=w]",
      ["df_r", "N", "N_over", "k_eq", "rank"],
      { vce: "analytic", wexp: "= w", wtype: "fweight" },
    ],
    [
      "mean y [pw=w]",
      ["df_r", "N_over", "N", "k_eq", "rank"],
      { vce: "robust", wexp: "= w", wtype: "pweight" },
    ],
    [
      "total y [fw=w], vce(cluster c)",
      ["N_clust", "df_r", "N", "N_over", "k_eq", "rank"],
      { vce: "cluster", wtype: "fweight" },
    ],
    ["proportion g [iw=w]", ["df_r", "N", "N_over", "k_eq", "rank"], {}],
  ]) {
    const e = run(`${DATA}\n${command}`).session.results.e;
    assert.deepEqual(
      Object.keys(e).filter((key) => typeof e[key] === "number"),
      scalars,
      command,
    );
    for (const [key, value] of Object.entries(macros))
      assert.equal(e[key], value, `${command}: e(${key})`);
    const macroOrder = Object.keys(e).filter(
      (key) => typeof e[key] === "string",
    );
    assert.ok(
      !e.wtype ||
        macroOrder.indexOf("wexp") === macroOrder.indexOf("title") + 1,
      command,
    );
  }
});

test("margins after mean, total, proportion and ratio is not appropriate", () => {
  for (const command of ["mean y", "ratio y/x", "proportion g"]) {
    const { last } = run(`${DATA}\n${command}\nmargins`);
    assert.equal(last.rc, 322);
    assert.equal(
      last.lines[0],
      `command margins not appropriate after ${command.split(" ")[0]}`,
    );
  }
});

test("estat after mean, total, proportion and ratio", () => {
  const { output } = run(
    `${DATA}\nmean y, over(g)\nestat sd\ncapture noisily estat ic\ndisplay _rc\ntotal y\ncapture noisily estat sd\ndisplay _rc`,
  );
  assert.deepEqual(output[output.length - 6].lines.slice(1), [
    "-------------------------------------",
    "        Over |       Mean   Std. dev.",
    "-------------+-----------------------",
    "       c.y@g |",
    "      North  |       5.43    3.205694",
    "      South  |      4.414    2.380402",
    "       West  |   3.412727    3.342056",
    "-------------------------------------",
    "",
  ]);
  assert.deepEqual(output.at(-5).lines, ["invalid subcommand ic"]);
  assert.deepEqual(output.at(-4).lines, ["321"]);
  assert.deepEqual(output.at(-2).lines, ["mean estimation results not found"]);
  assert.deepEqual(output.at(-1).lines, ["301"]);
});

test("mean and proportion widen the first column for a long name, at the line size 79", () => {
  const { output } = run(
    [
      "set seed 3",
      "set obs 40",
      "generate household_income_2023 = round(rnormal(60000,9000),1)",
      "generate years_of_schooling = floor(8+10*runiform())",
      "generate byte owns_home_flag = runiform()<.6",
      "generate abcdefghijklmnopqrstuvwxyz_abcde = runiform()",
      "mean household_income_2023",
      "mean abcdefghijklmnopqrstuvwxyz_abcde",
      "mean household_income_2023, coeflegend",
      "proportion owns_home_flag",
    ].join("\n"),
  );
  assert.deepEqual(lines(output.at(-4)).slice(0, 5), [
    "Mean estimation                                      Number of obs = 40",
    "-----------------------------------------------------------------------",
    "                      |       Mean   Std. err.     [95% conf. interval]",
    "----------------------+------------------------------------------------",
    "household_income_2023 |   58399.72   1201.239      55969.99    60829.46",
  ]);
  assert.deepEqual(lines(output.at(-3)).slice(0, 5), [
    "Mean estimation                                              Number of obs = 40",
    "------------------------------------------------------------------------------",
    "                             |       Mean   Std. err.     [95% conf. interval]",
    "-----------------------------+------------------------------------------------",
    "abcdefghijklmnopqrstuvwxyz~e |   .5293367   .0422423      .4438936    .6147797",
  ]);
  assert.equal(
    lines(output.at(-2))[4],
    "househo~2023 |   58399.72  _b[household_income_2023]",
  );
  assert.deepEqual(lines(output.at(-1)).slice(0, 5), [
    "Proportion estimation                         Number of obs = 40",
    "----------------------------------------------------------------",
    "               |                                   Logit",
    "               | Proportion   Std. err.     [95% conf. interval]",
    "---------------+------------------------------------------------",
  ]);
});

test("summarize i.g shows the levels' value labels, cut to 11 columns", () => {
  const { last } = run(
    [
      "set obs 40",
      "generate byte region = 1 + mod(_n,3)",
      'label define reg 1 "Northeast" 2 "Comparison group for the study" 3 "Sou"',
      "label values region reg",
      "summarize i.region",
    ].join("\n"),
  );
  assert.deepEqual(lines(last).slice(2), [
    "      region |",
    "  Northeast  |         40        .325    .4743416          0          1",
    "Compariso..  |         40         .35    .4830459          0          1",
    "        Sou  |         40        .325    .4743416          0          1",
  ]);
});

test("by() or over() without its comma is read as Stata's varlist reads it", () => {
  const setup =
    "set obs 10\ngenerate y = _n\ngenerate x = mod(_n, 3)\ngenerate byte region = 1 + mod(_n, 2)\n";
  for (const [command, message, rc] of [
    [
      "ttest y by(region)",
      "factor-variable and time-series operators not allowed",
      101,
    ],
    [
      "tabstat y by(region)",
      "factor-variable and time-series operators not allowed",
      101,
    ],
    [
      "tabulate y by(region)",
      "factor-variable and time-series operators not allowed",
      101,
    ],
    [
      "sdtest y by(region)",
      "factor-variable and time-series operators not allowed",
      101,
    ],
    [
      "prtest region by(x)",
      "factor-variable and time-series operators not allowed",
      101,
    ],
    ["summarize y by(region)", "variable by not found", 111],
    ["mean y over(region)", "variable over not found", 111],
    ["total y over(region)", "variable over not found", 111],
    ["proportion x over(region)", "variable over not found", 111],
    ["regress y x by(region)", "variable by not found", 111],
    ["correlate y x by(region)", "factor-variable operators not allowed", 101],
    ["pwcorr y x by(region)", "factor-variable operators not allowed", 101],
    ["summarize y ar(1)", "coding operators not allowed", 198],
    [
      "ratio y/x over(region)",
      "parentheses are required for multiple ratio specifications",
      198,
    ],
  ]) {
    const { last } = run(setup + command);
    assert.equal(last.rc, rc, command);
    assert.equal(
      last.lines.find((line) => line.trim()),
      message,
      command,
    );
  }
  // A varlist of factor variables groups names in parentheses.
  assert.equal(run(`${setup}summarize y (region)`).last.rc, 0);
});

test("sdtest names its rows as ttest does, and refuses more than two groups", () => {
  const { output } = run(
    [
      "set seed 7",
      "set obs 30",
      "generate score_post = round(rnormal(60,10),0.1)",
      "generate byte grp = _n>15",
      'label define g 0 "Control group" 1 "Treatment group"',
      "label values grp g",
      "generate byte three = mod(_n,3)",
      "sdtest score_post, by(grp)",
      "sdtest score_post, by(three)",
    ].join("\n"),
  );
  const table = lines(output.at(-2));
  assert.equal(
    table[4],
    " Control |      15    54.44667    2.893093     11.2049     48.2416    60.65173",
  );
  assert.equal(
    table[5],
    "Treatmen |      15    61.05333    2.877927    11.14616    54.88079    67.22587",
  );
  assert.equal(
    table[9],
    "    ratio = sd(Control) / sd(Treatmen)                            f =   1.0106",
  );
  assert.equal(output.at(-1).rc, 420);
  assert.deepEqual(lines(output.at(-1)), [
    "more than 2 groups found, only 2 allowed",
    "r(420);",
  ]);
});

test("sdtesti runs the variance tests from summary statistics", () => {
  const { session, output } = run("sdtesti 30 5 2.5 40 6 3.1");
  assert.equal(
    lines(output.at(-1))[9],
    "    ratio = sd(x) / sd(y)                                         f =   0.6504",
  );
  const r = session.results.r;
  assert.equal(r.N, 70);
  assert.ok(Math.abs(r.F - 0.6503642039542142) < 1e-12);
  assert.ok(Math.abs(r.p - 0.2312191035064872) < 1e-12);
  assert.ok(Math.abs(r.sd - 2.882186310703495) < 1e-12);
  for (const [command, message, rc] of [
    [
      "sdtesti 30 5 2.5",
      "either four arguments for a one-sample test or six arguments for a two-sample\ntest must be specified",
      198,
    ],
    ["sdtesti 30 5 -2.5 3", "standard deviation is negative", 411],
    [
      "sdtesti 1 5 2.5 3",
      "only one observation, but positive standard deviation",
      499,
    ],
    ["sdtesti 30.5 5 2.5 3", "'30.5' found where integer expected", 7],
    ["sdtesti 30 5 2.5 40 6 3.1 7", "varlist not allowed", 101],
    ["sdtesti 0 5 2.5 3", "no observations", 2000],
    ["sdtesti 30 5 2.5 -3", "hypothesized standard deviation is negative", 411],
    ["sdtesti 30 5 . 3", "standard deviation is missing", 416],
  ]) {
    const { last } = run(command);
    assert.equal(last.rc, rc, command);
    assert.equal(last.lines.slice(0, -1).join("\n"), message, command);
  }
});

test("tabulate, generate() nolabel names the dummies by the number", () => {
  const { last } = run(
    [
      "set obs 8",
      "generate byte region = 1 + mod(_n,3)",
      'label define reg 1 "Northeast" 2 "Midwest" 3 "South"',
      "label values region reg",
      "tabulate region, generate(r) nolabel",
      "describe r1",
    ].join("\n"),
  );
  assert.equal(
    lines(last).at(-1),
    "r1              byte    %8.0g                 region== 1.0000",
  );
});

test("estat sd after svy: mean, and for a subpopulation with srssubpop", () => {
  const { output } = run(
    `${DATA}\nsvyset c [pw=w]\nsvy: mean y x\nestat sd\nsvy: mean y, over(g)\nestat sd, srssubpop\nestat sd`,
  );
  assert.deepEqual(lines(output.at(-4)).slice(-3, -1), [
    "           y |   4.394938    3.034717",
    "           x |   2.568765    1.355339",
  ]);
  assert.deepEqual(lines(output.at(-2)).slice(-4, -1), [
    "      North  |   6.301304    2.807294",
    "      South  |   4.321786    2.693975",
    "       West  |   3.001667    2.936174",
  ]);
  // Stata's default for a subpopulation, sqrt(e(_N) e(V_srs)).
  assert.deepEqual(lines(output.at(-1)).slice(-4, -1), [
    "      North  |   6.301304    2.767021",
    "      South  |   4.321786     2.55258",
    "       West  |   3.001667    2.833118",
  ]);
});
