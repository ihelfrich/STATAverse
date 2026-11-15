// The panel, time-series, survey-setting and survival findings of the
// re-check after release 492e426. Printed output is compared line by line
// in tests/runtime-output.test.mjs (the recheck-panel-* cases of
// tools/output-cases.txt); this file checks return codes, the settings'
// life with the data, a .dta written and read back, and values at full
// precision. Every expected value was recorded from Stata 19 MP (version
// 17, set processors 1) on the same generated data.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";
import { readDesign } from "../src/runtime/svy.js";
import { createConsoleSession } from "../src/console-session.js";
import { ERROR_MARK } from "../src/runtime/errors.js";

const close = (ours, theirs, what, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(ours - theirs) <= tolerance * Math.max(1, Math.abs(theirs)),
    `${what}: ${ours} vs Stata ${theirs}`,
  );
function session(source) {
  const s = new Session();
  const result = s.run(source);
  assert.equal(result.rc, 0, result.output.at(-1)?.lines?.join("\n"));
  return s;
}
const failure = (s, command) => {
  const result = s.run(command);
  return {
    rc: result.rc,
    // The message, without the error mark and the r(#); line after it.
    text: result.output
      .at(-1)
      .lines.map((line) =>
        line.startsWith(ERROR_MARK) ? line.slice(ERROR_MARK.length) : line,
      )
      .filter((line) => !/^r\(\d+\);$/.test(line))
      .join("\n"),
  };
};
const chars = (s) => [...(s.data.chars.get("_dta") ?? [])];

const PANEL = `clear
set obs 6
generate id = ceil(_n/3)
generate t = mod(_n-1,3)*2 + 1
generate w = _n
generate st = mod(_n,2)`;

test("xtset and svyset live in the data's characteristics as Stata writes them", () => {
  const s = session(`${PANEL}\nxtset id t, delta(2)`);
  assert.deepEqual(chars(s), [
    ["iis", "id"],
    ["tis", "t"],
    ["_TSitrvl", "1"],
    ["_TSdelta", "+1.0000000000000X+001"],
    ["_TSpanel", "id"],
    ["_TStvar", "t"],
  ]);
  s.run(
    "svyset id [pw=w], strata(st) fpc(w) vce(linearized) singleunit(certainty)",
  );
  assert.deepEqual(chars(s).slice(0, 9), [
    ["_svy_version", "3"],
    ["_svy_stages", "1"],
    ["_svy_fpc1", "w"],
    ["_svy_strata1", "st"],
    ["_svy_su1", "id"],
    ["_svy_wvar", "w"],
    ["_svy_wtype", "pweight"],
    ["_svy_singleunit", "certainty"],
    ["_svy_vce", "linearized"],
  ]);
  // A panel variable alone: _TSpanel and iis.
  s.run("xtset id");
  assert.deepEqual(
    chars(s).filter(([name]) => !name.startsWith("_svy")),
    [
      ["_TSpanel", "id"],
      ["iis", "id"],
    ],
  );
});

test("the settings are saved with the data, read back on use, and gone with other data", () => {
  const s = session(
    `${PANEL}\nxtset id t, delta(2)\nsvyset id [pw=w], strata(st)\nsave panel1\nclear\nset obs 2\ngenerate id = _n\ngenerate hh = _n\nsave other`,
  );
  // Data loaded after them do not keep them.
  assert.equal(s.panel, null);
  assert.equal(failure(s, "xtset").rc, 459);
  s.run("use panel1, clear");
  assert.deepEqual(s.panel, { id: "id", time: "t", delta: 2 });
  assert.equal(readDesign(s.data)?.strata, "st");
  assert.equal(readDesign(s.data)?.psu, "id");
  // An earlier xtset does not carry over to another dataset.
  s.run("use other, clear");
  assert.equal(s.panel, null);
  assert.equal(
    failure(s, "xtset").text,
    "panel variable not set; use xtset varname ...",
  );
});

test("xtset and svyset do not mark the data changed, as in Stata", () => {
  const s = session(
    `${PANEL}\nsave base\nuse base, clear\nxtset id t\nsvyset id`,
  );
  assert.equal(s.run("display c(changed)").output.at(-1).lines[0], "0");
  // use without clear is allowed.
  assert.equal(s.run("use base").rc, 0);
});

