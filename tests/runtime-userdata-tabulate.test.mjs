// tabulate, table, mean and proportion on a student's own .dta files. The
// three files in tests/fixtures/userdata were written by Stata 19 from
// simulated data, and every expected table was recorded from Stata 19 MP
// (version 17, set processors 1) running the same commands on them.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

const fixture = (name) =>
  new Uint8Array(
    fs.readFileSync(new URL(`./fixtures/userdata/${name}`, import.meta.url)),
  );

function session(...files) {
  const s = createConsoleSession();
  for (const name of files) s.addData(name, fixture(`tabulate-${name}`));
  return s;
}
// The text one command prints, without its leading and trailing blank
// lines or the blanks that end each line.
function printed(s, command) {
  const result = s.run(command);
  assert.equal(result.rc, 0, `${command}: r(${result.rc})`);
  const lines = result.output.at(-1).lines.map((line) => line.trimEnd());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines;
}

test("tab _merge after merging two files sizes its labels from the whole value label", () => {
  const s = session("master.dta", "scores.dta");
  assert.equal(
    s.run("use master.dta, clear\nquietly merge 1:1 id using scores.dta").rc,
    0,
  );
  assert.deepEqual(printed(s, "tabulate _merge"), [
    "   Matching result from |",
    "                  merge |      Freq.     Percent        Cum.",
    "------------------------+-----------------------------------",
    "        Master only (1) |        100       40.00       40.00",
    "         Using only (2) |         50       20.00       60.00",
    "            Matched (3) |        100       40.00      100.00",
    "------------------------+-----------------------------------",
    "                  Total |        250      100.00",
  ]);
  // A subset still uses the longest label of all 150, "Country number 150".
  assert.deepEqual(printed(s, "tabulate country if country <= 3"), [
    "           country |      Freq.     Percent        Cum.",
    "-------------------+-----------------------------------",
    "  Country number 1 |          1       20.00       20.00",
    "  Country number 2 |          2       40.00       60.00",
    "  Country number 3 |          2       40.00      100.00",
    "-------------------+-----------------------------------",
    "             Total |          5      100.00",
  ]);
  assert.deepEqual(printed(s, "tabulate country _merge if country <= 3"), [
    "                   | Matching result from",
    "                   |         merge",
    "           country | Master on  Matched ( |     Total",
    "-------------------+----------------------+----------",
    "  Country number 1 |         0          1 |         1",
    "  Country number 2 |         2          0 |         2",
    "  Country number 3 |         0          2 |         2",
    "-------------------+----------------------+----------",
    "             Total |         2          3 |         5",
  ]);
});

test("tabulate takes analytic and importance weights from a file", () => {
  const s = session("weights.dta");
  s.run("use weights.dta, clear");
  assert.deepEqual(printed(s, "tabulate region employed [aweight=wt]"), [
    "                      |       employed",
    "        Census region |        No        Yes |     Total",
    "----------------------+----------------------+----------",
    "                North | 15.210742 16.7167169 | 31.927459",
    "                South | 7.0295951   15.81329 | 22.842885",
    "Less than high school | 12.154695   13.07496 | 25.229655",
    "----------------------+----------------------+----------",
    "                Total | 34.395033  45.604967 |        80",
  ]);
  assert.deepEqual(printed(s, "tabulate region [iweight=wt]"), [
    "        Census region |      Freq.     Percent        Cum.",
    "----------------------+-----------------------------------",
    "                North | 53.9220391       39.91       39.91",
    "                South | 38.5791723       28.55       68.46",
    "Less than high school | 42.6101696       31.54      100.00",
    "----------------------+-----------------------------------",
    "                Total | 135.111381      100.00",
  ]);
  assert.deepEqual(printed(s, "tabulate region employed, cell nofreq"), [
    "                      |       employed",
    "        Census region |        No        Yes |     Total",
    "----------------------+----------------------+----------",
    "                North |     16.25      20.00 |     36.25",
    "                South |     10.00      20.00 |     30.00",
    "Less than high school |     16.25      17.50 |     33.75",
    "----------------------+----------------------+----------",
    "                Total |     42.50      57.50 |    100.00",
  ]);
});

test("mean over() and proportion take sampling weights from a file", () => {
  const s = session("weights.dta");
  s.run("use weights.dta, clear");
  assert.deepEqual(printed(s, "mean income [pweight=wt], over(region)"), [
    "Mean estimation                                       Number of obs = 80",
    "",
    "------------------------------------------------------------------------",
    "                       |       Mean   Std. err.     [95% conf. interval]",
    "-----------------------+------------------------------------------------",
    "       c.income@region |",
    "                North  |   42559.45   2232.495      38115.78    47003.12",
    "                South  |   38949.24   2916.793      33143.51    44754.97",
    "Less than high school  |   41780.74   2336.557      37129.94    46431.54",
    "------------------------------------------------------------------------",
  ]);
  assert.deepEqual(printed(s, "proportion employed [pweight=wt]"), [
    "Proportion estimation                       Number of obs = 80",
    "",
    "--------------------------------------------------------------",
    "             |                                   Logit",
    "             | Proportion   Std. err.     [95% conf. interval]",
    "-------------+------------------------------------------------",
    "    employed |",
    "         No  |   .4299379   .0586648      .3189641    .5484296",
    "        Yes  |   .5700621   .0586648      .4515704    .6810359",
    "--------------------------------------------------------------",
  ]);
});

test("table shows variable labels and takes nformat()", () => {
  const s = session("weights.dta");
  s.run("use weights.dta, clear");
  assert.deepEqual(
    printed(s, "table (region) (wave), statistic(mean income) nformat(%9.1f)"),
    [
      "------------------------------------------------------",
      "                        |              wave",
      "                        |        1         2     Total",
      "------------------------+-----------------------------",
      "Census region           |",
      "  North                 |  40339.0   43631.5   42269.1",
      "  South                 |  39508.3   40067.7   39764.6",
      "  Less than high school |  40211.9   42260.1   41122.2",
      "  Total                 |  40021.3   42240.0   41130.7",
      "------------------------------------------------------",
    ],
  );
  assert.deepEqual(printed(s, "table region"), [
    "------------------------------------",
    "                        |  Frequency",
    "------------------------+-----------",
    "Census region           |",
    "  North                 |         29",
    "  South                 |         24",
    "  Less than high school |         27",
    "  Total                 |         80",
    "------------------------------------",
  ]);
  // Options Stata's table has and this one does not are refused, not
  // ignored.
  for (const option of ["style(table-1)", "name(mine)", "command(regress)"]) {
    const result = s.run(`table region, ${option}`);
    assert.equal(result.rc, 198, option);
    assert.match(
      result.output.at(-1).lines.join("\n"),
      /not available in the browser/,
    );
  }
});
