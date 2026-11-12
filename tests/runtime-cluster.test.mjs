// Robust and clustered standard errors against installed Stata, recorded by
// tools/check-cluster-native.mjs. A request the runtime does not act on has
// to stop: it once printed the conventional standard errors instead.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Session } from "../src/runtime/session.js";
import { Dataset } from "../src/runtime/store.js";
import { clusterData } from "../tools/check-cluster-native.mjs";

const { cases } = JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/stata-runtime-cluster.json", import.meta.url),
    ),
  ),
  KEEP = /adjusted for|^\s+(x1|x2|_cons) \|/;

function session() {
  const s = new Session();
  s.data = Dataset.fromRows(clusterData());
  s.run("xtset firm year");
  return s;
}

test("clustered and robust standard errors match Stata", () => {
  assert.ok(cases.length >= 17);
  for (const recorded of cases) {
    const s = session(),
      run = s.run(recorded.command),
      // Likelihood estimators agree to the tolerance of the contract.
      tolerance = /^(logit|probit|poisson)/.test(recorded.command)
        ? 1e-5
        : 1e-9;
    assert.equal(run.rc, 0, recorded.command);
    recorded.V.forEach((row, i) =>
      row.forEach((value, j) => {
        const mine = s.estimates.V[i][j];
        assert.ok(
          Math.abs(mine - value) <= tolerance * Math.abs(value),
          `${recorded.command}: V[${i},${j}] ${mine} for ${value}`,
        );
      }),
    );
    const printed = run.output[0].lines.filter((line) => KEEP.test(line));
    if (tolerance === 1e-9)
      assert.deepEqual(printed, recorded.lines, recorded.command);
    else {
      // Printed digits of a likelihood fit may differ in the seventh.
      assert.equal(printed.length, recorded.lines.length, recorded.command);
      printed.forEach((line, k) => {
        const mine = line.split(/\s+/),
          theirs = recorded.lines[k].split(/\s+/);
        assert.equal(mine.length, theirs.length, line);
        mine.forEach((word, w) => {
          const a = Number(word),
            b = Number(theirs[w]);
          if (Number.isNaN(a) || Number.isNaN(b)) assert.equal(word, theirs[w]);
          else
            assert.ok(Math.abs(a - b) <= 2e-6 * Math.abs(b) + 1e-9, `${line}`);
        });
      });
    }
    assert.equal(s.results.e.vce, recorded.vce, recorded.command);
    assert.equal(s.results.e.N_clust ?? null, recorded.clusters);
  }
});

test("a clustered fit differs from the conventional one", () => {
  const se = (command) => {
    const s = session();
    s.run(command);
    return Math.sqrt(s.estimates.V[0][0]);
  };
  for (const command of [
    "logit yb x1 x2",
    "probit yb x1 x2",
    "poisson cnt x1 x2",
    "ivregress 2sls y x2 (x1 = z)",
  ])
    assert.notEqual(se(`${command}, vce(cluster cl)`), se(command), command);
});

test("a variance the runtime does not compute is refused", () => {
  for (const command of [
    "logit yb x1 x2, vce(bootstrap)",
    "logit yb x1 x2, vce(hc3)",
    "probit yb x1 x2, vce(jackknife)",
    "poisson cnt x1 x2, vce(nonsense)",
    "ivregress 2sls y x2 (x1 = z), vce(hac nwest)",
    "ivregress gmm y x2 (x1 = z), vce(cluster cl)",
    "ivregress liml y x2 (x1 = z), vce(cluster cl)",
    "xtreg y x1 x2, fe vce(cluster reg)",
    "xtreg y x1 x2, re vce(cluster cl)",
    "xtreg y x1 x2, fe vce(bootstrap)",
  ]) {
    const run = session().run(command);
    assert.equal(run.rc, 198, command);
    assert.match(run.output[0].lines.join("\n"), /not available yet/, command);
  }
});

test("the conventional variance can still be named", () => {
  for (const command of [
    "logit yb x1 x2, vce(oim)",
    "ivregress 2sls y x2 (x1 = z), vce(unadjusted)",
    "xtreg y x1 x2, fe vce(conventional)",
  ])
    assert.equal(session().run(command).rc, 0, command);
});

test("observations with no cluster are left out", () => {
  const s = session();
  s.run('replace cl = . in 1/4\nreplace cls = "" in 1/4');
  s.run("logit yb x1 x2, vce(cluster cl)");
  assert.equal(s.results.e.N, 44);
  s.run("regress y x1 x2, vce(cluster cls)");
  assert.equal(s.results.e.N, 44);
});
