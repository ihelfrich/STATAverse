// Measures what follows a model. Every estimator in ESTIMATORS is fitted
// and then each command in FOLLOW is tried after it, in installed Stata and
// in the runtime, and the two return codes are compared.
//
//   node tools/postestimation-probe.mjs --record   runs Stata, writes the fixture
//   node tools/postestimation-probe.mjs            runs the runtime, writes the receipt
//
// A pair counts as agreeing when both run or both refuse. It does not
// compare what is printed; the recorded cases in tests/ do that. Graph
// commands are left out because Stata cannot draw in batch mode here.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Session } from "../src/runtime/session.js";

export const DATA = `clear
input byte d double x1 double x2 byte n double z
0 1.0 2.1 0 3
0 1.5 1.2 1 1
0 2.0 3.3 0 4
1 2.2 0.9 2 2
0 2.9 2.8 1 5
0 3.1 1.1 3 2
1 3.4 3.9 2 6
0 4.0 2.0 4 3
1 4.2 0.7 3 1
1 4.8 3.1 5 5
0 5.1 1.9 2 4
1 5.5 2.6 6 4
1 6.0 0.8 4 2
1 6.3 3.5 7 7
0 6.9 1.4 5 2
1 7.2 2.2 9 5
1 7.8 3.0 6 6
1 8.1 1.0 8 3
1 8.8 2.4 11 5
1 9.4 3.6 10 8
end
generate int cnt = n
replace cnt = 14 in 3
replace cnt = 0 in 12
replace cnt = 21 in 17
generate byte cat = 1 + (z > 2) + (z > 5)
generate byte grp = 1 + mod(_n, 3)
generate w = 1 + mod(_n, 4)
generate t = _n
generate byte pid = ceil(_n / 4)`;

export const ESTIMATORS = [
  ["regress", "regress z x1 x2"],
  ["regress, robust", "regress z x1 x2, robust"],
  ["regress with a factor", "regress z x1 x2 i.grp"],
  ["logit", "logit d x1 x2"],
  ["probit", "probit d x1 x2"],
  ["poisson", "poisson n x1 x2"],
  ["nbreg", "nbreg cnt x1 x2"],
  ["tobit", "tobit z x1 x2, ll(2)"],
  ["ologit", "ologit cat x1 x2"],
  ["oprobit", "oprobit cat x1 x2"],
  ["mlogit", "mlogit grp x1 x2"],
  ["glm binomial", "glm d x1 x2, family(binomial)"],
  ["cloglog", "cloglog d x1 x2"],
  ["qreg", "qreg z x1 x2"],
  ["ivregress 2sls", "ivregress 2sls z x2 (x1 = n w)"],
  ["ivregress liml", "ivregress liml z x2 (x1 = n w)"],
  ["ivregress gmm", "ivregress gmm z x2 (x1 = n w)"],
  ["areg", "areg z x1 x2, absorb(grp)"],
  ["xtreg, fe", "xtset pid t\nxtreg z x1 x2, fe"],
  ["xtreg, re", "xtset pid t\nxtreg z x1 x2, re"],
  ["xtreg, be", "xtset pid t\nxtreg z x1 x2, be"],
  ["newey", "tsset t\nnewey z x1 x2, lag(1)"],
  ["prais", "tsset t\nprais z x1 x2"],
];

export const FOLLOW = [
  "predict p1",
  "predict xb1, xb",
  "predict r1, residuals",
  "predict s1, stdp",
  "predict pr1, pr",
  "predict double d1 if x1 > 3",
  "test x1",
  "test x1 x2",
  "test x1 = x2",
  "testparm x1 x2",
  "lincom x1 + x2",
  "lincom x1 - x2",
  "nlcom _b[x1]/_b[x2]",
  "testnl _b[x1]*_b[x2] = 1",
  "margins",
  "margins, dydx(*)",
  "margins, dydx(x1)",
  "margins, at(x1=(2 6))",
  "margins, atmeans",
  "estat ic",
  "estat vce",
  "estat summarize",
  "estat hettest",
  "estat ovtest",
  "estat vif",
  "estat gof",
  "estat classification",
  "estat firststage",
  "estat endogenous",
  "estat overid",
  "estimates store m",
  "estimates table",
  "display _b[x1]",
  "display _se[x1]",
  "display _b[_cons]",
  "display e(N)",
  "matrix list e(b)",
  "matrix V = e(V)",
  "ereturn list",
];

