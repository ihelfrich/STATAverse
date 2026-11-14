// Graphs from the sixth red-team round (13 November 2026): by() panels on
// one scale, labelled only at the outer edges, and by()'s other
// suboptions; histogram with by(); the axis titles of overlays; line and
// area in the order of the data; twoway bar and area from their base;
// the notes of kdensity, lowess and graph box; a histogram of one value;
// scatter y x || lfit y x; label rules a(b)c; function's range(); and
// options and weights Stata accepts but this page does not draw.
//
// Every expected value was recorded from Stata 19 MP (version 17, set
// processors 1). The data are built here as they were built there, from
// runiform(), which this page draws as Stata does. Stata's graphs were
// exported with graph export … .svg: the texts below are the <text>
// elements of each, sorted, and the places of bars, lines and grids were
// read from its coordinates. The printed lines (bin notes and refusals)
// are compared in tools/output-cases.txt (case graph-redteam6).
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

const STUDENTS = `clear
set seed 4242
set obs 60
gen id = _n
gen t = _n
gen school = 1 + mod(_n, 3)
label define sl 1 "Lincoln" 2 "Washington" 3 "Jefferson High"
label values school sl
gen female = runiform() < .5
gen hours = round(1 + runiform()*9, .5)
gen score = round(45 + 5*hours + 8*(runiform()-.5), .1)
replace score = 35.8 in 1
gen pass = score > 70
gen gpa = round(2 + 2*runiform(), .01)
gen grade = 9 + floor(4*runiform())
gen year = 2014 + floor((_n-1)/5)
gen month = 1 + mod(_n*7, 12)
label variable score "Test score"
label variable hours "Study hours per week"
label variable gpa "Grade point average"`;
const SALES = `clear
set seed 99
set obs 24
gen year = 1999 + _n
gen sales = round(95.2 + 5.3*_n + 6*runiform(), .1)
replace sales = 95.2 in 1
gen cost = round(56.7 + 3.4*_n + 4*runiform(), .1)
gen ch = round(10*(runiform()-.45), .1)
gen neg = -sales
gen x5 = _n in 1/5
replace x5 = 6 - _n in 6/10
gen y5 = mod(_n*7, 11)
label variable sales "Annual sales"`;
const SETUPS = {
  students: STUDENTS,
  sales: SALES,
  titles: `${STUDENTS}
gen score2 = score
label variable score2 "Test score"`,
  groups: `${STUDENTS}
replace school = . in 1/4
replace hours = hours + 4 if school==2
replace score = score/2 if school==3
replace id = mod(id, 7)`,
  constant: `${STUDENTS}
gen c = 5`,
  // The data of the case graph-redteam6 in tools/output-cases.txt.
  small: `clear
input byte g double x double y double c byte w
0 1 50.5 5 1
0 2 55 5 2
0 3 61 5 1
0 4 58 5 3
0 5 70 5 1
0 6 72.5 5 2
1 1 35.8 5 1
1 2 47 5 1
1 3 52 5 2
1 4 66 5 1
1 5 69 5 1
1 6 92.3 5 2
. 7 80 5 1
end`,
};

