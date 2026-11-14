// Graphs from the final red-team round (13 November 2026), as Stata 19 MP
// draws them (version 17, set processors 1): twoway bar labelled over the
// rows whose y is missing; overlaid histograms, whose keys look alike, with
// no legend; the axis titles of the first and last plot; twoway histogram
// with by() labelled over its bars' edges; natscale's ties with about four
// labels; by(…, missing) titling .a; holes() refused as Stata refuses it;
// kdensity, twoway kdensity, histogram and the fits with weights; gap(),
// cmissing(), sort(varlist) and student(); lowess's bwidth() outside (0,1)
// and with fewer than three points; kdensity of a constant; and xlabel()
// rules that run down.
//
// Every expected text was recorded from Stata 19 MP. The data are built
// here as they were built there, from runiform(), which this page draws as
// Stata does. Stata's graphs were exported with graph export … .svg: the
// texts below are the <text> elements of each, sorted. The printed lines
// (notes, refusals, values) are compared in tools/output-cases.txt (cases
// graph-redteam6-weights and graph-redteam6-axes).
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";
import { ticks } from "../src/runtime/graphics.js";
import { polynomialFit } from "../src/runtime/smoothers.js";
import { invttail } from "../src/runtime/distributions.js";

const SETUPS = {
  h: 'clear\nset seed 2718\nset obs 90\ngen id = _n\ngen region = 1 + mod(_n, 5)\nlabel define rl 1 "North" 2 "South" 3 "East" 4 "West" 5 "Central"\nlabel values region rl\ngen sex = cond(runiform() < .5, "M", "F")\ngen income = round(1000 + 20000*runiform()^2, 1)\nreplace income = income*10 if region == 3\ngen age = 18 + floor(50*runiform())\ngen wt = round(50 + 40*runiform(), .1)\nreplace wt = . in 5/7\ngen yr = 1990 + mod(_n, 30)\ngen c3 = 7\ngen treat = _n > 45\nlabel variable income "Household income"\nlabel variable age "Age (years)"\ngen grp = mod(_n, 4)\nreplace grp = . if mod(_n, 9) == 0\nreplace grp = .a in 2\ngen str8 city = cond(mod(_n,3)==0, "", cond(mod(_n,3)==1, "Rome", "Oslo"))\ngen neg = wt - 70\ngen big = income * 1000\ngen tiny = wt / 100000',
  i: "clear\nset seed 31337\nset obs 137\ngen g = cond(_n <= 15, 1, cond(_n <= 70, 2, 3))\ngen h = mod(_n, 2)\ngen v1 = round(100*runiform(), .1)\ngen v2 = round(runiform()^3 * 50, .01)\ngen v3 = round(1000 + 500*runiform() + 500*runiform(), 1)\ngen v4 = floor(6*runiform())\ngen v5 = round(-20 + 15*runiform(), .5)\ngen v6 = runiform()/1000\ngen v7 = floor(3*runiform()) + 10*g\ngen v8 = round(exp(5*runiform()), .1)",
  n: 'clear\nset seed 777\nset obs 40\ngen id = _n\ngen grp = 1 + mod(_n, 4)\nlabel define gl 1 "A & B" 2 "<low>" 3 `"say "hi""\' 4 "ok"\nlabel values grp gl\ngen x = round(10*runiform(), .1)\ngen y = round(5 + 3*x + 4*runiform(), .1)\nreplace y = . if grp == 4\ngen one = 1\ngen lone = grp\nreplace lone = 9 in 1\ngen str10 s = cond(grp==1, "x<y", "a&b")\ngen yy = y\nreplace yy = 1000 in 2',
  u: "clear\ninput g v w\n0 3 1\n0 47 2\n0 20 1\n1 5 1\n1 45 1\n1 25 3\n1 30 1\nend",
};

