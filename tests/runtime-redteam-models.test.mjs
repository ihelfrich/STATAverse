// nbreg near and at the boundary alpha = 0, on the labor data. Expected
// lines were recorded from Stata 19 MP (version 17, set processors 1) run
// on the same data, exported from the runtime with exportData(). The
// interaction layouts of ologit, oprobit and c.x##c.x are compared in
// tests/runtime-output.test.mjs (cases models-interaction-terms and
// nbreg-stata-steps).
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

function session() {
  const s = createConsoleSession();
  s.reset("labor");
  const setup = s.run(
    "encode region, generate(reg)\ngenerate y = 5 + mod(id,3)\ngenerate z = 3 + mod(id,2) + female",
  );
  assert.equal(setup.rc, 0);
  return s;
}
const lines = (out) =>
  out.output
    .flatMap((o) => o.lines)
    .join("\n")
    .split("\n");
const numeric = (t) => /^-?[\d.]+(e[-+]\d+)?$/.test(t) && t !== ".";

/**
 * Compares the row of the coefficient table whose label is label with the
 * text Stata printed after the bar: numbers to a relative tolerance, other
 * tokens exactly.
 */
function sameRow(output, label, expected, tolerance = 2e-6) {
  const line = output.find((l) => l.split("|")[0].trim() === label);
  assert.ok(line, `no row ${label}`);
  const ours = line.split("|")[1].trim().split(/\s+/),
    theirs = expected.trim().split(/\s+/);
  assert.equal(ours.length, theirs.length, `${label}: ${line}`);
  ours.forEach((token, k) => {
    if (numeric(token) && numeric(theirs[k]))
      assert.ok(
        Math.abs(Number(token) - Number(theirs[k])) <=
          tolerance * Math.max(1, Math.abs(Number(theirs[k]))),
        `${label}: ${token} vs Stata ${theirs[k]}`,
      );
    else assert.equal(token, theirs[k], `${label}: ${line}`);
  });
}
const lrLine = (output) => output.find((l) => l.startsWith("LR test of alpha"));

test("nbreg stops where Stata's ml stops when the likelihood is nearly flat in lnalpha", () => {
  const s = session();
  let out = lines(s.run("nbreg hours education i.reg, nolog"));
  sameRow(
    out,
    "/lnalpha",
    "-6.21427   .8232225                     -7.827756   -4.600783",
  );
  sameRow(
    out,
    "education",
    "-.0029396   .0032317    -0.91   0.363    -.0092736    .0033944",
  );
  sameRow(
    out,
    "_cons",
    "3.671607   .0446357    82.26   0.000     3.584122    3.759091",
  );
  assert.equal(
    lrLine(out),
    "LR test of alpha=0: chibar2(01) = 1.63                 Prob >= chibar2 = 0.101",
  );

  out = lines(s.run("nbreg hours c.education##c.education, nolog"));
  sameRow(
    out,
    "/lnalpha",
    "-6.233707   .8382452                     -7.876638   -4.590777",
  );
  sameRow(
    out,
    "_cons",
    "3.902961   .1921095    20.32   0.000     3.526434    4.279489",
  );

  out = lines(s.run("nbreg hours i.female##c.education i.reg, nolog"));
  sameRow(
    out,
    "1.female",
    "-.1141689   .0833998    -1.37   0.171    -.2776296    .0492918",
  );
  // Stata's standard error of lnalpha here moves in the sixth digit with
  // rounding in its digamma(); 13.81152 in Stata, within 3e-6 here.
  sameRow(
    out,
    "/lnalpha",
    "-9.10323   13.81152                     -36.17331    17.96685",
    5e-6,
  );
  assert.equal(
    lrLine(out),
    "LR test of alpha=0: chibar2(01) = 0.01                 Prob >= chibar2 = 0.471",
  );
});