// [setup, command, Stata's texts sorted and joined by |]
const STATA = {
  students: [
    [
      "scatter score hours, by(pass)",
      "0|0|0|1|10|10|100|40|5|5|60|80|Graphs by pass|Study hours per week|Test score",
    ],
    [
      "scatter score hours, by(school)",
      "0|0|10|10|100|100|40|40|5|5|60|60|80|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "histogram score, by(female)",
      ".05|0|0|1|100|100|40|40|60|60|80|80|Density|Graphs by female|Test score",
    ],
    [
      "histogram score, by(female) bin(5)",
      ".01|.02|.03|.04|0|0|1|100|100|20|20|40|40|60|60|80|80|Density|Graphs by female|Test score",
    ],
    [
      "histogram score, by(female) start(30) width(10)",
      ".01|.02|.03|.04|0|0|1|100|100|20|20|40|40|60|60|80|80|Density|Graphs by female|Test score",
    ],
    [
      "histogram grade, discrete by(female)",
      ".1|.2|.3|0|0|1|10|10|12|12|8|8|Density|Graphs by female|grade",
    ],
    [
      "twoway (scatter score hours if female==0) (scatter score hours if female==1)",
      "0|10|2|4|40|50|6|60|70|8|80|90|Study hours per week|Test score|Test score|Test score",
    ],
    [
      "twoway (scatter score hours) (scatter score gpa)",
      "0|10|2|4|40|50|6|60|70|8|80|90|Test score|Test score|Test score",
    ],
    [
      "twoway (line score t) (line score id)",
      "0|20|40|40|50|60|60|70|80|90|Test score|Test score|Test score",
    ],
    [
      "twoway (scatter score hours) (function y=50+4*x, range(2 10))",
      "0|10|2|4|40|50|6|60|70|8|80|90|Test score|y",
    ],
    [
      "twoway (histogram score) (kdensity score)",
      ".01|.02|.03|.04|0|40|50|60|70|80|90|Density|kdensity score",
    ],
    [
      "line score hours in 1/5",
      "0|2|4|40|50|6|60|70|8|80|Study hours per week|Test score",
    ],
    [
      "kdensity score",
      ".005|.01|.015|.02|.025|0|100|20|40|60|80|Density|Kernel density estimate|Test score|kernel = epanechnikov, bandwidth = 5.3232",
    ],
    [
      "lowess score hours",
      "0|10|100|2|4|40|6|60|8|80|Lowess smoother|Study hours per week|Test score|bandwidth = .8",
    ],
    [
      "graph box score, over(school) nooutsides",
      "40|50|60|70|80|90|Jefferson High|Lincoln|Test score|Washington|excludes outside values",
    ],
    [
      "histogram grade if grade==9, frequency",
      "0|10|15|20|5|9|9.1|9.2|9.3|9.4|9.5|Frequency|grade",
    ],
    [
      "scatter score hours || lfit score hours",
      "0|10|2|4|40|50|6|60|70|8|80|90|Fitted values|Study hours per week|Test score",
    ],
    [
      "scatter score hours, xlabel(0(3)11)",
      "0|12|3|40|50|6|60|70|80|9|90|Study hours per week|Test score",
    ],
    [
      "scatter score hours, ylabel(30(25)120)",
      "0|10|105|130|2|30|4|55|6|8|80|Study hours per week|Test score",
    ],
    ["twoway function y=sqrt(x), range(-5 5)", "-5|.5|0|0|1|1.5|2|2.5|5|x|y"],
    [
      "scatter score hours, xlabel(0(2)5)",
      "0|2|4|40|50|60|70|80|90|Study hours per week|Test score",
    ],
    [
      "scatter score hours, xlabel(0(4)2)",
      "0|40|50|60|70|80|90|Study hours per week|Test score",
    ],
    [
      "scatter score hours, xlabel(0(4)3)",
      "0|4|40|50|60|70|80|90|Study hours per week|Test score",
    ],
    [
      "scatter score hours, xlabel(10(-3)0)",
      "1|10|4|40|50|60|7|70|80|90|Study hours per week|Test score",
    ],
    [
      "scatter score hours, xlabel(10(-3)-1)",
      "1|10|4|40|50|60|7|70|80|90|Study hours per week|Test score",
    ],
    [
      "scatter score hours, xlabel(0(3)11 20)",
      "0|12|20|3|40|50|6|60|70|80|9|90|Study hours per week|Test score",
    ],
    [
      "scatter score hours, xlabel(1 0(3)11)",
      "0|1|3|40|50|6|60|70|80|9|90|Study hours per week|Test score",
    ],
    [
      "scatter score hours, xlabel(0(3)10.6)",
      "0|12|3|40|50|6|60|70|80|9|90|Study hours per week|Test score",
    ],
    [
      "scatter score hours, xlabel(0(3)10.4)",
      "0|3|40|50|6|60|70|80|9|90|Study hours per week|Test score",
    ],
    [
      "scatter score hours, xlabel(0(.3)1.1)",
      ".3|.6|.9|0|1.2|40|50|60|70|80|90|Study hours per week|Test score",
    ],
    [
      "scatter score hours, xlabel(0(3)11, grid)",
      "0|12|3|40|50|6|60|70|80|9|90|Study hours per week|Test score",
    ],
    [
      "scatter score hours, xlabel(0[3]11)",
      "0|3|40|50|6|60|70|80|9|90|Study hours per week|Test score",
    ],
    [
      "twoway lfitci score hours",
      "0|10|100|2|4|50|6|60|70|8|80|90|95% CI|Fitted values|Study hours per week",
    ],
    [
      "twoway qfitci score hours",
      "0|10|100|2|4|40|6|60|8|80|95% CI|Fitted values|Study hours per week",
    ],
    [
      "twoway (lfitci score hours) (lfit score hours)",
      "0|10|100|2|4|50|6|60|70|8|80|90|95% CI|Fitted values|Fitted values|Study hours per week",
    ],
    [
      "twoway kdensity score",
      ".005|.01|.015|.02|.025|0|40|50|60|70|80|90|kdensity score|x",
    ],
    [
      "twoway (scatter score hours) (scatter score hours), by(female)",
      "0|0|0|1|10|10|100|40|5|5|60|80|Graphs by female|Study hours per week|Test score|Test score|Test score",
    ],
    [
      "twoway (scatter score hours) (scatter gpa hours), by(female)",
      "0|0|0|0|1|10|10|100|5|5|50|Grade point average|Graphs by female|Study hours per week|Test score",
    ],
    [
      "twoway histogram score",
      ".01|.02|.03|.04|0|40|50|60|70|80|90|Density|Test score",
    ],
    [
      'twoway (scatter score hours) (scatter score hours, sort), xtitle("")',
      "0|10|2|4|40|50|6|60|70|8|80|90|Test score|Test score|Test score",
    ],
    [
      "twoway (function y=x^2) (function z=x^3), legend(on)",
      ".2|.2|.4|.4|.6|.6|.8|.8|0|0|1|1|x|y|z",
    ],
    [
      "twoway (scatter score hours) (function y=50+4*x, range(2 10)), legend(order(2))",
      "0|10|2|4|40|50|6|60|70|8|80|90|y",
    ],
  ],
  titles: [
    [
      "twoway (kdensity score) (kdensity score2)",
      ".005|.01|.015|.02|.025|0|40|50|60|70|80|90|kdensity score|kdensity score2|x",
    ],
  ],
  sales: [
    [
      "twoway bar sales year",
      "100|150|200|2000|2005|2010|2015|2020|2025|250|Annual sales|year",
    ],
    [
      "twoway area sales year",
      "100|150|200|2000|2005|2010|2015|2020|2025|250|Annual sales|year",
    ],
    [
      "twoway (bar sales year) (line cost year)",
      "100|150|200|2000|2005|2010|2015|2020|2025|250|50|Annual sales|cost|year",
    ],
    [
      "twoway bar sales year, base(0)",
      "100|150|200|2000|2005|2010|2015|2020|2025|250|Annual sales|year",
    ],
    [
      "twoway area sales year, base(50)",
      "100|150|200|2000|2005|2010|2015|2020|2025|250|Annual sales|year",
    ],
    ["twoway bar ch year", "-5|0|2000|2005|2010|2015|2020|2025|5|ch|year"],
    [
      "twoway bar neg year",
      "-100|-150|-200|-250|2000|2005|2010|2015|2020|2025|neg|year",
    ],
    [
      "twoway bar sales year, base(120)",
      "100|150|200|2000|2005|2010|2015|2020|2025|250|Annual sales|year",
    ],
    [
      "twoway bar ch year, base(2)",
      "-5|0|2000|2005|2010|2015|2020|2025|5|ch|year",
    ],
    ["twoway bar sales year in 1/1", "1999|2001|94.2|96.2|Annual sales|year"],
    ["twoway area sales year in 1/1", "1999|2001|94.2|96.2|Annual sales|year"],
    [
      "twoway bar sales year if mod(year,3)==0",
      "120|140|160|180|200|2000|2005|2010|2015|2020|220|Annual sales|year",
    ],
  ],
  groups: [
    [
      "scatter score hours, by(school, yrescale)",
      "0|0|10|10|15|15|25|30|35|40|45|5|5|50|50|60|60|70|70|80|80|90|90|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "scatter score hours, by(school, xrescale)",
      "0|10|10|10|100|100|12|14|2|20|20|4|40|40|5|6|6|60|60|8|8|80|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "scatter score hours, by(school, ixaxes)",
      "0|0|0|10|10|10|100|100|15|15|15|20|20|40|40|5|5|5|60|60|80|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "scatter score hours, by(school, iyaxes)",
      "0|0|10|10|100|100|100|15|15|20|20|20|40|40|40|5|5|60|60|60|80|80|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "scatter score hours, by(school, noedgelabel)",
      "0|10|100|100|15|20|20|40|40|5|60|60|80|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "scatter score hours, by(school, colfirst)",
      "0|0|10|10|100|100|15|15|20|20|40|40|5|5|60|60|80|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "scatter score hours, by(school, holes(2))",
      "0|0|10|10|100|100|15|15|20|20|40|40|5|5|60|60|80|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "scatter score hours, by(school, missing)",
      "(missing)|0|0|10|10|100|100|15|15|20|20|40|40|5|5|60|60|80|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "scatter score hours, by(school, total)",
      "0|0|10|10|100|100|15|15|20|20|40|40|5|5|60|60|80|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Total|Washington",
    ],
    [
      "scatter score hours, by(school, rows(1))",
      "0|0|0|10|10|10|100|15|15|15|20|40|5|5|5|60|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "scatter score hours, by(school, cols(1))",
      "0|10|100|100|100|15|20|20|20|40|40|40|5|60|60|60|80|80|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "scatter score hours, by(school, holes(1 3) cols(3))",
      "0|0|10|10|100|100|15|15|20|20|40|40|5|5|60|60|80|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "scatter score hours, by(school, rescale)",
      "0|10|10|10|12|14|2|25|30|35|4|40|45|5|50|50|6|6|60|60|70|70|8|8|80|80|90|90|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "scatter score hours, by(school, colfirst holes(3))",
      "0|0|10|10|100|100|15|15|20|20|40|40|5|5|60|60|80|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "scatter score hours, by(id)",
      "0|0|0|0|1|10|10|10|100|100|100|15|15|15|2|20|20|20|3|4|40|40|40|5|5|5|5|6|60|60|60|80|80|80|Graphs by id|Study hours per week|Test score",
    ],
    [
      "scatter score hours, by(school, noixaxes)",
      "0|0|10|10|100|100|15|15|20|20|40|40|5|5|60|60|80|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Washington",
    ],
    [
      "scatter score hours, by(school, total colfirst)",
      "0|0|10|10|100|100|15|15|20|20|40|40|5|5|60|60|80|80|Graphs by school|Jefferson High|Lincoln|Study hours per week|Test score|Total|Washington",
    ],
  ],
  constant: [
    [
      "histogram score [fw=grade]",
      ".02|.04|.06|0|40|50|60|70|80|90|Density|Test score",
    ],
    [
      "histogram score [fw=grade], discrete frequency",
      "0|10|20|30|40|50|60|70|80|90|Frequency|Test score",
    ],
    [
      "histogram score [fw=grade], by(female) frequency",
      "0|0|1|100|100|20|40|40|40|60|60|60|80|80|80|Frequency|Graphs by female|Test score",
    ],
    [
      "scatter score hours || lfit score hours ||, by(female)",
      "0|0|0|1|10|10|100|40|5|5|60|80|Fitted values|Graphs by female|Study hours per week|Test score",
    ],
    [
      "line score t || scatter score t",
      "0|20|40|40|50|60|60|70|80|90|Test score|Test score|Test score|t",
    ],
    ["histogram c", ".2|.4|.6|.8|0|1|5|5.1|5.2|5.3|5.4|5.5|Density|c"],
    ["histogram c, bin(4)", ".2|.4|.6|.8|0|1|5|5.1|5.2|5.3|5.4|5.5|Density|c"],
    ["histogram c, width(2)", ".1|.2|.3|.4|.5|0|5|5.2|5.4|5.6|5.8|6|Density|c"],
    ["histogram c, start(3)", ".2|.4|.6|.8|0|1|3|3.5|4|4.5|Density|c"],
    [
      'graph box score, over(school) nooutsides note("")',
      "40|50|60|70|80|90|Jefferson High|Lincoln|Test score|Washington",
    ],
    [
      'graph box score, over(school) nooutsides note("mine")',
      "40|50|60|70|80|90|Jefferson High|Lincoln|Test score|Washington|mine",
    ],
    [
      'kdensity score, note("")',
      ".005|.01|.015|.02|.025|0|100|20|40|60|80|Density|Kernel density estimate|Test score",
    ],
    [
      "kdensity score, bwidth(0.00001)",
      "0|100|200|300|40|400|50|500|60|70|80|90|Density|Kernel density estimate|Test score|kernel = epanechnikov, bandwidth =  1.000e-05",
    ],
    [
      "lowess score hours, mean",
      "0|10|2|4|40|50|6|60|70|8|80|90|Running mean smoother|Study hours per week|Test score|bandwidth = .8",
    ],
    [
      "lowess score hours, noweight legend(on)",
      "0|10|2|4|40|50|6|60|70|8|80|90|Lowess smoother|Study hours per week|Test score|Test score|bandwidth = .8|lowess: Test score",
    ],
    [
      "graph box score if school==1, nooutsides",
      "50|60|70|80|90|Test score|excludes outside values",
    ],
    ["twoway function exp(x), range(0 2)", ".5|0|0|1|1.5|2|2|4|6|8|x|y"],
    [
      "twoway (function y=ln(x), range(-2 3))",
      "-1|-2|-2|-4|-6|0|0|1|2|2|3|x|y",
    ],
  ],
  small: [
    ["histogram c", ".2|.4|.6|.8|0|1|5|5.1|5.2|5.3|5.4|5.5|Density|c"],
    ["histogram c, frequency", "0|10|15|5|5|5.1|5.2|5.3|5.4|5.5|Frequency|c"],
    ["histogram y [fw=w]", ".01|.02|.03|.04|0|40|50|60|70|80|90|Density|y"],
    [
      "histogram y [fw=w], discrete",
      ".05|.1|.15|0|40|50|60|70|80|90|Density|y",
    ],
    ["histogram y, discrete", ".02|.04|.06|.08|0|40|50|60|70|80|90|Density|y"],
    [
      "histogram y, discrete frequency",
      ".2|.4|.6|.8|0|1|40|50|60|70|80|90|Frequency|y",
    ],
    [
      "histogram y, by(g) start(30) width(10)",
      ".02|.04|.06|0|0|1|100|100|20|20|40|40|60|60|80|80|Density|Graphs by g|y",
    ],
    [
      "histogram y, by(g) bin(5) frequency",
      "0|0|1|1|100|100|2|20|20|3|40|40|60|60|80|80|Frequency|Graphs by g|y",
    ],
    [
      "kdensity y",
      ".005|.01|.015|.02|.025|100|20|40|60|80|Density|Kernel density estimate|kernel = epanechnikov, bandwidth = 7.1898|y",
    ],
    [
      "lowess y x",
      "0|2|4|40|50|6|60|70|8|80|90|Lowess smoother|bandwidth = .8|x|y",
    ],
    [
      "graph box y, over(g) nooutsides",
      "0|1|40|50|60|70|80|90|excludes outside values|y",
    ],
    [
      "scatter y x || lfit y x",
      "0|2|4|40|50|6|60|70|8|80|90|Fitted values|x|y",
    ],
    [
      "scatter y x || lfit y x ||, by(g)",
      "0|0|0|1|100|2|2|4|4|40|6|6|60|80|Fitted values|Graphs by g|x|y",
    ],
    ["line y x || scatter y x", "0|2|4|40|50|6|60|70|8|80|90|x|y|y|y"],
    [
      "twoway (scatter y x) (function z = 50 + 4*x, range(0 8))",
      "0|2|4|40|50|6|60|70|8|80|90|x|y|z",
    ],
    ["line y x in 1/6", "1|2|3|4|5|50|55|6|60|65|70|75|x|y"],
    ["twoway bar y x", "0|2|4|40|50|6|60|70|8|80|90|x|y"],
    ["twoway bar y x, base(0) barwidth(.5)", "0|2|4|40|50|6|60|70|8|80|90|x|y"],
    ["twoway area y x, base(40)", "0|2|4|40|50|6|60|70|8|80|90|x|y"],
    [
      "scatter y x, by(g, missing)",
      "(missing)|0|0|0|1|100|100|2|2|4|4|40|40|6|6|60|60|8|8|80|80|Graphs by g|x|y",
    ],
    [
      "scatter y x, by(g, colfirst holes(2) ixaxes iyaxes noedgelabel)",
      "0|0|0|1|100|100|2|2|4|4|40|40|6|6|60|60|80|80|Graphs by g|x|y",
    ],
    [
      "scatter y x, by(g, rescale)",
      "0|0|0|1|100|2|2|4|4|40|50|6|6|60|60|70|80|Graphs by g|x|y",
    ],
    [
      "scatter y x, by(g, xrescale yrescale noixaxes)",
      "0|0|0|1|100|2|2|4|4|40|50|6|6|60|60|70|80|Graphs by g|x|y",
    ],
    [
      "scatter y x, xlabel(0(3)11) ylabel(30(25)120)",
      "0|105|12|130|3|30|55|6|80|9|x|y",
    ],
  ],
};

