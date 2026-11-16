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

// ----- the second re-check of the panel fixes -----

test("xtreg, fe with no regressor leaves the within R-squared missing, as Stata mostly does", () => {
  const s = session(
    "clear\nset seed 2\nset obs 30\ngenerate id = ceil(_n/6)\ngenerate t = mod(_n-1,6)+1\ngenerate y = rnormal() + id\nxtset id t\nquietly xtreg y, fe",
  );
  // Stata's e(r2_w) is _regress's e(r2), rounding noise: missing for 9 of
  // 12 seeds of this design, 1e-16 for the others.
  assert.equal(s.results.e.r2_w >= 8.98e307, true);
  assert.equal(s.results.e.r2_a >= 8.98e307, true);
});

test("ac and pac generate() and yw give Stata's values", () => {
  const s = session(
    "clear\nset seed 31\nset obs 50\ngenerate t = _n\ngenerate y = sum(rnormal())\ndrop in 10\ndrop in 25/26\nreplace y = . in 40\ntsset t\nac y, lags(5) generate(a1) nograph\npac y, lags(5) generate(p2) yw nograph\npac y in 3/45, lags(4) generate(p3) yw nograph",
  );
  const column = (name) => [...s.data.get(name).data];
  const ac = [
      0.6747575530420731, 0.5086996266226483, 0.2751875582245585,
      0.1339530370923612, 0.1295643588167704,
    ],
    yw = [
      0.6747575530420731, 0.0980386472857206, -0.186410018119588905,
      -0.0390984709163955321, 0.182399287714912206,
    ];
  ac.forEach((v, k) => close(column("a1")[k], v, `ac ${k + 1}`, 1e-12));
  yw.forEach((v, k) => close(column("p2")[k], v, `pac yw ${k + 1}`, 1e-12));
  // pac's yw takes the autocorrelations of the whole series, as pac.ado
  // runs ac without if and in.
  yw.slice(0, 4).forEach((v, k) => close(column("p3")[k], v, `in ${k}`, 1e-12));
  assert.equal(s.data.get("a1").format, "%10.0g");
  assert.equal(s.data.get("p2").label, "Partial autocorrelations of y");
  // A graph is drawn with its confidence bands.
  const drawn = s.run("ac y, lags(3)");
  assert.equal(drawn.rc, 0);
  assert.match(
    JSON.stringify(drawn.output.at(-1)),
    /within 95% confidence bands/,
  );
  assert.equal(failure(s, "ac y, ciopts(color(red))").rc, 198);
});

test("estat concordance, gheller gives Gonen and Heller's K and its standard error", () => {
  const s = session(
    "clear\nset seed 404\nset obs 200\ngenerate treat = runiform() > .5\ngenerate age = 40 + 20*runiform()\ngenerate t = ceil(-ln(runiform())*20/exp(.5*treat - .03*(age-50)))\ngenerate died = runiform() < .7\nstset t, failure(died)\nquietly stcox treat age\nquietly estat concordance, gheller se",
  );
  const r = s.results.r;
  close(r.K, 0.5985086244430597, "K", 1e-13);
  close(r.D_K, 0.1970172488861195, "D_K", 1e-12);
  close(r.K_s, 0.5983315284592418, "K_s", 1e-13);
  close(r.K_s_se, 0.0236441081456548, "K_s_se", 1e-10);
  assert.equal(r.N, 200);
  s.run(
    "quietly stcox i.treat c.age##c.age\nquietly estat concordance, gheller se harrell",
  );
  close(s.results.r.K, 0.5987282240979318, "K", 1e-13);
  close(s.results.r.K_s_se, 0.023807887664437984, "K_s_se", 1e-10);
  close(s.results.r.C, 0.5906650760512974, "C", 1e-13);
});

test("predict ue after xtreg, fe is y - xb outside the sample too", () => {
  const s = session(
    "clear\nset obs 16\ngenerate id = ceil(_n/4)\ngenerate t = mod(_n-1,4)+1\nset seed 7\ngenerate x = rnormal()\ngenerate y = 1 + x + rnormal() + id/3\nreplace t = . in 3\nreplace t = . in 10\nxtset id t\nquietly xtreg y x, fe\npredict double ue1, ue",
  );
  const ue = s.data.get("ue1").data;
  close(ue[2], 1.204911061057207, "ue 3");
  close(ue[9], 0.5868439373240597, "ue 10");
  close(ue[0], -1.053970322319535, "ue 1");
});

test("bootstrap resamples whole panels and sorts each sample for lags", () => {
  const s = session(
    "clear\nset seed 101\nset obs 60\ngenerate id = ceil(_n/6)\ngenerate t = mod(_n-1,6)+1\ngenerate x = rnormal()\ngenerate y = x + rnormal() + id/4\ngenerate nid = id\nxtset nid t\nset seed 5\nquietly bootstrap _b, reps(20) cluster(id) idcluster(nid) nodots: regress y L.x",
  );
  const se = (k) => Math.sqrt(s.estimates.V[k][k]);
  close(se(0), 0.1353128774488871, "se L.x", 1e-10);
  close(se(1), 0.2450260897916466, "se _cons", 1e-10);
  assert.equal(s.results.e.N, 50);
  assert.equal(s.results.e.N_reps, 20);
});

test("svyset keeps every design Stata takes, svy refuses what it cannot estimate", () => {
  const s = session(
    "clear\nset seed 71\nset obs 60\ngenerate psu = ceil(_n/4)\ngenerate st = ceil(_n/30)\ngenerate ssu = mod(_n,2)\ngenerate w = 1 + runiform()*3\ngenerate fp = 40\ngenerate fp2 = 100\ngenerate y = rnormal()\ngenerate w2 = w",
  );
  for (const design of [
    "svyset psu [iw=w], strata(st)",
    "svyset psu [pw=w], strata(st) fpc(fp) || ssu, fpc(fp2)",
    "svyset psu [pw=w], poststrata(st) postweight(fp)",
    "svyset [pw=w], vce(jackknife) jkrweight(w2)",
  ]) {
    assert.equal(s.run(design).rc, 0, design);
    assert.equal(s.run("svyset").rc, 0, design);
    const refused = failure(s, "svy: mean y");
    assert.equal(refused.rc, 198, design);
    assert.match(refused.text, /svy cannot estimate with the survey design/);
  }
  // A failed svyset leaves the design as it was.
  s.run("svyset psu [pw=w], strata(st)");
  const before = chars(s);
  assert.equal(failure(s, "svyset psu [pw=w], fay(3)").rc, 125);
  assert.deepEqual(chars(s), before);
  assert.equal(failure(s, "svyset [pw=w], noclear strata(st)").rc, 198);
  assert.deepEqual(chars(s), before);
});

test("tsfill fills the gaps of each panel, or all with full", () => {
  const s = session(
    "clear\ninput id t y\n1 1 10\n1 2 11\n1 5 14\n2 2 20\n2 4 22\n3 3 30\nend\nxtset id t\ntsfill",
  );
  assert.equal(s.data.n, 9);
  assert.deepEqual([...s.data.get("t").data], [1, 2, 3, 4, 5, 2, 3, 4, 3]);
  assert.equal(s.data.get("y").data[2] >= 8.98e307, true);
  s.run("tsfill, full");
  assert.equal(s.data.n, 15);
});
