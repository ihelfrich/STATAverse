import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleSession } from "../src/console-session.js";
import { PANEL_VARIABLES, panelCsv } from "../src/panel-project/panel-data.js";
import { PANEL_FILE, panelDta } from "../src/panel-project/panel-dta.js";
import { ANALYSIS_STEPS } from "../src/panel-project/analysis.js";
import {
  BLANK,
  EXPECTED_COLUMNS,
  LAB_STEPS,
  PANEL_LOAD,
  SESSION_HEADER,
  blankLines,
  changesSession,
  forData,
  stepFor,
} from "../src/panel-project/lab-steps.js";
import {
  assess,
  gatherBefore,
  gatherFacts,
  gatherFileFacts,
  preflight,
  prepareLines,
} from "../src/panel-project/lab-checks.js";
import {
  PANEL_CSV,
  PANEL_CSV_LOAD,
  PLACEHOLDER,
  doFileOf,
} from "../src/panel-project/lab-export.js";

const bytes = panelDta();

/** A session with the panel, as the lab's worker starts one. */
function start() {
  const session = createConsoleSession();
  session.addData(PANEL_FILE, bytes);
  assert.equal(session.run(SESSION_HEADER, { doFile: true }).rc, 0);
  return session;
}

/** Runs a step's text and checks it, as the lab does after Run. */
function attempt(session, id, text) {
  // The lab's worker notes what some checks need before the step runs.
  const start = gatherBefore(session, id);
  const ran = session.run(text, { doFile: true });
  assert.equal(
    ran.rc,
    0,
    `${id} stopped: ${ran.output.at(-1)?.lines.join(" ")}`,
  );
  return assess(
    id,
    JSON.parse(
      JSON.stringify(
        gatherFacts(
          session,
          id,
          ran.output.filter((record) => !record.comment),
          start,
        ),
      ),
    ),
  );
}

/** A session brought to the start of a step with the worked lines. */
function before(id) {
  const session = start();
  for (const step of LAB_STEPS) {
    if (step.id === id) break;
    assert.equal(session.run(step.worked, { doFile: true }).rc, 0, step.id);
  }
  return session;
}

const failing = (result) =>
  result.checks.filter((check) => !check.ok && !check.advisory);

test("the lab has one step for each step of the recorded analysis", () => {
  assert.deepEqual(
    LAB_STEPS.map((step) => step.id),
    ANALYSIS_STEPS.map((step) => step.id),
  );
  for (const step of LAB_STEPS) {
    assert.ok(step.idea.length >= 1 && step.decision, step.id);
    assert.equal(step.hints.length, 3, `${step.id} has three hints`);
    assert.ok(
      blankLines(step.scaffold).length > 0,
      `${step.id}'s scaffold leaves something to complete`,
    );
    assert.notEqual(step.scaffold, step.worked);
    assert.equal(blankLines(step.worked).length, 0);
  }
  assert.ok(LAB_STEPS[0].scaffold.startsWith(PANEL_LOAD));
  assert.ok(LAB_STEPS[0].worked.startsWith(PANEL_LOAD));
});

test("a scaffold differs from its worked version only where it was left open", () => {
  // Line for line the two are the same commands; a scaffold may word its
  // comments differently and leaves blanks or an unfinished line.
  for (const step of LAB_STEPS) {
    const commands = (text) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("*"));
    const scaffold = commands(step.scaffold),
      worked = commands(step.worked);
    assert.equal(scaffold.length, worked.length, step.id);
    let open = 0;
    scaffold.forEach((line, k) => {
      if (line === worked[k]) return;
      open++;
      if (!line.includes(BLANK)) {
        // The one deliberately unfinished line.
        assert.equal(step.id, "ratios");
        assert.equal(line, "gen positive_cfo = oancf > 0");
        return;
      }
      // Each blank stands for a piece of the worked line.
      const pattern = new RegExp(
        `^${line
          .split(BLANK)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("(.+)")}$`,
      );
      assert.match(worked[k], pattern, `${step.id}: ${line}`);
    });
    assert.ok(open > 0, step.id);
  }
});

test("the expected columns are the bundled panel's", () => {
  assert.deepEqual(
    EXPECTED_COLUMNS.map((column) => column.name),
    PANEL_VARIABLES.map((variable) => variable.name),
  );
  const session = start();
  session.run(PANEL_LOAD);
  const table = preflight(gatherFileFacts(session).variables);
  assert.deepEqual(
    table.filter((row) => row.state !== "ok"),
    [],
  );
  assert.deepEqual(prepareLines(gatherFileFacts(session)), []);
});