function session(setup) {
  const s = createConsoleSession();
  assert.equal(s.run(setup).rc, 0);
  return s;
}
function graph(s, command) {
  const out = s.run(command);
  assert.equal(out.rc, 0, `${command}: ${JSON.stringify(out.output)}`);
  return out.output
    .map((o) => o.graph)
    .filter(Boolean)
    .at(-1).svg;
}
const texts = (svg) =>
  [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) =>
    m[1].replace(/&amp;/g, "&"),
  );
const panels = (svg) => svg.split(/(?=<svg x=)/).slice(1);
// The y of each label of an axis: { text: y } for y labels, x for x labels.
const yAt = (svg) =>
  new Map(
    [
      ...svg.matchAll(
        /<text x="[\d.]+" y="([\d.]+)" text-anchor="end">([^<]*)</g,
      ),
    ].map((m) => [m[2], Number(m[1]) - 4]),
  );
const xAt = (svg) =>
  new Map(
    [
      ...svg.matchAll(
        /<text x="([\d.]+)" y="[\d.]+" text-anchor="middle">(-?[\d.]+)</g,
      ),
    ].map((m) => [m[2], Number(m[1])]),
  );
const rects = (svg) =>
  [
    ...svg.matchAll(
      /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="#[0-9a-f]+" fill-opacity="0\.75"/g,
    ),
  ].map((m) => m.slice(1, 5).map(Number));