test("a .dta file written by the Console carries the settings to a new session", () => {
  const first = createConsoleSession();
  first.run(`${PANEL}\nxtset id t, delta(2)\nsvyset id [pw=w]`);
  const { bytes } = first.exportData(),
    second = createConsoleSession();
  second.addData("panel.dta", bytes);
  const result = second.run("use panel, clear\nxtset\nsvyset");
  assert.equal(result.rc, 0);
  const shown = result.output.flatMap((o) => o.lines);
  assert.ok(
    shown.includes("Panel variable: id (strongly balanced)"),
    shown.join("\n"),
  );
  assert.ok(shown.includes("         Delta: 2 units"), shown.join("\n"));
  assert.ok(shown.includes(" Sampling unit 1: id"), shown.join("\n"));
});

test("merge and other remade data keep the settings, as Stata keeps _dta's characteristics", () => {
  const s = session(
    `${PANEL}\ngenerate x = _n\nsave m\nxtset id t, delta(2)\nmerge 1:1 id t using m, nogenerate`,
  );
  assert.deepEqual(s.panel, { id: "id", time: "t", delta: 2 });
});

test("rename writes the new names into _TStvar and _TSpanel only", () => {
  const s = session(
    `${PANEL}\nxtset id t, delta(2)\nrename t time\nrename id panel`,
  );
  const own = new Map(chars(s));
  assert.equal(own.get("_TStvar"), "time");
  assert.equal(own.get("_TSpanel"), "panel");
  assert.equal(own.get("tis"), "t");
  assert.equal(own.get("iis"), "id");
  assert.deepEqual(s.panel, { id: "panel", time: "time", delta: 2 });
});

test("tsset alone with nothing set is tsset's error; xtset's is its own", () => {
  const s = session("clear\nset obs 3\ngenerate t = _n");
  assert.deepEqual(failure(s, "tsset"), {
    rc: 111,
    text: "time variable not set, use tsset varname ...",
  });
  assert.equal(failure(s, "xtset").rc, 459);
  s.run("generate id = 1\nxtset id");
  // A panel variable alone is not a time variable to tsset.
  assert.equal(failure(s, "tsset").rc, 111);
});

test("tsset alone checks the data again, and a failed tsset keeps the settings", () => {
  const s = session(
    "clear\nset obs 6\ngenerate t = _n\ngenerate y = _n^2\ntsset t\nreplace t = 1 in 2\nsort t",
  );
  assert.deepEqual(failure(s, "tsset"), {
    rc: 451,
    text: "repeated time values in sample",
  });
  // The settings stay as they were.
  assert.deepEqual(s.panel, { id: null, time: "t", delta: 1 });
  // An estimation command's operators meet the repeat too; generate's do
  // not.
  assert.deepEqual(failure(s, "regress y L.y"), {
    rc: 451,
    text: "repeated time values in sample",
  });
  assert.equal(s.run("generate ly = L.y").rc, 0);
});

test("a time-series operator on a string variable in an estimation is r(109)", () => {
  const s = session(
    'clear\nset obs 5\ngenerate t = _n\ngenerate y = _n\ngenerate s = "a"\ntsset t',
  );
  assert.deepEqual(failure(s, "regress y L.s"), {
    rc: 109,
    text: "s:  may not use time-series operators on string variables",
  });
});

test("tin() and twithin() are Stata's errors where Stata gives them", () => {
  const s = session(
    "clear\nset obs 8\ngenerate q = tq(1995q1) + _n - 1\nformat q %tq",
  );
  assert.deepEqual(failure(s, "count if tin(1995q3, 1996q1)"), {
    rc: 101,
    text: "time-series operators not allowed",
  });
  s.run("tsset q");
  assert.equal(failure(s, "count if tin(tq(1995q3), tq(1996q1))").rc, 198);
  assert.equal(failure(s, "count if tin(1995q3)").rc, 198);
  assert.equal(failure(s, "count if TIN(1995q3, 1996q1)").rc, 133);
  assert.equal(
    s.run("count if tin(1995q3, 1996q1)").output.at(-1).lines[0].trim(),
    "3",
  );
});