test("a tiny LR statistic for alpha is printed in e-format as Stata prints it", () => {
  const s = session();
  const out = lines(s.run("nbreg hours i.female#i.union, irr nolog"));
  assert.equal(
    lrLine(out),
    "LR test of alpha=0: chibar2(01) = 3.4e-04              Prob >= chibar2 = 0.493",
  );
  sameRow(
    out,
    "_cons",
    "39.50271   .4480571   324.13   0.000     38.63422    40.39072",
  );
  sameRow(
    out,
    "1 0",
    ".9110673   .0151096    -5.62   0.000     .8819291    .9411682",
  );
  // At lnalpha = -10.4 the likelihood is flat to 1e-4 over a unit of
  // lnalpha. Stata reports -10.43063 (SE 50.67142) for this model and
  // -10.43067 (SE 50.67599) for the same model written i.female##i.union;
  // the runtime follows Stata's steps and lands between the two.
  const lnalpha = out
    .find((l) => l.trim().startsWith("/lnalpha"))
    .split("|")[1]
    .trim()
    .split(/\s+/);
  assert.ok(Math.abs(Number(lnalpha[0]) + 10.43063) < 1e-4, lnalpha[0]);
  assert.ok(Math.abs(Number(lnalpha[1]) / 50.67142 - 1) < 1e-4, lnalpha[1]);
});

test("nbreg at the underdispersion boundary reports lnalpha with a missing standard error", () => {
  const s = session();
  let result = s.run("nbreg y education, nolog");
  assert.equal(result.rc, 0);
  let out = lines(result);
  assert.ok(out.some((l) => /LR chi2\(1\)\s+=\s+0\.07/.test(l)));
  assert.ok(out.some((l) => l.startsWith("Log likelihood = -1128.0112 ")));
  sameRow(
    out,
    "education",
    ".0020915   .0078433     0.27   0.790    -.0132811     .017464",
  );
  sameRow(
    out,
    "_cons",
    "1.764345   .1041886    16.93   0.000     1.560139    1.968551",
  );
  // Stata: '/lnalpha |  -32.46451          .                             .           .'
  // Past lnalpha = -20 the likelihood is the Poisson one, and where the fit
  // stops along it is decided by rounding; only the missing parts are
  // compared.
  const ln = out
    .find((l) => l.trim().startsWith("/lnalpha"))
    .split("|")[1]
    .trim()
    .split(/\s+/);
  assert.ok(Number(ln[0]) < -20, ln[0]);
  assert.deepEqual(ln.slice(1), [".", ".", "."]);
  const alpha = out
    .find((l) => l.trim().startsWith("alpha |"))
    .split("|")[1]
    .trim()
    .split(/\s+/);
  assert.deepEqual(alpha.slice(1), [".", ".", "."]);
  assert.equal(
    lrLine(out),
    "LR test of alpha=0: chibar2(01) = 0.00                 Prob >= chibar2 = 1.000",
  );
  assert.equal(
    s
      .run("display e(chi2_c)")
      .output.flatMap((o) => o.lines)
      .join("")
      .trim(),
    "0",
  );

  result = s.run("nbreg z i.female, nolog");
  assert.equal(result.rc, 0);
  out = lines(result);
  sameRow(
    out,
    "1.female",
    ".2589184   .0411149     6.30   0.000     .1783346    .3395022",
  );
  sameRow(
    out,
    "_cons",
    "1.248566   .0305709    40.84   0.000     1.188648    1.308484",
  );
  assert.ok(out.some((l) => /LR chi2\(1\)\s+=\s+39\.91/.test(l)));

  out = lines(s.run("nbreg z i.female, irr nolog"));
  sameRow(
    out,
    "1.female",
    "1.295528   .0532655     6.30   0.000     1.195225    1.404248",
  );
  sameRow(
    out,
    "_cons",
    "3.485342     .10655    40.84   0.000     3.282641     3.70056",
  );
});

// The cases below were recorded from Stata 19 MP (version 17, set
// processors 1) on the labor data exported with exportData().
const display = (s, expression) =>
  s
    .run(`display ${expression}`)
    .output.flatMap((o) => o.lines)
    .join("")
    .trim();
const rowsOf = (out, label) =>
  out.filter((l) => l.split("|")[0].trim() === label);

