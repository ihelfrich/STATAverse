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