test("the worked version of every step passes its checks, and the session carries over", () => {
  const session = start(),
    reports = {};
  for (const step of LAB_STEPS) {
    const result = attempt(session, step.id, step.worked);
    assert.deepEqual(
      result.checks.filter((check) => !check.ok),
      [],
      step.id,
    );
    assert.equal(result.passed, true);
    reports[step.id] = result.report;
  }
  // What the lab shows beside the checks is read from the session.
  const flow = reports.sample.rows.map((row) => row[1]);
  assert.equal(flow.length, 6);
  const numbers = flow.map((text) => Number(text.replace(/,/g, "")));
  assert.ok(numbers[0] >= numbers[1] && numbers[1] >= numbers[2]);
  assert.ok(numbers[2] >= numbers[3] && numbers[3] > numbers[5]);
  assert.equal(numbers[3] - numbers[4], numbers[5]);
  assert.equal(reports.baseline.rows[0][0], "dual_proxy");
  assert.match(reports.baseline.note, /p = 0\.\d{3}/);
  assert.deepEqual(
    reports.robustness.rows.map((row) => row[0]),
    ["baseline", "firm_fe", "all_fees", "date_screen", "uncapped"],
  );
});

test("the checks leave r() and the model on top as the student's commands left them", () => {
  const session = before("baseline");
  attempt(session, "baseline", LAB_STEPS[9].worked);
  const show = (text) => session.run(text).output[0].lines.join("");
  assert.equal(show("display r(df)"), "2");
  assert.equal(show('display "`e(cmd)\'"'), "regress");
  const names = () => session.run("").memory.variables.map((v) => v.name);
  const had = names();
  session.run(LAB_STEPS[10].worked, { doFile: true });
  gatherFacts(session, "robustness", []);
  // The model on top is still the last one fitted, and nothing was left behind.
  assert.equal(show('display "`e(cmdline)\'"').includes("turnover_raw"), true);
  assert.equal(
    names().some((name) => /hold/.test(name)),
    false,
  );
  assert.ok(names().length > had.length);
});

test("a scaffold run as it stands is caught before it runs", () => {
  assert.deepEqual(blankLines(LAB_STEPS[1].scaffold), [3]);
  assert.deepEqual(blankLines("gen x = 1\ncount"), []);
});

test("wrong answers are named for what is wrong in the data", () => {
  // The unfinished line of step 6: a 1 where cash flow is missing.
  let session = before("ratios");
  let result = attempt(
    session,
    "ratios",
    LAB_STEPS[5].scaffold.replace(BLANK, "lag_at"),
  );
  assert.equal(result.passed, false);
  let failed = failing(result);
  assert.equal(failed.length, 1);
  assert.match(failed[0].label, /missing where cash flow is missing/);
  assert.match(
    failed[0].why,
    /[\d,]+ rows where <code>oancf<\/code> is missing/,
  );

  // A subscript in place of the lag operator.
  session = before("lag");
  result = attempt(session, "lag", "gen lag_at = at[_n-1]");
  failed = failing(result);
  assert.equal(failed.length, 1);
  assert.match(failed[0].why, /differs from <code>L\.at<\/code>/);

  // Years dropped before the lag was taken.
  session = before("lag");
  session.run("keep if fyear >= 2005 & fyear <= 2023");
  session.run("gen lag_at = L.at");
  result = assess("window", gatherFacts(session, "window", []));
  assert.equal(result.passed, true);
  assert.equal(
    result.checks.find((check) => check.advisory && !check.ok)?.label,
    "The lag was taken before the early years were dropped",
  );

  // A search for "Chair" on the title as typed misses the lower-case ones.
  session = before("titles");
  result = attempt(
    session,
    "titles",
    `gen title = strtrim(titleann)
gen dual_proxy = strpos(title, "chair") > 0 if title != ""
replace dual_proxy = . if regexm(title, "vice[ -]*chair")`,
  );
  assert.match(failing(result)[0].why, /case-sensitive/);

  // The fourth audit firm left out of the pattern.
  session = before("controls");
  result = attempt(
    session,
    "controls",
    LAB_STEPS[6].worked.replace("|pricewaterhouse|pwc", ""),
  );
  failed = failing(result);
  assert.equal(failed.length, 1);
  assert.match(failed[0].why, /Big Four auditor (is|are) coded 0/);

  // A baseline sample that takes the rows with a missing fee.
  session = before("sample");
  result = attempt(
    session,
    "sample",
    LAB_STEPS[7].worked.replace(
      "gen baseline_sample = eligible & nas > 0",
      "gen baseline_sample = nas > 0",
    ),
  );
  assert.match(failing(result)[0].label, /baseline_sample/);

  // Percentiles taken at 5 and 95 pass (the values lie inside 1 and 99);
  // a cap that was never applied does not.
  session = before("winsorize");
  result = attempt(
    session,
    "winsorize",
    LAB_STEPS[8].worked.replace(/^\s+replace .*$/gm, ""),
  );
  assert.equal(failing(result).length, 3);
  assert.match(failing(result)[0].why, /the percentiles are/);

  // No clustering, the wrong sample, no stored model, one coefficient tested.
  session = before("baseline");
  result = attempt(
    session,
    "baseline",
    `global controls size lev roa loss big4
reg lnnas dual_proxy turnover positive_cfo $controls i.fyear if eligible
test turnover`,
  );
  assert.deepEqual(
    failing(result).map((check) => check.label),
    [
      "industry and year dummies",
      "and standard errors clustered by firm",
      "The model is stored as <code>baseline</code>",
      "The two coefficients are tested together",
    ],
  );

  // The industry absorbed in place of the firm, and the log outcome given
  // to the count model.
  session = before("robustness");
  result = attempt(
    session,
    "robustness",
    LAB_STEPS[10].worked
      .replace("absorb(firmid)", "absorb(industry2)")
      .replace("poisson nas_m", "poisson lnnas"),
  );
  failed = failing(result);
  assert.equal(failed.length, 2);
  assert.match(failed[0].why, /absorbs <code>industry2<\/code>/);
  assert.match(failed[1].why, /the log of the fee/);
});