// [setup, [command, Stata's texts sorted and joined by | (null: run only)]]
const STATA = [
  [
    "h",
    [
      ["twoway bar wt id in 1/7", "0|2|4|6|60|65|70|75|8|80|id|wt"],
      ["twoway bar wt id in 5/12", "10|12|4|50|6|60|70|8|80|90|id|wt"],
      [
        "twoway bar wt big in 1/10",
        "0|1.00e+08|1.50e+08|2.00e+08|5.00e+07|50|60|70|80|big|wt",
      ],
      ["twoway area wt id in 5/12", "10|12|4|50|6|60|70|8|80|90|id|wt"],
      [
        "twoway (histogram age) (histogram wt)",
        ".01|.02|.03|.04|0|100|20|40|60|80|Density",
      ],
      [
        "twoway (histogram age) (histogram age)",
        ".01|.02|.03|.04|0|20|30|40|50|60|Age (years)|Density",
      ],
      [
        "twoway (histogram age, frequency) (histogram wt, frequency)",
        "0|10|100|15|20|40|5|60|80|Frequency",
      ],
      [
        'twoway (histogram age if sex=="M") (histogram age if sex=="F")',
        ".01|.02|.03|.04|0|20|30|40|50|60|Age (years)|Density",
      ],
      [
        "twoway (histogram age) (histogram wt), legend(on)",
        ".01|.02|.03|.04|0|100|20|40|60|80|Density|Density",
      ],
      [
        "twoway (histogram age) (histogram wt, color(red))",
        ".01|.02|.03|.04|0|100|20|40|60|80|Density|Density|Density",
      ],
      [
        "twoway histogram age, by(treat)",
        ".01|.02|.03|.04|0|0|1|20|20|40|40|60|60|80|80|Age (years)|Density|Graphs by treat",
      ],
      [
        "twoway histogram age, by(sex)",
        ".01|.02|.03|.04|0|20|20|40|40|60|60|80|80|Age (years)|Density|F|Graphs by sex|M",
      ],
      [
        "twoway histogram age, by(treat) bin(5)",
        ".01|.02|.03|0|0|1|20|20|40|40|60|60|80|80|Age (years)|Density|Graphs by treat",
      ],
      [
        "twoway histogram age, by(treat) width(10)",
        ".01|.02|.03|0|0|1|20|20|40|40|60|60|80|80|Age (years)|Density|Graphs by treat",
      ],
      [
        "twoway histogram age, by(region)",
        ".05|.05|0|0|20|20|20|40|40|40|60|60|60|80|80|80|Age (years)|Central|Density|East|Graphs by region|North|South|West",
      ],
      [
        "histogram age, by(treat)",
        ".01|.02|.03|.04|0|0|1|20|20|40|40|60|60|80|80|Age (years)|Density|Graphs by treat",
      ],
      [
        "scatter wt age, by(grp, missing)",
        "(missing)|.a|0|1|2|20|20|20|3|40|40|40|50|50|60|60|60|60|60|70|70|80|80|80|80|80|90|90|Age (years)|Graphs by grp|wt",
      ],
      [
        "scatter wt age, by(grp, missing total)",
        "(missing)|.a|0|1|2|20|20|20|3|40|40|40|50|50|50|60|60|60|60|60|60|70|70|70|80|80|80|80|80|80|90|90|90|Age (years)|Graphs by grp|Total|wt",
      ],
      [
        "scatter wt age, by(grp, missing cols(3))",
        "(missing)|.a|0|1|2|20|20|20|3|40|40|40|50|50|60|60|60|60|60|70|70|80|80|80|80|80|90|90|Age (years)|Graphs by grp|wt",
      ],
      [
        "histogram age, by(grp, missing)",
        "(missing)|.1|.1|.2|.2|.a|0|0|0|1|2|20|20|20|3|40|40|40|60|60|60|80|80|80|Age (years)|Density|Graphs by grp",
      ],
      [
        "kdensity wt [aw=region]",
        ".01|.02|.03|.04|0|50|60|70|80|90|Density|Kernel density estimate|kernel = epanechnikov, bandwidth = 3.8530|wt",
      ],
      [
        "kdensity wt [fw=region]",
        ".01|.02|.03|.04|0|50|60|70|80|90|Density|Kernel density estimate|kernel = epanechnikov, bandwidth = 3.0739|wt",
      ],
      [
        "twoway lfit wt age [aw=region]",
        "20|30|40|50|60|67.5|68|68.5|69|69.5|70|70|Age (years)|Fitted values",
      ],
      [
        "twoway lfit wt age [pw=region]",
        "20|30|40|50|60|67.5|68|68.5|69|69.5|70|70|Age (years)|Fitted values",
      ],
      [
        "twoway qfit wt age [aw=region]",
        "20|30|40|50|60|66|68|70|70|72|74|Age (years)|Fitted values",
      ],
      [
        "twoway lfitci wt age [fw=region]",
        "20|30|40|50|60|64|66|68|70|70|72|95% CI|Age (years)|Fitted values",
      ],
      [
        "twoway (kdensity wt [aw=region])",
        ".01|.015|.02|.025|.03|.035|50|60|70|80|90|kdensity wt|x",
      ],
      [
        "twoway line wt age [aw=region]",
        "20|30|40|50|50|60|60|70|70|80|90|Age (years)|wt",
      ],
      [
        "twoway histogram wt [fw=region]",
        ".01|.02|.03|.04|0|50|60|70|80|90|Density|wt",
      ],
      [
        "histogram age, gap(20)",
        ".01|.02|.03|.04|0|20|30|40|50|60|Age (years)|Density",
      ],
      ["line wt yr, cmissing(n)", "1990|2000|2010|2020|50|60|70|80|90|wt|yr"],
      [
        "line wt income in 1/15, sort(age)",
        "0|100000|150000|200000|50|50000|60|70|80|90|Household income|wt",
      ],
      [
        "kdensity wt, student(5)",
        ".01|.02|.03|.04|0|50|60|70|80|90|Density|Kernel density estimate|Kernel density estimate|kernel = epanechnikov, bandwidth = 3.8526|t density, df = 5|wt",
      ],
      [
        "lowess wt age, bwidth(1.5)",
        "20|30|40|50|50|60|60|70|70|80|90|Age (years)|Lowess smoother|bandwidth = .8|wt",
      ],
      [
        "lowess wt age, bwidth(0)",
        "20|30|40|50|50|60|60|70|70|80|90|Age (years)|Lowess smoother|bandwidth = .8|wt",
      ],
      [
        "lowess wt age, bwidth(-.2)",
        "20|30|40|50|50|60|60|70|70|80|90|Age (years)|Lowess smoother|bandwidth = .8|wt",
      ],
      [
        "lowess wt age, bwidth(1)",
        "20|30|40|50|50|60|60|70|70|80|90|Age (years)|Lowess smoother|bandwidth = .8|wt",
      ],
      [
        "kdensity c3",
        "-1|1|6|8|Density|Kernel density estimate|c3|kernel = epanechnikov, bandwidth = 0",
      ],
      [
        "kdensity c3 if id < 5",
        "-1|1|6|8|Density|Kernel density estimate|c3|kernel = epanechnikov, bandwidth = 0",
      ],
      ["twoway kdensity c3", "-1|1|6|8|kdensity c3|x"],
      [
        "lowess wt age in 1/2",
        "35|40|45|50|55|60|60|65|70|75|80|Age (years)|Lowess smoother|bandwidth = .8|wt",
      ],
    ],
  ],
  [
    "i",
    [
      [
        "histogram v5, by(g)",
        "-10|-10|-15|-15|-20|-20|-5|-5|.1|.1|.2|.2|0|0|1|2|3|Density|Graphs by g|v5",
      ],
      [
        "histogram v5, by(g) ylabel(#4)",
        "-10|-10|-15|-15|-20|-20|-5|-5|.1|.1|.2|.2|0|0|1|2|3|Density|Graphs by g|v5",
      ],
      [
        "histogram v5 if g==1, start(-20) width(1.3636364) ylabel(#4)",
        "-10|-15|-20|-5|.1|.2|0|Density|v5",
      ],
      [
        "histogram v5, by(h) discrete",
        "-10|-10|-15|-15|-20|-20|-5|-5|.1|.2|0|0|1|Density|Graphs by h|v5",
      ],
      [
        "histogram v5, by(g) ylabel(#5)",
        "-10|-10|-15|-15|-20|-20|-5|-5|.05|.05|.1|.1|.15|.15|.2|.2|0|0|1|2|3|Density|Graphs by g|v5",
      ],
      [
        "histogram v5 if g==1, start(-20) width(1.3636364)",
        "-10|-15|-20|-5|.05|.1|.15|.2|0|Density|v5",
      ],
      ["scatter v5 v1, xlabel(10(5)0)", "-10|-15|-20|-5|0|10|5|v1|v5"],
      ["scatter v5 v1, xlabel(10(5)-1)", "-10|-15|-20|-5|0|10|5|v1|v5"],
      ["scatter v5 v1, xlabel(10(5)-3)", "-10|-15|-20|-5|0|10|5|v1|v5"],
      ["scatter v5 v1, xlabel(10(3)0)", "-10|-15|-20|-5|1|10|4|7|v1|v5"],
    ],
  ],
  [
    "i",
    [
      ["scatter v5 v1, xlabel(10(5)0)", "-10|-15|-20|-5|0|10|5|v1|v5"],
      ["scatter v5 v1, xlabel(10(3)0)", "-10|-15|-20|-5|1|10|4|7|v1|v5"],
      ["scatter v5 v1, xlabel(0(-25)100)", "-10|-15|-20|-5|v1|v5"],
      ["scatter v5 v1, xlabel(0(-30)100)", "-10|-15|-20|-5|v1|v5"],
      [
        "scatter v5 v1, ylabel(-5(5)-20)",
        "-10|-15|-20|-5|0|100|20|40|60|80|v1|v5",
      ],
      ["scatter v5 v1, xlabel(10(5)0 50)", "-10|-15|-20|-5|0|10|5|50|v1|v5"],
      ["scatter v5 v1, xlabel(100(30)0)", "-10|-15|-20|-5|10|100|40|70|v1|v5"],
      ["scatter v5 v1, xlabel(100(40)0)", "-10|-15|-20|-5|100|20|60|v1|v5"],
      [
        "scatter v5 v1, xlabel(100(30)-20)",
        "-10|-15|-20|-20|-5|10|100|40|70|v1|v5",
      ],
      ["scatter v5 v1, xlabel(50(-30)100)", "-10|-15|-20|-5|v1|v5"],
      ["scatter v5 v1, xlabel(10(5)10)", "-10|-15|-20|-5|10|v1|v5"],
    ],
  ],
  [
    "n",
    [
      [
        "histogram y, by(lone)",
        ".1|.1|.2|.2|0|0|0|0|0|1|10|10|10|2|20|20|20|3|30|30|30|4|40|40|40|9|Density|Graphs by lone|y",
      ],
    ],
  ],
  [
    "h",
    [
      [
        "twoway histogram age",
        ".01|.02|.03|.04|0|20|30|40|50|60|Age (years)|Density",
      ],
      [
        "twoway histogram age, bin(5)",
        ".005|.01|.015|.02|.025|0|20|30|40|50|60|Age (years)|Density",
      ],
      ["twoway histogram wt", ".01|.02|.03|.04|0|50|60|70|80|90|Density|wt"],
      [
        "twoway histogram income",
        "0|0|1.0e-05|100000|150000|2.0e-05|200000|3.0e-05|4.0e-05|50000|Density|Household income",
      ],
      [
        "twoway histogram age, width(7)",
        ".01|.02|.03|0|20|30|40|50|60|Age (years)|Density",
      ],
      [
        "twoway histogram age if treat==0",
        ".01|.02|.03|.04|0|20|30|40|50|60|Age (years)|Density",
      ],
      [
        "twoway histogram age, by(treat) start(10)",
        ".01|.02|.03|0|0|0|0|1|20|20|40|40|60|60|Age (years)|Density|Graphs by treat",
      ],
      [
        "twoway histogram age, by(treat) discrete",
        ".05|.1|0|0|1|20|20|40|40|60|60|80|80|Age (years)|Density|Graphs by treat",
      ],
      [
        "twoway (histogram age) (scatter wt age), by(treat)",
        "0|0|1|100|20|20|40|40|50|60|60|80|80|Age (years)|Density|Graphs by treat|wt",
      ],
      [
        "twoway histogram age, by(treat) frequency",
        "0|0|1|10|15|20|20|40|40|5|60|60|80|80|Age (years)|Frequency|Graphs by treat",
      ],
    ],
  ],
  [
    "u",
    [
      [
        "twoway histogram v, bin(2)",
        ".005|.01|.015|.02|.025|0|15|20|25|30|35|Density|v",
      ],
      [
        "twoway histogram v, by(g) bin(2)",
        ".01|.02|.03|.04|0|0|0|0|1|50|50|Density|Graphs by g|v",
      ],
      [
        "twoway histogram v, by(g) bin(2) start(0)",
        "-20|-20|.01|.02|.03|0|0|0|0|1|20|20|40|40|Density|Graphs by g|v",
      ],
      [
        "twoway histogram v if g==0, bin(2)",
        ".01|.02|.03|0|15|20|25|30|35|Density|v",
      ],
      [
        "twoway histogram v, by(g) bin(3)",
        ".01|.02|.03|.04|0|0|0|0|1|50|50|Density|Graphs by g|v",
      ],
      [
        "twoway histogram v, by(g) width(15)",
        ".01|.02|.03|0|0|0|0|1|50|50|Density|Graphs by g|v",
      ],
      [
        "twoway histogram v, by(g) discrete",
        ".02|.04|.06|0|0|0|0|1|20|20|40|40|60|60|Density|Graphs by g|v",
      ],
      [
        "twoway histogram v, by(g) bin(2) start(2)",
        "-20|-20|.01|.02|.03|.04|0|0|0|0|1|20|20|40|40|Density|Graphs by g|v",
      ],
      [
        "histogram v, by(g) bin(2)",
        ".01|.02|.03|0|0|0|0|1|20|20|40|40|60|60|Density|Graphs by g|v",
      ],
    ],
  ],
  [
    "h",
    [
      [
        "lowess wt age if id<0",
        "Age (years)|Lowess smoother|bandwidth = .8|wt",
      ],
      [
        "lowess wt c3",
        "50|6|60|70|8|80|90|Lowess smoother|bandwidth = .8|c3|wt",
      ],
      [
        "lowess wt age in 8/8",
        "65|67|80.8|82.8|Age (years)|Lowess smoother|bandwidth = .8|wt",
      ],
      [
        "lowess wt age in 1/3",
        "35|40|45|50|55|60|60|65|70|75|80|Age (years)|Lowess smoother|bandwidth = .8|wt",
      ],
      [
        "lowess wt age, bwidth(.999)",
        "20|30|40|50|50|60|60|70|70|80|90|Age (years)|Lowess smoother|bandwidth = .999|wt",
      ],
      [
        "histogram age, gap(99.5)",
        ".01|.02|.03|.04|0|20|30|40|50|60|Age (years)|Density",
      ],
      [
        "twoway histogram age, gap(20)",
        ".01|.02|.03|.04|0|20|30|40|50|60|Age (years)|Density",
      ],
      [
        "histogram age, by(treat) gap(50)",
        ".01|.02|.03|.04|0|0|1|20|20|40|40|60|60|80|80|Age (years)|Density|Graphs by treat",
      ],
      [
        "line wt neg yr, cmissing(y n)",
        "-50|0|100|1990|2000|2010|2020|50|neg|wt|yr",
      ],
      [
        "line wt yr, cmissing(n) sort",
        "1990|2000|2010|2020|50|60|70|80|90|wt|yr",
      ],
      [
        "twoway lfit wt yr, cmissing(n)",
        "1990|2000|2010|2020|68|68.5|69|69.5|70|70.5|Fitted values|yr",
      ],
      [
        "scatter wt yr, cmissing(n)",
        "1990|2000|2010|2020|50|60|70|80|90|wt|yr",
      ],
      [
        "line wt income in 1/15, sort(age id)",
        "0|100000|150000|200000|50|50000|60|70|80|90|Household income|wt",
      ],
      [
        "scatter wt income, sort(age)",
        "0|100000|150000|200000|50|50000|60|70|80|90|Household income|wt",
      ],
      [
        "line wt income, sort(city)",
        "0|100000|150000|200000|50|50000|60|70|80|90|Household income|wt",
      ],
      [
        "twoway (line wt age, sort(id)) (scatter wt age)",
        "20|30|40|50|50|60|60|70|70|80|90|Age (years)|wt|wt|wt",
      ],
      [
        "kdensity wt, student(5) normal",
        ".01|.02|.03|.04|0|50|60|70|80|90|Density|Kernel density estimate|Kernel density estimate|Normal density|kernel = epanechnikov, bandwidth = 3.8526|t density, df = 5|wt",
      ],
      [
        "kdensity wt, normal",
        ".01|.02|.03|.04|0|50|60|70|80|90|Density|Kernel density estimate|Kernel density estimate|Normal density|kernel = epanechnikov, bandwidth = 3.8526|wt",
      ],
      [
        "twoway kdensity wt [fw=region]",
        ".01|.02|.03|.04|50|60|70|80|90|kdensity wt|x",
      ],
      [
        "twoway kdensity wt [aw=income]",
        ".01|.015|.02|.025|.03|50|60|70|80|90|kdensity wt|x",
      ],
      [
        "twoway line wt age [fw=region]",
        "20|30|40|50|50|60|60|70|70|80|90|Age (years)|wt",
      ],
      [
        "twoway area wt id [pw=region]",
        "0|100|20|40|50|60|60|70|80|80|90|id|wt",
      ],
      [
        "twoway bar wt id [fw=region]",
        "0|100|20|40|50|60|60|70|80|80|90|id|wt",
      ],
      [
        "twoway lfitci wt age [pw=region]",
        "20|30|40|50|60|60|65|70|70|75|95% CI|Age (years)|Fitted values",
      ],
      [
        "twoway qfitci wt age [aw=region]",
        "20|30|40|50|60|60|65|70|70|75|80|95% CI|Age (years)|Fitted values",
      ],
      [
        "twoway qfitci wt age [pw=income]",
        "20|30|40|50|50|60|60|70|70|80|90|95% CI|Age (years)|Fitted values",
      ],
      [
        "twoway (histogram age, color(red)) (histogram wt, color(red))",
        ".01|.02|.03|.04|0|100|20|40|60|80|Density|Density|Density",
      ],
      [
        "twoway (histogram age) (histogram wt) (scatter wt age)",
        "0|100|100|20|20|40|40|60|60|80|80|Age (years)|Density|wt",
      ],
      [
        "twoway (histogram age, frequency) (histogram age)",
        "0|10|15|20|30|40|5|50|60|Age (years)",
      ],
      [
        "twoway (histogram age) (histogram wt), legend(order(1 2))",
        ".01|.02|.03|.04|0|100|20|40|60|80|Density",
      ],
      [
        'twoway (histogram age) (histogram wt), legend(label(1 "A"))',
        ".01|.02|.03|.04|0|100|20|40|60|80|Density",
      ],
      [
        "twoway (histogram age) (kdensity age) (histogram wt)",
        ".01|.02|.03|.04|0|100|20|40|60|80|Density|Density|kdensity age",
      ],
      ['label define gl .a "Refused" 1 "one"', null],
      ["label values grp gl", null],
      [
        "scatter wt age, by(grp, missing)",
        "(missing)|0|2|20|20|20|3|40|40|40|50|50|60|60|60|60|60|70|70|80|80|80|80|80|90|90|Age (years)|Graphs by grp|Refused|one|wt",
      ],
      [
        "scatter wt age, by(grp)",
        "0|2|20|20|3|40|40|50|50|60|60|60|60|70|70|80|80|80|80|90|90|Age (years)|Graphs by grp|one|wt",
      ],
    ],
  ],
  [
    "h",
    [
      [
        "twoway (scatter wt age) (scatter income age) (scatter wt age)",
        "0|100000|150000|20|200000|30|40|50|50000|60|70|Age (years)|Household income|wt|wt|wt",
      ],
      [
        "twoway (scatter wt age) (scatter wt yr) (scatter wt age)",
        "0|1000|1500|2000|50|500|60|70|80|90|Age (years)|wt|wt|wt|wt",
      ],
      [
        "twoway (scatter wt age) (scatter wt age) (scatter wt yr)",
        "0|1000|1500|2000|50|500|60|70|80|90|wt|wt|wt|wt",
      ],
      [
        "twoway (scatter wt yr) (scatter wt age) (scatter wt age)",
        "0|1000|1500|2000|50|500|60|70|80|90|wt|wt|wt|wt",
      ],
      [
        "twoway (scatter wt age) (scatter income age) (scatter income age) (scatter wt age)",
        "0|100000|150000|20|200000|30|40|50|50000|60|70|Age (years)|Household income|Household income|wt|wt|wt",
      ],
      [
        "twoway (line wt age) (scatter income age) (lfit wt age)",
        "0|100000|150000|20|200000|30|40|50|50000|60|70|Age (years)|Fitted values|Household income|wt",
      ],
      [
        "twoway (lfit wt age) (scatter wt age) (lfit wt age)",
        "20|30|40|50|50|60|60|70|70|80|90|Age (years)|Fitted values|Fitted values|Fitted values|wt",
      ],
      [
        "twoway (scatter wt age) (lfit wt age) (scatter income age)",
        "0|100000|150000|20|200000|30|40|50|50000|60|70|Age (years)|Fitted values|Household income|wt",
      ],
      [
        "twoway (histogram age) (scatter wt yr) (histogram age)",
        "0|0|100|1000|1500|20|2000|40|500|60|80|Age (years)|Density|Density|wt",
      ],
    ],
  ],
  [
    "h",
    [
      [
        "twoway (histogram wt [fw=region]), by(treat)",
        ".02|.04|.06|0|0|1|50|50|60|60|70|70|80|80|90|90|Density|Graphs by treat|wt",
      ],
      [
        "twoway histogram age, by(treat) gap(20)",
        ".01|.02|.03|.04|0|0|1|20|20|40|40|60|60|80|80|Age (years)|Density|Graphs by treat",
      ],
      [
        "twoway (histogram age) (histogram wt) (scatter wt age)",
        "0|100|100|20|20|40|40|60|60|80|80|Age (years)|Density|wt",
      ],
      [
        "twoway (histogram age, frequency) (histogram age)",
        "0|10|15|20|30|40|5|50|60|Age (years)",
      ],
      [
        "twoway (histogram age) (histogram wt), legend(order(1 2))",
        ".01|.02|.03|.04|0|100|20|40|60|80|Density",
      ],
      [
        'twoway (histogram age) (histogram wt), legend(label(1 "A"))',
        ".01|.02|.03|.04|0|100|20|40|60|80|Density",
      ],
      [
        "twoway (histogram age) (kdensity age) (histogram wt)",
        ".01|.02|.03|.04|0|100|20|40|60|80|Density|Density|kdensity age",
      ],
      [
        "twoway (scatter wt age) (scatter income age) (scatter wt age)",
        "0|100000|150000|20|200000|30|40|50|50000|60|70|Age (years)|Household income|wt|wt|wt",
      ],
      [
        "twoway (lfit wt age) (scatter wt age) (lfit wt age)",
        "20|30|40|50|50|60|60|70|70|80|90|Age (years)|Fitted values|Fitted values|Fitted values|wt",
      ],
      [
        "twoway (histogram age) (scatter wt yr) (histogram age)",
        "0|0|100|1000|1500|20|2000|40|500|60|80|Age (years)|Density|Density|wt",
      ],
      [
        "lowess wt age if id<0",
        "Age (years)|Lowess smoother|bandwidth = .8|wt",
      ],
      ["twoway kdensity c3 [fw=region]", "-1|1|6|8|kdensity c3|x"],
      [
        "kdensity wt [fw=region], normal",
        ".01|.02|.03|.04|0|50|60|70|80|90|Density|Kernel density estimate|Kernel density estimate|Normal density|kernel = epanechnikov, bandwidth = 3.0739|wt",
      ],
      [
        "twoway lfitci wt age [aw=region], by(treat)",
        "0|1|20|20|40|40|60|60|60|65|70|75|80|80|80|95% CI|Age (years)|Fitted values|Graphs by treat",
      ],
    ],
  ],
];