/** Runs the grid in the runtime and sorts each pair against Stata's code. */
export function measure(fixture) {
  const missing = [],
    permissive = [],
    crashed = [];
  let bothRun = 0,
    bothRefuse = 0;
  ESTIMATORS.forEach(([name, setup], a) =>
    FOLLOW.forEach((command, b) => {
      const session = new Session();
      if (session.run(DATA).rc) throw new Error("the data did not load");
      if (
        session.run(
          setup
            .split("\n")
            .map((l) => `quietly ${l}`)
            .join("\n"),
        ).rc
      )
        throw new Error(`${name} did not fit`);
      let ours,
        message = "";
      try {
        const result = session.run(command);
        ours = result.rc;
        message = (result.output.at(-1)?.lines ?? []).join(" ").slice(0, 110);
      } catch (error) {
        crashed.push({
          estimator: name,
          command,
          error: String(error).slice(0, 110),
        });
        return;
      }
      const stata = fixture.rc[a][b];
      if (!ours && !stata) bothRun += 1;
      else if (ours && stata) bothRefuse += 1;
      else if (ours)
        missing.push({ estimator: name, command, rc: ours, message });
      else permissive.push({ estimator: name, command, stataRc: stata });
    }),
  );
  const pairs = ESTIMATORS.length * FOLLOW.length,
    receipt = {
      basis:
        "Each follow-up command tried after each estimator, in installed Stata (recorded) and in the runtime. Agreement means both ran or both refused; printed results are not compared here.",
      pairs,
      bothRun,
      bothRefuse,
      runsInStataOnly: missing.length,
      runsHereOnly: permissive.length,
      crashes: crashed.length,
      missing,
      permissive,
      crashed,
    };
  return receipt;
}

const FIXTURE = "tests/fixtures/stata-postestimation-rc.json";

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--record")) {
    const folder = await fs.mkdtemp(
        path.join(os.tmpdir(), "stataverse-postestimation-"),
      ),
      lines = [
        "version 17",
        "set more off",
        DATA,
        'file open fh using "rc.txt", write text replace',
      ];
    ESTIMATORS.forEach(([, setup], a) =>
      FOLLOW.forEach((command, b) =>
        lines.push(
          "preserve",
          "capture estimates clear",
          ...setup.split("\n").map((line) => `quietly ${line}`),
          `capture ${command}`,
          "local rc = _rc",
          "restore",
          `file write fh "${a} ${b} \`rc'" _n`,
        ),
      ),
    );
    lines.push("file close fh", "exit, clear", "");
    await fs.writeFile(path.join(folder, "probe.do"), lines.join("\n"));
    await promisify(execFile)(
      "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
      ["-b", "do", "probe.do"],
      { cwd: folder, timeout: 600000 },
    );
    const rc = ESTIMATORS.map(() => FOLLOW.map(() => null));
    for (const line of (
      await fs.readFile(path.join(folder, "rc.txt"), "utf8")
    ).split("\n")) {
      const [a, b, code] = line.trim().split(/\s+/).map(Number);
      if (!Number.isNaN(code) && rc[a]) rc[a][b] = code;
    }
    if (rc.some((row) => row.some((code) => code === null)))
      throw new Error("Stata did not report every pair; see " + folder);
    await fs.writeFile(
      FIXTURE,
      JSON.stringify(
        {
          source:
            "Return codes from installed Stata under version 17 for each follow-up command after each estimator, recorded by tools/postestimation-probe.mjs.",
          estimators: ESTIMATORS.map(([name]) => name),
          follow: FOLLOW,
          rc,
        },
        null,
        1,
      ) + "\n",
    );
    await promisify(execFile)("npx", ["prettier", "--write", FIXTURE]);
    console.log(
      `Recorded ${ESTIMATORS.length * FOLLOW.length} pairs from installed Stata.`,
    );
  } else {
    const receipt = measure(JSON.parse(await fs.readFile(FIXTURE, "utf8"))),
      { pairs, bothRun, bothRefuse, missing, permissive, crashed } = receipt;
    await fs.writeFile(
      "docs/verification/postestimation-probe.json",
      JSON.stringify(receipt, null, 2) + "\n",
    );
    console.log(
      `${pairs} pairs: ${bothRun} run in both, ${bothRefuse} refused in both, ${missing.length} run in Stata only, ${permissive.length} run here only, ${crashed.length} crash here`,
    );
  }
}