test("a step that stops with an error is reported by Stata's own message", () => {
  const session = before("lag");
  const ran = session.run("gen lag_at = L.att", { doFile: true });
  assert.equal(ran.rc, 111);
  assert.match(ran.output.at(-1).lines.join(" "), /att not found/);
});

test("a student's own CSV is prepared and then passes the same checks", () => {
  const session = createConsoleSession();
  session.addFile("mine.csv", panelCsv());
  session.run(SESSION_HEADER, { doFile: true });
  const load =
    'import delimited using "mine.csv", clear case(preserve) asdouble';
  assert.equal(session.run(load).rc, 0);
  const facts = gatherFileFacts(session),
    before = preflight(facts.variables),
    lines = prepareLines(facts);
  // The CSV lost the year-end's leading zeros and the date's type.
  assert.deepEqual(
    before.filter((row) => row.state !== "ok").map((row) => row.name),
    ["datadate", "fiscal_ye"],
  );
  assert.ok(lines.includes("tostring fiscal_ye, replace format(%04.0f)"));
  assert.ok(
    lines.includes('generate long datadate_days = date(datadate, "DMY")'),
  );
  assert.equal(session.run(lines.join("\n"), { doFile: true }).rc, 0);
  assert.deepEqual(
    preflight(gatherFileFacts(session).variables).filter(
      (row) => row.state !== "ok",
    ),
    [],
  );
  const own = [load, ...lines].join("\n");
  for (const step of LAB_STEPS) {
    const result = attempt(session, step.id, forData(step.worked, own));
    assert.equal(result.passed, true, step.id);
  }
});

test("the preflight says what a file lacks and what can be repaired", () => {
  const variables = [
    { name: "FIRMID", type: "str8", format: "%8s" },
    { name: "fyear", type: "int", format: "%8.0g" },
    { name: "at", type: "str12", format: "%12s" },
    { name: "datadate", type: "long", format: "%12.0g" },
    { name: "titleann", type: "str40", format: "%40s" },
  ];
  const table = preflight(variables),
    state = Object.fromEntries(table.map((row) => [row.name, row.state]));
  assert.equal(state.firmid, "case");
  assert.equal(state.fyear, "ok");
  assert.equal(state.at, "type");
  assert.equal(state.datadate, "type");
  assert.equal(state.non_audit_fees, "missing");
  const lines = prepareLines({
    variables,
    masks: null,
    digits: { all: 10, eight: 10 },
  });
  assert.deepEqual(lines.slice(0, 1), ["rename FIRMID firmid"]);
  assert.ok(lines.includes("egen long firmid = group(firmid_text)"));
  assert.ok(lines.includes("destring at, replace"));
  assert.ok(
    lines.includes('generate long datadate_days = date(datadate_text, "YMD")'),
  );
  // No firm number, but a firm key to make one from.
  assert.ok(
    prepareLines({
      variables: [{ name: "gvkey", type: "str6", format: "%6s" }],
      masks: null,
      digits: null,
    }).includes("egen long firmid = group(gvkey)"),
  );
});