test("graphs carry the texts of Stata's own", () => {
  for (const [setup, cases] of Object.entries(STATA)) {
    const s = session(SETUPS[setup]);
    for (const [command, want] of cases)
      assert.equal(
        texts(graph(s, command)).sort().join("|"),
        want,
        `${setup}: ${command}`,
      );
  }
});

test("histogram's axis reaches its start only when a row is spare for it", () => {
  // Stata keeps the start of the bins after the bars' middles in a
  // variable of the dataset: with 13 rows and 13 bars there is no room,
  // and the axis runs from the first bar's middle (40 to 90); after expand
  // there is, and it runs from the start (40 to 100).
  const s = session(SETUPS.small);
  const labels = (svg) =>
    [...xAt(svg).keys()].filter((t) => Number(t) >= 30).join(" ");
  assert.equal(labels(graph(s, "histogram y, discrete")), "40 50 60 70 80 90");
  assert.equal(s.run("expand w").rc, 0);
  assert.equal(labels(graph(s, "histogram y, discrete")), "40 60 80 100");
});

test("by() panels share one scale and only the outer ones are labelled", () => {
  const s = session(STUDENTS);
  // Stata: 40 at the same height in both panels, labelled in the first.
  const svg = graph(s, "scatter score hours, by(pass)"),
    [left, right] = panels(svg),
    grid = (panel) =>
      [...panel.matchAll(/y1="([\d.]+)" y2="[\d.]+" stroke="#e6e6e6"/g)].map(
        (m) => m[1],
      );
  assert.deepEqual(grid(left), grid(right));
  assert.equal(grid(left).length, 4);
  assert.deepEqual([...yAt(left).keys()], ["40", "60", "80", "100"]);
  assert.deepEqual([...yAt(right).keys()], []);
  // The panel at the right has no y axis line of its own.
  const upright = (panel) =>
    [...panel.matchAll(/<line x1="72" x2="72"/g)].length;
  assert.equal(upright(left), 1);
  assert.equal(upright(right), 0);
  // by(school), 2 × 2: Lincoln is labelled on y only, Washington on x
  // only, Jefferson High on both.
  const [lincoln, washington, jefferson] = panels(
    graph(s, "scatter score hours, by(school)"),
  );
  assert.equal(yAt(lincoln).size, 4);
  assert.equal(xAt(lincoln).size, 0);
  assert.equal(yAt(washington).size, 0);
  assert.equal(xAt(washington).size, 3);
  assert.equal(yAt(jefferson).size, 4);
  assert.equal(xAt(jefferson).size, 3);
});

