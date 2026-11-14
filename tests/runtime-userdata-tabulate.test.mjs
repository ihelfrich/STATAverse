// tabulate, table, mean and proportion on a student's own .dta files. The
// four files in tests/fixtures/userdata were written by Stata 19 from
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

// tabulate-unicode.dta has East Asian and accented value and variable
// labels; Stata lays its tables out in screen columns (two for a wide
// character) and wraps headings in bytes.
test("tabulate and table line up East Asian and accented labels from a file", () => {
  const s = session("unicode.dta");
  s.run("use unicode.dta, clear");
  assert.deepEqual(printed(s, "tabulate region"), [
    "     Région de résidence |      Freq.     Percent        Cum.",
    "-------------------------+-----------------------------------",
    "                北部地域 |         13       32.50       32.50",
    "Région économique du sud |         14       35.00       67.50",
    "  東京都と周辺の地域です |         13       32.50      100.00",
    "-------------------------+-----------------------------------",
    "                   Total |         40      100.00",
  ]);
  assert.deepEqual(printed(s, "tabulate region wave"), [
    "                      |       調査の回",
    "  Région de résidence |         1          2 |     Total",
    "----------------------+----------------------+----------",
    "             北部地域 |         6          7 |        13",
    "Région économique du  |         7          7 |        14",
    " 東京都と周辺の地域で |         7          6 |        13",
    "----------------------+----------------------+----------",
    "                Total |        20         20 |        40",
  ]);
  assert.deepEqual(printed(s, "tabulate wave region"), [
    "    調査の |       Région de résidence",
    "        回 |  北部地域  Région éc   東京都と |     Total",
    "-----------+---------------------------------+----------",
    "         1 |         6          7          7 |        20",
    "         2 |         7          7          6 |        20",
    "-----------+---------------------------------+----------",
    "     Total |        13         14         13 |        40",
  ]);
  assert.deepEqual(printed(s, "tabulate region, summarize(income)"), [
    "  Région de |          Summary of income",
    "  résidence |        Mean   Std. dev.       Freq.",
    "------------+------------------------------------",
    "   北部地域 |   35,711.71    8,794.90          13",
    "  Région éc |   39,239.26    9,246.97          14",
    "   東京都と |   35,063.27   10,780.52          13",
    "------------+------------------------------------",
    "      Total |   36,735.61    9,570.47          40",
  ]);
  assert.deepEqual(
    printed(s, "tabulate region wave, summarize(income) means"),
    [
      "                              Means of income",
      "",
      " Région de |      調査の回",
      " résidence |         1          2 |     Total",
      "-----------+----------------------+----------",
      "  北部地域 | 34,305.65  36,916.91 | 35,711.71",
      " Région éc | 45,934.03  32,544.50 | 39,239.26",
      "  東京都と | 36,467.74  33,424.73 | 35,063.27",
      "-----------+----------------------+----------",
      "     Total | 39,132.31  34,338.91 | 36,735.61",
    ],
  );
  assert.deepEqual(printed(s, "table region wave"), [
    "---------------------------------------------",
    "                           |      調査の回",
    "                           |   1    2   Total",
    "---------------------------+-----------------",
    "Région de résidence        |",
    "  北部地域                 |   6    7      13",
    "  Région économique du sud |   7    7      14",
    "  東京都と周辺の地域です   |   7    6      13",
    "  Total                    |  20   20      40",
    "---------------------------------------------",
  ]);
});

test("frequency weights in the billions from a file are added up, not repeated", () => {
  const s = session("unicode.dta");
  s.run("use unicode.dta, clear");
  assert.deepEqual(printed(s, "tabulate region [fweight=wt]"), [
    "     Région de résidence |      Freq.     Percent        Cum.",
    "-------------------------+-----------------------------------",
    "                北部地域 |33752207068       38.17       38.17",
    "Région économique du sud |31622178715       35.76       73.93",
    "  東京都と周辺の地域です |23052543973       26.07      100.00",
    "-------------------------+-----------------------------------",
    "                   Total |88426929756      100.00",
  ]);
  // summarize() takes frequency weights only up to a long integer.
  const result = s.run("tabulate region [fweight=wt], summarize(income)");
  assert.equal(result.rc, 401);
  assert.match(
    result.output.at(-1).lines.join("\n"),
    /may not use noninteger frequency weights/,
  );
});

test("tabulate's summarize() chooses its columns and keeps the variable's format", () => {
  const s = session("weights.dta");
  s.run("use weights.dta, clear");
  assert.deepEqual(printed(s, "tabulate region, summarize(income) means obs"), [
    "            |    Summary of Annual",
    "     Census |         income",
    "     region |        Mean         Obs",
    "------------+------------------------",
    "      North |   42,269.10          29",
    "      South |   39,764.65          24",
    "  Less than |   41,122.22          27",
    "------------+------------------------",
    "      Total |   41,130.69          80",
  ]);
  assert.deepEqual(
    printed(s, "tabulate region [aweight=wt], summarize(income)"),
    [
      "     Census |            Summary of Annual income",
      "     region |        Mean   Std. dev.       Freq.         Obs",
      "------------+------------------------------------------------",
      "      North |   42,559.45   11,983.56          54          29",
      "      South |   38,949.24   13,339.78          39          24",
      "  Less than |   41,780.74   11,434.68          43          27",
      "------------+------------------------------------------------",
      "      Total |   41,283.02   12,160.17         135          80",
    ],
  );
});

// Two files saved in the session from simulated data; recorded from Stata 19
// running the same commands.
test("merge keepusing() leaves the variables it drops missing in using-only observations", () => {
  const s = createConsoleSession();
  for (const step of [
    "clear",
    "set obs 4",
    "gen id = _n",
    "gen y = _n",
    'gen str3 nm = "m"',
    "save kA, replace",
    "clear",
    "set obs 4",
    "gen id = _n + 2",
    "gen y = 100 + _n",
    'gen str3 nm = "u"',
    "gen z = 7",
    "save kB, replace",
    "use kA, clear",
    "quietly merge 1:1 id using kB, keepusing(z) gen(how)",
  ])
    assert.equal(s.run(step).rc, 0, step);
  assert.deepEqual(printed(s, "list, sep(0)"), [
    "     +-----------------------------------+",
    "     | id   y   nm   z               how |",
    "     |-----------------------------------|",
    "  1. |  1   1    m   .   Master only (1) |",
    "  2. |  2   2    m   .   Master only (1) |",
    "  3. |  3   3    m   7       Matched (3) |",
    "  4. |  4   4    m   7       Matched (3) |",
    "  5. |  5   .        7    Using only (2) |",
    "  6. |  6   .        7    Using only (2) |",
    "     +-----------------------------------+",
  ]);
  assert.deepEqual(printed(s, "tabulate how, summarize(y)"), [
    "   Matching |",
    "result from |            Summary of y",
    "      merge |        Mean   Std. dev.       Freq.",
    "------------+------------------------------------",
    "  Master on |         1.5   .70710678           2",
    "  Matched ( |         3.5   .70710678           2",
    "------------+------------------------------------",
    "      Total |         2.5   1.2909944           4",
  ]);
});