test("commands typed in the command line are kept only when they change the session", () => {
  for (const command of [
    "gen x = 1",
    "replace x = 2 if y",
    "drop if at < 0",
    "bysort firmid: gen n = _n",
    "quietly egen m = mean(at)",
    'label var x "X"',
    "est store mine",
    "global controls size",
    "sort firmid fyear",
  ])
    assert.equal(changesSession(command), true, command);
  for (const command of [
    "tab fyear",
    "summarize at, detail",
    "list in 1/10",
    "count if at < .",
    "describe",
    "codebook, compact",
    "display 2 + 2",
    "est table baseline",
    "label list",
    "reg lnnas size",
    "duplicates report firmid fyear",
  ])
    assert.equal(changesSession(command), false, command);
});

test("the do-file holds the session's commands in order, under a header Stata can start from", () => {
  const timeline = [
    { kind: "step", step: "meet", text: LAB_STEPS[0].worked },
    { kind: "typed", text: "drop if at < 0" },
    { kind: "typed", text: 'label var at "Assets"' },
    { kind: "step", step: "lag", text: "gen lag_at = L.at   \n\n\n\ncount\n" },
  ];
  const text = doFileOf({ timeline, date: "1 January 2027" });
  const lines = text.split("\n");
  assert.ok(lines[0].startsWith("* "));
  assert.match(text, /on 1 January 2027\./);
  const at = (line) => lines.indexOf(line);
  assert.ok(at("clear all") > 0);
  assert.ok(at("clear all") < at("set more off"));
  assert.ok(at("set more off") < at(`use "${PLACEHOLDER}", clear`));
  assert.ok(at(`use "${PLACEHOLDER}", clear`) < at("*** 1. Meet the file"));
  // The bundled panel's own use line is not repeated.
  assert.equal(text.includes(PANEL_LOAD), false);
  assert.ok(at("xtset firmid fyear") < at("* typed in the command line"));
  assert.equal(
    lines.filter((line) => line === "* typed in the command line").length,
    1,
  );
  assert.ok(at("drop if at < 0") < at("*** 2. Last year's assets"));
  assert.ok(text.endsWith("gen lag_at = L.at\n\ncount\n"));
  assert.equal(/[ \t]\n/.test(text), false);

  // The whole worked analysis, exported, is a do-file that runs.
  const whole = doFileOf({
    timeline: LAB_STEPS.map((step) => ({
      kind: "step",
      step: step.id,
      text: step.worked,
    })),
  });
  const session = createConsoleSession();
  session.addData(PANEL_FILE, bytes);
  const ran = session.run(whole.replaceAll(PLACEHOLDER, PANEL_FILE), {
    doFile: true,
  });
  assert.equal(ran.rc, 0);

  // A student's own file is loaded by name, with the lines that prepared it.
  const load = 'use "mine.dta", clear\nrename FYEAR fyear';
  const own = doFileOf({
    timeline: [
      { kind: "step", step: "meet", text: forData(LAB_STEPS[0].worked, load) },
    ],
    load,
    fileName: "mine.dta",
  });
  assert.equal(own.includes(PLACEHOLDER), false);
  assert.match(own, /It was run on mine\.dta\./);
  assert.match(
    own,
    /\*\*\* 1\. Meet the file\nuse "mine\.dta", clear\nrename FYEAR fyear\ndescribe/,
  );
});

test("the year window keeps both end years, whatever else it drops", () => {
  for (const line of [
    "keep if fyear > 2005 & fyear < 2023",
    "keep if fyear >= 2010 & fyear <= 2023",
  ]) {
    const result = attempt(before("window"), "window", `${line}\ncount`);
    const failed = failing(result);
    assert.equal(failed.length, 1, line);
    assert.equal(failed[0].label, "Every row from 2005 to 2023 is still there");
    assert.match(failed[0].why, /leave out the end years/);
  }
  const worked = attempt(before("window"), "window", LAB_STEPS[2].worked);
  assert.equal(worked.passed, true);
});