test("histogram with by() bins each panel from the whole sample's start", () => {
  const s = session(STUDENTS);
  // Stata's bars, in units of the axis: female == 0 (50.5 to 93.1) from
  // 47.26 to 104.56, its largest value alone in a sixth bin, and
  // female == 1 (35.8 to 92.3) from 35.80 to 93.10, each 11.46 wide.
  const edges = (panel) => {
    const at = xAt(panel),
      unit = (at.get("100") - at.get("20")) / 80;
    return rects(panel).map(([x, , w]) => [
      Number((20 + (x - at.get("20")) / unit).toFixed(2)),
      Number((w / unit).toFixed(2)),
    ]);
  };
  const [men, women] = panels(
    graph(s, "histogram score, by(female) bin(5)"),
  ).map(edges);
  assert.deepEqual(
    men.map(([x]) => x),
    [47.26, 58.72, 70.18, 81.64, 93.1],
  );
  assert.deepEqual(
    women.map(([x]) => x),
    [35.8, 47.26, 58.72, 70.18, 81.64],
  );
  for (const [, width] of [...men, ...women]) assert.equal(width, 11.46);
  // start() is kept with by(): the bins start at 30, 10 wide.
  const [first] = panels(
    graph(s, "histogram score, by(female) start(30) width(10)"),
  ).map(edges);
  assert.deepEqual(
    first.map(([x]) => x),
    [50, 60, 70, 80, 90],
  );
});