test("xtreg refuses two models and takes wls with be", () => {
  const s = session(
    "clear\nset seed 2024\nset obs 30\ngenerate id = ceil(_n/10)\ngenerate t = mod(_n-1,10) + 1\ngenerate x = rnormal()\ngenerate y = x + rnormal()\nxtset id t",
  );
  assert.deepEqual(failure(s, "xtreg y x, fe re"), {
    rc: 198,
    text: "only one of re, fe, be, pa, or cre is allowed",
  });
  assert.equal(failure(s, "xtreg y x, fe mle").rc, 198);
  assert.deepEqual(failure(s, "xtreg y x, re wls"), {
    rc: 198,
    text: "option wls not allowed",
  });
  // With every panel the same size wls changes nothing.
  s.run("quietly xtreg y x, be");
  const b = s.results.e["matrix:b"]?.values?.[0]?.[0] ?? s.estimates.b[0];
  s.run("quietly xtreg y x, be wls");
  close(s.estimates.b[0], b, "be wls on balanced panels");
});

test("corrgram's autocorrelations reach back in time across gaps", () => {
  const s = session(
    "clear\nset seed 12\nset obs 40\ngenerate t = _n\ngenerate y = sum(rnormal())\nreplace y = . in 7\nreplace y = . in 20/22\ndrop in 30\ntsset t\ncorrgram y, lags(4)",
  );
  const r = s.results.r;
  close(r.ac1, 0.7642250821382859, "r(ac1)");
  close(r.pac1, 0.8384344572229747, "r(pac1)");
  close(r.q1, 22.24505203350601, "r(q1)");
  close(r.ac4, 0.3961886745829475, "r(ac4)");
  close(r.pac2, -0.2748337970627754, "r(pac2)");
  close(r.q4, 51.03357176190591, "r(q4)");
  assert.equal(r.lags, 4);
});

test("estat concordance after stcox is Harrell's C", () => {
  const s = session(
    "clear\nset seed 404\nset obs 200\ngenerate treat = runiform() > .5\ngenerate age = 40 + 20*runiform()\ngenerate t = ceil(-ln(runiform())*20/exp(.5*treat - .03*(age-50)))\ngenerate died = runiform() < .7\nstset t, failure(died)\nquietly stcox treat age\nestat concordance",
  );
  const r = s.results.r;
  close(r.C, 0.5903668356695496, "r(C)");
  close(r.D, 0.1807336713390992, "r(D)");
  assert.equal(r.n_P, 13412);
  assert.equal(r.n_E, 7918);
  assert.equal(r.n_T, 0);
  assert.equal(r.N, 200);
  // After streg it is not valid, as in Stata.
  s.run("quietly streg treat age, dist(weibull)");
  assert.deepEqual(failure(s, "estat concordance"), {
    rc: 321,
    text: "estat concordance not valid",
  });
});

test("vce(hac) is Stata's error where Stata has no hac, and not yet here where it has", () => {
  const s = session(
    "clear\nset seed 3\nset obs 30\ngenerate t = _n\ngenerate y = rnormal()\ngenerate x = rnormal()\ngenerate z = rnormal()\ntsset t",
  );
  assert.deepEqual(failure(s, "regress y x, vce(hac nwest 2)"), {
    rc: 198,
    text: "vcetype hac not allowed",
  });
  assert.match(
    failure(s, "glm y x, vce(hac nwest 2)").text,
    /not available yet/,
  );
  assert.match(
    failure(s, "ivregress 2sls y (x = z), vce(hac nwest)").text,
    /not available yet/,
  );
});

test("factor variables under time-series operators name their coefficients as Stata does", () => {
  const s = session(
    "clear\nset seed 77\nset obs 160\ngenerate firm = ceil(_n/8)\ngenerate year = 2010 + mod(_n-1,8)\ngenerate x1 = rnormal()\ngenerate union = runiform() > .5\ngenerate y = 1 + .5*x1 + .3*union + rnormal()\nxtset firm year\nquietly regress y i.union##cL.x1",
  );
  assert.deepEqual(s.estimates.names, [
    "0b.union",
    "1.union",
    "L.x1",
    "0b.union#coL.x1",
    "1.union#cL.x1",
    "_cons",
  ]);
  s.run("quietly regress y L.i.union");
  assert.deepEqual(s.estimates.names, ["0bL.union", "1L.union", "_cons"]);
});