test("the joint test must be of turnover and the cash-flow indicator, and the report says only what was run", () => {
  const fit = `global controls size lev roa loss big4
reg lnnas dual_proxy turnover positive_cfo $controls i.industry2 i.fyear if baseline_sample, vce(cluster firmid)
est store baseline`;
  for (const test of ["test turnover dual_proxy", "test turnover"]) {
    const result = attempt(before("baseline"), "baseline", `${fit}\n${test}`);
    assert.deepEqual(
      failing(result).map((check) => check.label),
      ["The two coefficients are tested together"],
      test,
    );
    assert.equal(/joint test/.test(result.report.note), false, test);
  }
  // Another way of typing the same test is the same test.
  const typed = attempt(
    before("baseline"),
    "baseline",
    `${fit}\ntest (turnover = 0) (positive_cfo = 0)`,
  );
  assert.equal(typed.passed, true);
  assert.match(typed.report.note, /joint test .* p = 0\.\d{3}/);
  // The dummies may be typed as a group.
  const grouped = attempt(
    before("baseline"),
    "baseline",
    `${fit.replace("i.industry2 i.fyear", "i.(industry2 fyear)")}\ntest turnover positive_cfo`,
  );
  assert.equal(grouped.passed, true);
});

test("a negative coefficient is read as less, without a minus sign", () => {
  const result = attempt(
    before("baseline"),
    "baseline",
    `reg lnnas dual_proxy turnover positive_cfo i.industry2 i.fyear if baseline_sample, vce(cluster firmid)
est store baseline
test turnover positive_cfo`,
  );
  const note = result.report.note;
  assert.match(note, /turnover goes with \d+(\.\d+)?% less/, note);
  assert.equal(/-\d+(\.\d+)?% (less|more)/.test(note), false, note);
});

test("step 11 takes the fee in dollars or in millions for the Poisson model", () => {
  const result = attempt(
    before("robustness"),
    "robustness",
    LAB_STEPS[10].worked.replace("poisson nas_m", "poisson nas"),
  );
  assert.equal(result.passed, true);
  assert.equal(/in dollars/.test(LAB_STEPS[10].idea.join(" ")), false);
});

test("step 12 wants the amount model on the whole baseline sample, and says when i. is missing", () => {
  let result = attempt(
    before("extension"),
    "extension",
    LAB_STEPS[11].worked.replace(
      "if baseline_sample, vce",
      "if baseline_sample & fyear > 2015, vce",
    ),
  );
  assert.deepEqual(
    failing(result).map((check) => check.label),
    ["<code>amount</code> is a Poisson model on the rows with a positive fee"],
  );
  result = attempt(
    before("extension"),
    "extension",
    LAB_STEPS[11].worked
      .replace("i.dual_proxy", "dual_proxy")
      .replace("i.positive_cfo", "positive_cfo"),
  );
  assert.equal(result.passed, true);
  assert.match(
    result.checks.find((check) => check.advisory && !check.ok).label,
    /factor variables/,
  );
});

test("after the checks, r() is what the student's last command left", () => {
  const session = before("robustness");
  attempt(session, "robustness", LAB_STEPS[10].worked);
  const said = session.run("return list").output.at(-1).lines.join("\n");
  assert.match(
    said,
    /r\(names\) : "baseline firm_fe all_fees date_screen uncapped"/,
  );
  assert.match(said, /r\(coef\)/);
  attempt(session, "extension", LAB_STEPS[11].worked);
  const after = session.run("return list").output.at(-1).lines.join("\n");
  assert.match(after, /r\(table\)/);
  assert.equal(/lab_hold_/.test(after), false);
});

test("a file without the fee file's year-end gets step 11 without the date screen", () => {
  const session = before("robustness");
  session.run("drop fiscal_ye");
  const step = stepFor(LAB_STEPS[10], { dated: false });
  assert.equal(step.worked.includes("fiscal_ye"), false);
  assert.equal(step.scaffold.includes("date_screen"), false);
  assert.equal(blankLines(step.worked).length, 0);
  const result = attempt(session, "robustness", step.worked);
  assert.equal(result.passed, true);
  assert.equal(
    result.checks.some((check) => /date_screen/.test(check.label)),
    false,
  );
  assert.equal(stepFor(LAB_STEPS[10]), LAB_STEPS[10]);
});

test("the do-file names the lines that load the downloaded CSV, which are the lab's own", () => {
  const text = doFileOf({ timeline: [] });
  for (const line of PANEL_CSV_LOAD) assert.ok(text.includes(`* ${line}`));
  const session = createConsoleSession();
  session.addFile(PANEL_CSV, panelCsv());
  assert.equal(session.run(PANEL_CSV_LOAD[0]).rc, 0);
  assert.deepEqual(
    prepareLines(gatherFileFacts(session)).filter(
      (line) => !line.startsWith("*"),
    ),
    PANEL_CSV_LOAD.slice(1),
  );
});