test("line, connected and area join the points in the order of the data", () => {
  const s = session(SALES);
  // x5 is 1 2 3 4 5 0 -1 -2 -3 -4: Stata's path runs right, then back left.
  for (const command of [
    "twoway connected y5 x5 in 1/10",
    "line y5 x5 in 1/10",
  ]) {
    const svg = graph(s, command),
      at = xAt(svg),
      unit = (at.get("6") - at.get("-4")) / 10,
      xs = /<polyline[^>]*points="([^"]*)"/
        .exec(svg)[1]
        .split(" ")
        .map((p) =>
          Math.round(-4 + (Number(p.split(",")[0]) - at.get("-4")) / unit),
        );
    assert.deepEqual(xs, [1, 2, 3, 4, 5, 0, -1, -2, -3, -4], command);
  }
  const sorted = graph(s, "line y5 x5 in 1/10, sort"),
    points = /<polyline[^>]*points="([^"]*)"/.exec(sorted)[1].split(" ");
  const xs = points.map((p) => Number(p.split(",")[0]));
  assert.deepEqual(
    xs,
    [...xs].sort((a, b) => a - b),
  );
  const area = /<polygon[^>]*points="([^"]*)"/
    .exec(graph(s, "twoway area y5 x5 in 1/10"))[1]
    .split(" ")
    .map((p) => Number(p.split(",")[0]));
  // From the base under the first point, through the points in order.
  assert.ok(area[1] < area[2] && area[5] > area[6]);
});