test("a continuous variable named twice is fitted once and shown as omitted", () => {
  const s = session();
  let out = lines(s.run("regress wage education education"));
  assert.ok(out.includes("note: education omitted because of collinearity."));
  let rows = rowsOf(out, "education");
  assert.equal(rows.length, 2);
  sameRow(
    [rows[0]],
    "education",
    "1.881675   .1399872    13.44   0.000     1.606736    2.156615",
  );
  assert.equal(rows[1].split("|")[1].trim(), "0  (omitted)");
  // Stata: e(b) is 1.8816753 0 -5.7506789, the second column o.education.
  s.run("matrix b = e(b)");
  assert.equal(display(s, "b[1,1]"), "1.8816753");
  assert.equal(display(s, "b[1,2]"), "0");
  assert.equal(display(s, "b[1,3]"), "-5.7506789");
  assert.ok(
    lines(s.run("matrix list e(b)")).some((l) =>
      /\beducation\s+o\.education\s+_cons\b/.test(l),
    ),
  );

  out = lines(s.run("regress wage education c.education##c.education"));
  rows = rowsOf(out, "education");
  sameRow(
    [rows[0]],
    "education",
    "-1.878187   1.286797    -1.46   0.145     -4.40551    .6491365",
  );
  assert.equal(rows[1].split("|")[1].trim(), "0  (omitted)");
  sameRow(
    out,
    "_cons",
    "18.2276   8.365361     2.18   0.030      1.79769    34.65752",
  );

  out = lines(
    s.run("regress wage c.education##c.experience c.experience##c.education"),
  );
  assert.deepEqual(
    out.filter((l) => l.startsWith("note:")),
    [
      "note: experience omitted because of collinearity.",
      "note: education omitted because of collinearity.",
    ],
  );
  assert.equal(
    rowsOf(out, "education")[1].split("|")[1].trim(),
    "0  (omitted)",
  );
});

test("the likelihood fitters omit a repeated continuous variable as Stata does", () => {
  const s = session();
  let result = s.run("logit union education c.education##c.education, nolog");
  assert.equal(result.rc, 0);
  let out = lines(result);
  assert.ok(out.includes("note: education omitted because of collinearity."));
  assert.ok(out.some((l) => /LR chi2\(2\)\s+=\s+10\.69/.test(l)));
  let rows = rowsOf(out, "education");
  sameRow(
    [rows[0]],
    "education",
    "-.1933051   .3797778    -0.51   0.611     -.937656    .5510458",
  );
  assert.equal(rows[1].split("|")[1].trim(), "0  (omitted)");
  // Stata: e(b) is -.1933051 0 .00234557 1.5115375.
  s.run("matrix b = e(b)");
  assert.equal(display(s, "b[1,2]"), "0");
  assert.equal(display(s, "round(b[1,3], 1e-8)"), ".00234557");

  out = lines(s.run("poisson hours education c.education##c.education, nolog"));
  assert.ok(out.some((l) => /LR chi2\(2\)\s+=\s+2\.41/.test(l)));
  sameRow(
    [rowsOf(out, "education")[0]],
    "education",
    "-.0384699   .0285791    -1.35   0.178    -.0944839     .017544",
  );
  sameRow(
    out,
    "_cons",
    "3.903131   .1852544    21.07   0.000     3.540039    4.266223",
  );

  out = lines(s.run("probit union education education, nolog"));
  sameRow(
    [rowsOf(out, "education")[0]],
    "education",
    "-.0812374   .0250453    -3.24   0.001    -.1303253   -.0321495",
  );

  // tobit leaves the repeat out altogether: no note and one row.
  out = lines(
    s.run("tobit wage education c.education##c.education, ll(5) nolog"),
  );
  assert.ok(!out.some((l) => l.startsWith("note:")));
  assert.equal(rowsOf(out, "education").length, 1);
  sameRow(
    out,
    "education",
    "-1.875957   1.285213    -1.46   0.145     -4.40016    .6482458",
  );
  sameRow(
    out,
    "var(e.wage)",
    "50.35041   2.945208                      44.88583    56.48028",
  );
  // A collinear variable that is not a repeat is noted and omitted.
  s.run("generate ed2 = 2 * education");
  out = lines(s.run("tobit wage education ed2, ll(5) nolog"));
  assert.ok(out.includes("note: ed2 omitted because of collinearity."));
  sameRow(
    out,
    "education",
    "1.884176   .1399538    13.46   0.000     1.609303    2.159049",
  );
  out = lines(s.run("logit union education ed2, nolog"));
  sameRow(
    out,
    "education",
    "-.1326472   .0411263    -3.23   0.001    -.2132532   -.0520412",
  );

  out = lines(s.run("nbreg hours education c.education##c.education, nolog"));
  assert.equal(
    rowsOf(out, "education")[1].split("|")[1].trim(),
    "0  (omitted)",
  );
  sameRow(
    out,
    "/lnalpha",
    "-6.233707   .8382452                     -7.876638   -4.590777",
  );

  out = lines(
    s.run("ologit satisfaction education c.education##c.education, nolog"),
  );
  assert.ok(out.some((l) => /LR chi2\(2\)\s+=\s+11\.82/.test(l)));
  assert.ok(out.some((l) => /Prob > chi2\s+=\s+0\.0027/.test(l)));
  sameRow(
    [rowsOf(out, "education")[0]],
    "education",
    ".3109897   .3266631     0.95   0.341    -.3292582    .9512375",
  );
  out = lines(s.run("oprobit satisfaction education education, nolog"));
  sameRow(
    [rowsOf(out, "education")[0]],
    "education",
    ".0698494   .0203551     3.43   0.001     .0299541    .1097446",
  );
});