function graphTexts(s, command) {
  const out = s.run(command);
  assert.equal(out.rc, 0, `${command}: ${JSON.stringify(out.output)}`);
  const g = out.output
    .map((o) => o.graph)
    .filter(Boolean)
    .at(-1);
  return [...g.svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
    .map((m) =>
      m[1]
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&"),
    )
    .sort()
    .join("|");
}

test("graphs carry the texts of Stata's own", () => {
  for (const [setup, cases] of STATA) {
    const s = createConsoleSession();
    assert.equal(s.run(SETUPS[setup]).rc, 0);
    for (const [command, want] of cases) {
      if (want === null) {
        assert.equal(s.run(command).rc, 0, command);
        continue;
      }
      assert.equal(graphTexts(s, command), want, `${setup}: ${command}`);
    }
  }
});

test("natscale settles a tie of steps as Stata does", () => {
  // _natscale 0 hi 4 in Stata 19: two steps whose labels both cover the
  // data and end together cost the same; Stata takes the larger for steps
  // of .05, .1 (and 1e-4, 1e-6) and the smaller for the rest.
  for (const [hi, want] of [
    [0.1955556, [0, 0.1, 0.2]],
    [0.172, [0, 0.1, 0.2]],
    [0.356, [0, 0.2, 0.4]],
    [0.0349040143, [0, 0.01, 0.02, 0.03, 0.04]],
    [0.0172, [0, 0.005, 0.01, 0.015, 0.02]],
    [1.72, [0, 0.5, 1, 1.5, 2]],
    [3.49040143, [0, 1, 2, 3, 4]],
    [0.21, [0, 0.05, 0.1, 0.15, 0.2]],
    [0.866, [0, 0.2, 0.4, 0.6, 0.8]],
  ])
    assert.deepEqual(ticks(0, hi, 4), want, String(hi));
});

test("lfit, qfit and their intervals are regress's with weights", () => {
  // regress wt age [w=region] (and age^2), predict stdp, at ages 35, 58
  // and 52, recorded from Stata 19.
  const s = createConsoleSession();
  assert.equal(s.run(SETUPS.h).rc, 0);
  const listed = s
    .run("list wt age region if wt < ., noobs clean nolabel")
    .output.flatMap((o) => o.lines ?? [])
    .filter((line) => /^\s*[\d.]+\s+\d+\s+\d+\s*$/.test(line))
    .map((line) => line.trim().split(/\s+/).map(Number));
  const [y, x, w] = [0, 1, 2].map((k) => listed.map((r) => r[k]));
  assert.equal(x.length, 87);
  for (const [type, degree, stdp] of [
    ["aweight", 1, [1.198571, 1.64867, 1.369626]],
    ["fweight", 1, [0.6826882, 0.9390584, 0.7801187]],
    ["pweight", 1, [1.339996, 1.896373, 1.553525]],
    ["aweight", 2, [1.696024, 1.634216, 1.607879]],
    ["pweight", 2, [1.750817, 1.897663, 1.620855]],
  ]) {
    const fit = polynomialFit(x, y, degree, w, type),
      n = type === "fweight" ? 264 : 87;
    [35, 58, 52].forEach((age, k) => {
      const [, upper] = fit.band(age, 95),
        // the half-width over the t quantile of the residual df
        se = (upper - fit.predict(age)) / invttail(n - degree - 1, 0.025);
      assert.ok(
        Math.abs(se - stdp[k]) < 5e-7 * stdp[k] + 1e-7,
        `${type} ${degree} ${age}: ${se}`,
      );
    });
  }
  // regress wt age [aw=region]: _cons 71.14568, age -.0551031.
  const fit = polynomialFit(x, y, 1, w, "aweight");
  assert.ok(Math.abs(fit.predict(0) - 71.14568) < 1e-5);
  assert.ok(Math.abs(fit.predict(1) - fit.predict(0) + 0.0551031) < 1e-7);
});
test("options Stata draws differently are refused by name", () => {
  const s = createConsoleSession();
  assert.equal(s.run(SETUPS.h).rc, 0);
  for (const [command, rc, message] of [
    [
      "twoway connected wt age [fw=region]",
      198,
      /connected with \[fweight\] is not drawn/,
    ],
    [
      "twoway area wt yr, cmissing(n)",
      198,
      /area with cmissing\(n\) is not drawn/,
    ],
    ["line wt yr, cmissing(q)", 101, /cmissing\(q\) not allowed/],
    ["line wt yr, cmis(n)", 198, /option cmis\(\) not allowed/],
    ["twoway kdensity age, gap(20)", 198, /option gap\(\) not allowed/],
  ]) {
    const out = s.run(command);
    assert.equal(out.rc, rc, command);
    assert.match(out.output.at(-1).lines.join("\n"), message, command);
  }
});