test("twoway bar is a unit wide and rises from its base", () => {
  const s = session(SALES);
  const check = (command, from) => {
    const svg = graph(s, command),
      x = xAt(svg),
      y = yAt(svg),
      [lo, hi] = [...y.keys()]
        .map(Number)
        .filter((v, k, a) => k === 0 || k === a.length - 1),
      xUnit = (x.get("2025") - x.get("2000")) / 25,
      yUnit = (y.get(String(lo)) - y.get(String(hi))) / (hi - lo),
      bars = rects(svg);
    for (const [, top, width, height] of bars) {
      // Stata: each bar 1 year wide, touching the next.
      assert.ok(Math.abs(width - xUnit) < 0.02, `${command}: width ${width}`);
      // The end of the bar nearer the base sits on the base.
      const ends = [top, top + height].map(
        (py) => lo + (y.get(String(lo)) - py) / yUnit,
      );
      assert.ok(
        ends.some((v) => Math.abs(v - from) < 0.05),
        `${command}: ${ends} from ${from}`,
      );
    }
    return bars;
  };
  // Stata: the bars of sales (95.2 to 222) rise from 95.2, the bottom of
  // the axis, not from 0; those of ch from 0; those of neg hang from
  // -95.2, the top; base(120) from 120 and base(2) from 2.
  check("twoway bar sales year", 95.2);
  check("twoway bar ch year", 0);
  check("twoway bar neg year", -95.2);
  check("twoway bar sales year, base(120)", 120);
  check("twoway bar ch year, base(2)", 2);
});