test("a factor crossed with itself is the factor", () => {
  const s = session();
  for (const command of [
    "regress wage i.female##i.female",
    "regress wage i.female#i.female",
    "regress wage i.female i.female#i.female",
  ]) {
    const out = lines(s.run(command));
    assert.ok(!out.some((l) => l.includes("female#")), command);
    sameRow(
      out,
      "1.female",
      "-1.870828   .6719161    -2.78   0.006    -3.190494   -.5511612",
    );
    sameRow(
      out,
      "_cons",
      "19.85861   .4677625    42.45   0.000     18.93991    20.77731",
    );
  }
  let out = lines(s.run("logit union i.female##i.female, nolog"));
  assert.ok(!out.some((l) => l.includes("female#")));
  sameRow(
    out,
    "1.female",
    "-.0295717   .1707013    -0.17   0.862    -.3641402    .3049968",
  );
  out = lines(s.run("ologit satisfaction i.female#i.female, nolog"));
  assert.ok(!out.some((l) => l.includes("female#")));
  sameRow(
    out,
    "1.female",
    ".3210416   .1453806     2.21   0.027     .0361008    .6059824",
  );
});

test("nbreg fits its Poisson model as Stata's poisson does, on large and zero-heavy counts", () => {
  const s = session();
  s.run(
    "generate cz = hours * (female == 0)\ngenerate m = hours * 30 + mod(id, 50)\ngenerate big = hours * 1000 + id\ngenerate c0 = floor(wage / 12)",
  );
  for (const command of ["nbreg cz i.union, nolog", "nbreg cz union, nolog"]) {
    const result = s.run(command);
    assert.equal(result.rc, 0, command);
    const out = lines(result);
    sameRow(
      out,
      command.includes("i.") ? "1.union" : "union",
      ".0269237   .1945112     0.14   0.890    -.3543112    .4081586",
    );
    sameRow(
      out,
      "_cons",
      "3.001144   .1159029    25.89   0.000     2.773978    3.228309",
    );
    sameRow(
      out,
      "/lnalpha",
      "1.638808   .0696647                      1.502268    1.775348",
    );
    assert.equal(
      lrLine(out),
      "LR test of alpha=0: chibar2(01) = 1.4e+04              Prob >= chibar2 = 0.000",
    );
  }
  const started = Date.now();
  let out = lines(s.run("nbreg m education, nolog"));
  sameRow(
    out,
    "education",
    "-.0030438   .0032281    -0.94   0.346    -.0093707    .0032831",
  );
  sameRow(
    out,
    "_cons",
    "7.101412   .0428556   165.71   0.000     7.017416    7.185407",
  );
  sameRow(
    out,
    "/lnalpha",
    "-3.587349   .0593375                     -3.703649    -3.47105",
  );
  assert.equal(
    lrLine(out),
    "LR test of alpha=0: chibar2(01) = 1.7e+04              Prob >= chibar2 = 0.000",
  );
  out = lines(s.run("nbreg big education, nolog"));
  sameRow(
    out,
    "education",
    "-.0030179   .0032618    -0.93   0.355    -.0094109     .003375",
  );
  sameRow(
    out,
    "_cons",
    "10.59426   .0433045   244.65   0.000     10.50939    10.67914",
  );
  sameRow(
    out,
    "/lnalpha",
    "-3.536381   .0575109                       -3.6491   -3.423662",
  );
  assert.equal(
    lrLine(out),
    "LR test of alpha=0: chibar2(01) = 6.5e+05              Prob >= chibar2 = 0.000",
  );
  // Counts in the tens of thousands no longer cost a pass over the count
  // at every step (the runtime took minutes here).
  assert.ok(Date.now() - started < 20000, `${Date.now() - started} ms`);

  // The iteration logs, as Stata prints them.
  const fitting = (out, title) => {
    const at = out.indexOf(title);
    return out.slice(at + 2, out.indexOf("", at + 2));
  };
  out = lines(s.run("nbreg y education"));
  assert.deepEqual(fitting(out, "Fitting Poisson model:"), [
    "Iteration 0:  Log likelihood = -1128.0112",
    "Iteration 1:  Log likelihood = -1128.0112",
  ]);
  assert.deepEqual(fitting(out, "Fitting full model:"), [
    "Iteration 0:  Log likelihood = -1128.0112",
    "Iteration 1:  Log likelihood = -1128.0112",
  ]);
  out = lines(s.run("nbreg c0 education experience"));
  assert.deepEqual(fitting(out, "Fitting Poisson model:"), [
    "Iteration 0:  Log likelihood = -665.08525",
    "Iteration 1:  Log likelihood = -665.08525",
  ]);
  assert.deepEqual(fitting(out, "Fitting full model:"), [
    "Iteration 0:  Log likelihood = -666.47631",
    "Iteration 1:  Log likelihood = -665.08664",
    "Iteration 2:  Log likelihood = -665.08525",
    "Iteration 3:  Log likelihood = -665.08525",
  ]);
  out = lines(s.run("nbreg hours education"));
  assert.deepEqual(fitting(out, "Fitting Poisson model:"), [
    "Iteration 0:  Log likelihood = -1967.5234",
    "Iteration 1:  Log likelihood = -1967.5234",
  ]);
});

test("e(rank) leaves out lnalpha at the underdispersion boundary", () => {
  const s = session();
  s.run("nbreg y education, nolog");
  // Stata: e(rank) = 2, e(k) = 3.
  assert.equal(display(s, "e(rank)"), "2");
  assert.equal(display(s, "e(k)"), "3");
  s.run("nbreg hours education, nolog");
  assert.equal(display(s, "e(rank)"), "3");
});

test("e(k) counts base and omitted coefficients and e(rank) does not", () => {
  const s = session();
  // Recorded from Stata 19: e(k) and e(rank) after each command.
  for (const [command, expected] of [
    ["logit union i.female education education, nolog", "5 3"],
    ["poisson hours i.female, nolog", "3 2"],
    ["tobit wage i.female education, ll(5) nolog", "5 4"],
    ["ologit satisfaction i.female education education, nolog", "8 6"],
    ["nbreg hours i.female education education, nolog", "6 4"],
  ]) {
    assert.equal(s.run(command).rc, 0, command);
    assert.equal(display(s, 'e(k) " " e(rank)'), expected, command);
  }
});