test("options and weights Stata draws differently are refused by name", () => {
  const s = session(`${STUDENTS}\ngen c = 5`);
  for (const [command, message] of [
    [
      "graph box score, over(school) box(1, color(orange))",
      /option box\(\) is not drawn/,
    ],
    [
      "twoway qfitci score hours, ciplot(rline)",
      /option ciplot\(\) is not drawn/,
    ],
    ["histogram score, horizontal", /option horizontal is not drawn/],
    [
      "graph box score, over(school) medtype(line)",
      /option medtype\(\) is not drawn/,
    ],
    [
      "histogram score, normal normopts(lcolor(red))",
      /option normopts\(\) is not drawn/,
    ],
    ["graph bar (asis) score in 1/5, over(id)", /\(asis\) is not drawn/],
    ["scatter score hours [aw=gpa]", /scatter with \[aweight\] is not drawn/],
    ["scatter score hours [fw=grade]", /scatter with \[fweight\] is not drawn/],
    [
      "scatter score hours, by(school, compact)",
      /by\(…, compact\) is not drawn/,
    ],
  ]) {
    const out = s.run(command);
    assert.equal(out.rc, 198, command);
    assert.match(out.output.at(-1).lines.join("\n"), message, command);
  }
  // kdensity has no by(): Stata's r(191), with nograph too.
  for (const command of [
    "kdensity score, by(female)",
    "kdensity score, by(female) nograph",
  ]) {
    const out = s.run(command);
    assert.equal(out.rc, 191, command);
    assert.deepEqual(out.output.at(-1).lines, [
      "option by() not allowed",
      "r(191);",
    ]);
  }
  // base() and barwidth() belong to bar and area, as in Stata.
  assert.equal(s.run("twoway scatter score hours, base(3)").rc, 198);
  assert.equal(s.run("twoway line score hours, barwidth(2)").rc, 198);
});
