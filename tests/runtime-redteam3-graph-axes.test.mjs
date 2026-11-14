// Axes, labels, legends and graph memory, from the third red-team round of
// 13 November 2026. Every expected value was recorded from Stata 19 MP
// (version 17, set processors 1): the tick labels by exporting the same
// graphs with graph export … .svg and reading their <text> elements, and
// the tables below from _natscale and from 120 axes of graphs of random
// data drawn in Stata. The printed messages and graph dir's layout are
// compared in tools/output-cases.txt (case graph-axes).
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";
import { ticks } from "../src/runtime/graphics.js";
import { applyFormat } from "../src/runtime/format.js";

function labor() {
  const s = createConsoleSession();
  s.reset("labor");
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
function refused(s, command) {
  const out = s.run(command);
  return {
    rc: out.rc,
    text: out.output.flatMap((o) => o.lines ?? []).join("\n"),
  };
}
const texts = (svg) =>
  [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
// The labels of the y axis (set against the right) and of the x axis (the
// numbers centred below the plot) of a graph or of its first panel.
const first = (svg) => svg.split(/(?=<svg x=)/)[1] ?? svg;
const yLabels = (svg) =>
  [...first(svg).matchAll(/text-anchor="end">([^<]*)</g)].map((m) => m[1]);
const xLabels = (svg) =>
  [...first(svg).matchAll(/y="[\d.]+" text-anchor="middle">([^<]*)</g)]
    .map((m) => m[1])
    .filter((t) => /^-?[\d.,]+$/.test(t));
const count = (svg, text) => texts(svg).filter((t) => t === text).length;
const stata = (v) => applyFormat(v, "%9.0g").trim();

test("by() draws one legend for all its panels", () => {
  const s = labor();
  // Stata: Hourly wage | Fitted values once, below the panels.
  const both = graph(
    s,
    "twoway (scatter wage educ) (lfit wage educ), by(female)",
  );
  assert.equal(count(both, "Hourly wage"), 1);
  assert.equal(count(both, "Fitted values"), 1);
  // legend(off) outside by() leaves it; by(…, legend(off)) removes it.
  const off = graph(
    s,
    "twoway (scatter wage educ) (lfit wage educ), by(female) legend(off)",
  );
  assert.equal(count(off, "Fitted values"), 1);
  const inside = graph(
    s,
    "twoway (scatter wage educ) (lfit wage educ), by(female, legend(off))",
  );
  assert.equal(count(inside, "Fitted values"), 0);
  assert.equal(count(inside, "Hourly wage"), 0);
  // legend(order()) outside by() says what the one legend shows: Fit | Wage.
  const order = graph(
    s,
    'twoway (scatter wage educ) (lfit wage educ), by(female) legend(order(2 "Fit" 1 "Wage"))',
  );
  assert.equal(count(order, "Fit"), 1);
  assert.equal(count(order, "Wage"), 1);
  // Stata: rc 0; a single plot has no legend, and its y title is drawn.
  const single = graph(s, "scatter wage educ, by(female, legend(off))");
  assert.equal(count(single, "Hourly wage"), 1);
  // A legend position this page does not draw is refused, not ignored.
  assert.equal(
    refused(
      s,
      "twoway (scatter wage educ) (lfit wage educ), by(female, legend(pos(3)))",
    ).rc,
    198,
  );
});

test("ylabel(none), labelled values and grid are drawn as Stata draws them", () => {
  const s = labor();
  // Stata: no y labels; ten | twenty; x labels 10 12 16; 10 alone.
  assert.deepEqual(yLabels(graph(s, "scatter wage educ, ylabel(none)")), []);
  assert.deepEqual(
    yLabels(graph(s, 'scatter wage educ, ylabel(10 "ten" 20 "twenty")')),
    ["ten", "twenty"],
  );
  const grid = graph(s, "scatter wage educ, xlabel(10 12 16, grid)");
  assert.deepEqual(xLabels(grid), ["10", "12", "16"]);
  // A grid line up the plot at each x label, besides the y axis's own.
  assert.equal(
    (
      grid.match(
        /<line x1="([\d.]+)" x2="\1" y1="44" y2="396" stroke="#e6e6e6"/g,
      ) ?? []
    ).length,
    3,
  );
  assert.deepEqual(yLabels(graph(s, "scatter wage educ, ylabel(none 10)")), [
    "10",
  ]);
  assert.deepEqual(
    yLabels(graph(s, 'scatter wage educ, ylabel(0(10)50 25 "mid")')),
    ["0", "10", "20", "30", "40", "50", "mid"],
  );
  // Stata: invalid label specifier, :  "ten" 10:, r(198); and for #, invalid
  // tick rule,  not an integer.
  const bad = refused(s, 'scatter wage educ, ylabel("ten" 10)');
  assert.equal(bad.rc, 198);
  assert.match(bad.text, /invalid label specifier, : {2}"ten" 10:/);
  assert.equal(refused(s, "scatter wage educ, ylabel(abc)").rc, 198);
  const rule = refused(s, "scatter wage educ, ylabel(#)");
  assert.equal(rule.rc, 198);
  assert.match(rule.text, /invalid tick rule, {2}not an integer/);
});

test("xlabel(#n) and ylabel(#n) pick Stata's values", () => {
  const s = labor();
  // Stata: 4.81 | 50.77 for #0, #1 and #-1; 10 15 20 for #3.
  for (const rule of ["#0", "#1", "#-1"])
    assert.deepEqual(yLabels(graph(s, `scatter wage educ, ylabel(${rule})`)), [
      "4.81",
      "50.77",
    ]);
  assert.deepEqual(xLabels(graph(s, "scatter wage educ, xlabel(#3)")), [
    "10",
    "15",
    "20",
  ]);
  const hours = graph(s, "scatter wage hours, ylabel(#2) xlabel(#5)");
  assert.deepEqual(yLabels(hours), ["0", "100"]);
  assert.deepEqual(xLabels(hours), ["10", "20", "30", "40", "50", "60"]);
  assert.deepEqual(
    yLabels(graph(s, "graph bar wage, over(region) ylabel(#3)")),
    ["0", "10", "20"],
  );
});

test("default axis labels are Stata's, four to a by() panel", () => {
  const s = labor();
  const scatter = graph(s, "scatter wage educ");
  assert.deepEqual(yLabels(scatter), ["0", "10", "20", "30", "40", "50"]);
  assert.deepEqual(xLabels(scatter), ["5", "10", "15", "20"]);
  for (const by of ["female", "region"]) {
    const panel = graph(s, `scatter wage educ, by(${by})`);
    assert.deepEqual(yLabels(panel), ["0", "20", "40", "60"]);
    assert.deepEqual(xLabels(panel), ["5", "10", "15", "20"]);
  }
  assert.deepEqual(yLabels(graph(s, "graph bar wage, over(region)")), [
    "0",
    "5",
    "10",
    "15",
    "20",
  ]);
  const histogram = graph(s, "histogram wage");
  assert.deepEqual(xLabels(histogram), ["0", "10", "20", "30", "40", "50"]);
  assert.deepEqual(yLabels(histogram), ["0", ".02", ".04", ".06"]);
  assert.deepEqual(xLabels(graph(s, "histogram wage, by(female)")), [
    "0",
    "20",
    "40",
    "60",
  ]);
  // The value axis of graph bar and hbar is labelled in %8.0gc.
  assert.deepEqual(yLabels(graph(s, "graph bar (sum) hours, over(union)")), [
    "0",
    "5,000",
    "10,000",
    "15,000",
  ]);
  assert.deepEqual(
    texts(graph(s, "graph hbar (sum) hours, over(union)")).filter((t) =>
      /^[\d,]+$/.test(t),
    ),
    ["0", "5,000", "10,000", "15,000", "0", "1"],
  );
  // A constant is labelled one less and one more: 4 | 6.
  assert.equal(s.run("generate five = 5").rc, 0);
  assert.deepEqual(yLabels(graph(s, "scatter five educ")), ["4", "6"]);
});

// [lo, hi, n, Stata's labels]: the x and y axes of scatter y x (n = 5) and
// the x axis of scatter y x, by(g) (n = 4), drawn in Stata for 40 random
// datasets, with the range of the data Stata summarized.
const GRAPHS = [
  [0.0357320968014817, 0.103494034982715, 5, ".04 .06 .08 .1"],
  [6.40519075015421, 93.1208941116361, 5, "0 20 40 60 80 100"],
  [0.0357320968014817, 0.103494034982715, 4, ".04 .06 .08 .1"],
  [-24.2133898782277, 7.1385115228563, 5, "-30 -20 -10 0 10"],
  [4.73498338047151, 10.9208679061093, 5, "4 6 8 10 12"],
  [-24.2133898782277, 7.1385115228563, 4, "-20 -10 0 10"],
  [0.0004860771606416, 0.0007882495969097, 5, ".0005 .0006 .0007 .0008"],
  [9.57622320016884, 51.4593908589858, 5, "10 20 30 40 50"],
  [0.0004860771606416, 0.0007882495969097, 4, ".0005 .0006 .0007 .0008"],
  [144.988960574589, 905.691272008942, 5, "200 400 600 800 1000"],
  [-153.155641555189, 719.855251988558, 5, "-200 0 200 400 600 800"],
  [144.988960574589, 905.691272008942, 4, "200 400 600 800 1000"],
  [528.233563360485, 1704.24566512688, 5, "500 1000 1500 2000"],
  [-0.00267890072726053, 0.221633247287607, 5, "0 .05 .1 .15 .2"],
  [528.233563360485, 1704.24566512688, 4, "500 1000 1500 2000"],
  [1.21244362435478, 5.81265382786518, 5, "1 2 3 4 5 6"],
  [2.88546385614559, 5.02528071908116, 5, "3 3.5 4 4.5 5"],
  [1.21244362435478, 5.81265382786518, 4, "0 2 4 6"],
  [-0.0001774558102675, 0.0009755528244959, 5, "-.0005 0 .0005 .001"],
  [0.0699284529181087, 0.762370302574474, 5, "0 .2 .4 .6 .8"],
  [-0.0001774558102675, 0.0009755528244959, 4, "-.0005 0 .0005 .001"],
  [17.5366687254422, 38.397503495469, 5, "15 20 25 30 35 40"],
  [210.374817105829, 746.221357574007, 5, "200 400 600 800"],
  [17.5366687254422, 38.397503495469, 4, "20 30 40"],
  [365.646347494881, 724.461822996227, 5, "400 500 600 700 800"],
  [-0.00106672405682172, 0.0414732285459338, 5, "0 .01 .02 .03 .04"],
  [365.646347494881, 724.461822996227, 4, "400 500 600 700"],
  [0.370977795387854, 1.34140835975363, 5, ".4 .6 .8 1 1.2 1.4"],
  [0.259903522936686, 0.520432460093273, 5, ".25 .3 .35 .4 .45 .5"],
  [0.370977795387854, 1.34140835975363, 4, ".5 1 1.5"],
  [0.322213809935621, 5.0833586192899, 5, "0 1 2 3 4 5"],
  [61.3689475259488, 170.241688496661, 5, "50 100 150 200"],
  [0.322213809935621, 5.0833586192899, 4, "0 2 4 6"],
  [-0.129137642852376, 0.673870818778034, 5, "-.2 0 .2 .4 .6"],
  [0.275608844243746, 0.534021208716367, 5, ".3 .4 .5 .6"],
  [-0.129137642852376, 0.673870818778034, 4, "-.2 0 .2 .4 .6"],
  [0.117593434538815, 0.590245016568765, 5, ".1 .2 .3 .4 .5 .6"],
  [0.373060875658174, 0.746515994909811, 5, ".4 .5 .6 .7 .8"],
  [0.117593434538815, 0.590245016568765, 4, "0 .2 .4 .6"],
  [-1.80526559728368, 7.3348011146158, 5, "-2 0 2 4 6 8"],
  [49.1787525059441, 84.1357567064092, 5, "50 60 70 80 90"],
  [-1.80526559728368, 7.3348011146158, 4, "-5 0 5 10"],
  [
    0.0000199307584964,
    0.0002259963421875,
    5,
    "0 .00005 .0001 .00015 .0002 .00025",
  ],
  [0.591049218343241, 1.04916424582787, 5, ".6 .7 .8 .9 1 1.1"],
  [0.0000199307584964, 0.0002259963421875, 4, "0 .0001 .0002"],
  [0.0028427803776332, 0.0473784740421418, 5, "0 .01 .02 .03 .04 .05"],
  [0.0800639081671524, 0.113059243986534, 5, ".08 .09 .1 .11 .12"],
  [0.0028427803776332, 0.0473784740421418, 4, "0 .05"],
  [-0.0013317142094938, 0.0057240089637975, 5, "-.002 0 .002 .004 .006"],
  [55.1130747969486, 145.173325163061, 5, "60 80 100 120 140"],
  [-0.0013317142094938, 0.0057240089637975, 4, "-.002 0 .002 .004 .006"],
  [-0.0329096985581293, 1.06981274927918, 5, "0 .2 .4 .6 .8 1"],
  [0.0320188500236294, 0.0663824579152741, 5, ".03 .04 .05 .06 .07"],
  [-0.0329096985581293, 1.06981274927918, 4, "0 .5 1"],
  [15.5205296705518, 62.0048872324813, 5, "10 20 30 40 50 60"],
  [0.0314940563497711, 0.104644690938733, 5, ".02 .04 .06 .08 .1"],
  [15.5205296705518, 62.0048872324813, 4, "20 30 40 50 60"],
  [6.26019422177821, 15.4504762262069, 5, "6 8 10 12 14 16"],
  [288.423428559972, 1422.47405041645, 5, "0 500 1000 1500"],
  [6.26019422177821, 15.4504762262069, 4, "5 10 15"],
  [0.0206966645637264, 0.106265787999032, 5, ".02 .04 .06 .08 .1"],
  [0.655261919880551, 1.7289187689792, 5, ".5 1 1.5 2"],
  [0.0206966645637264, 0.106265787999032, 4, ".02 .04 .06 .08 .1"],
  [0.002572353912968, 0.0070682679778493, 5, ".003 .004 .005 .006 .007"],
  [286.013753498679, 871.40066434483, 5, "200 400 600 800 1000"],
  [0.002572353912968, 0.0070682679778493, 4, ".003 .004 .005 .006 .007"],
  [-37.8658289670236, 226.61681883168, 5, "-100 0 100 200"],
  [439.449906606024, 1305.38874978719, 5, "400 600 800 1000 1200 1400"],
  [-37.8658289670236, 226.61681883168, 4, "0 100 200 300"],
  [-0.02177498720892, 0.0368877034947483, 5, "-.02 0 .02 .04"],
  [7.82849552217495, 55.5716204431019, 5, "10 20 30 40 50 60"],
  [-0.02177498720892, 0.0368877034947483, 4, "-.02 0 .02 .04"],
  [-2.63418876093857, 6.12882678791165, 5, "-2 0 2 4 6"],
  [0.812798415552486, 1.01776437749659, 5, ".8 .85 .9 .95 1"],
  [-2.63418876093857, 6.12882678791165, 4, "-2 0 2 4 6"],
  [3.75179478301405, 15.1122368984538, 5, "5 10 15"],
  [120.895164102327, 804.123984950656, 5, "200 400 600 800"],
  [3.75179478301405, 15.1122368984538, 4, "5 10 15"],
  [48.4494159238463, 95.5855054354269, 5, "50 60 70 80 90 100"],
  [0.0635419620928512, 0.163700412132241, 5, ".06 .08 .1 .12 .14 .16"],
  [48.4494159238463, 95.5855054354269, 4, "40 60 80 100"],
  [160.891078519417, 820.762806214978, 5, "200 400 600 800"],
  [1.47657639688429, 5.84143710215798, 5, "1 2 3 4 5 6"],
  [160.891078519417, 820.762806214978, 4, "200 400 600 800"],
  [0.021518109876271, 0.0543927353750707, 5, ".02 .03 .04 .05 .06"],
  [0.787363380731559, 1.72677870555057, 5, ".8 1 1.2 1.4 1.6 1.8"],
  [0.021518109876271, 0.0543927353750707, 4, ".02 .03 .04 .05 .06"],
  [0.0559816450251001, 0.153800217418055, 5, ".06 .08 .1 .12 .14 .16"],
  [71.6116672129749, 814.291090215269, 5, "0 200 400 600 800"],
  [0.0559816450251001, 0.153800217418055, 4, ".05 .1 .15"],
  [95.9311759357397, 990.041104732994, 5, "0 200 400 600 800 1000"],
  [-0.00212134321900087, 0.112081404381123, 5, "0 .05 .1"],
  [95.9311759357397, 990.041104732994, 4, "0 500 1000"],
  [-0.112920256279586, 0.928742443314363, 5, "0 .5 1"],
  [-0.170564412642258, 0.446565714592951, 5, "-.2 0 .2 .4"],
  [-0.112920256279586, 0.928742443314363, 4, "0 .5 1"],
  [270.938952446993, 730.76470831919, 5, "300 400 500 600 700"],
  [0.0321620921539203, 0.0616094037657476, 5, ".03 .04 .05 .06"],
  [270.938952446993, 730.76470831919, 4, "200 400 600 800"],
  [0.0066036889236301, 0.018261813690088, 5, ".005 .01 .015 .02"],
  [673.760523523315, 1844.10112642999, 5, "500 1000 1500 2000"],
  [0.0066036889236301, 0.018261813690088, 4, ".005 .01 .015 .02"],
  [0.0687477731483237, 0.16748354133431, 5, ".06 .08 .1 .12 .14 .16"],
  [-1.09334108574433, 6.15985225057427, 5, "-2 0 2 4 6"],
  [0.0687477731483237, 0.16748354133431, 4, ".05 .1 .15 .2"],
  [0.665741888961519, 0.901676654601369, 5, ".65 .7 .75 .8 .85 .9"],
  [16.1075794773523, 103.600336607639, 5, "20 40 60 80 100"],
  [0.665741888961519, 0.901676654601369, 4, ".7 .8 .9"],
  [0.0027060177706955, 0.0127903318391049, 5, ".002 .004 .006 .008 .01 .012"],
  [0.0644608209026, 0.100584179105374, 5, ".06 .07 .08 .09 .1"],
  [0.0027060177706955, 0.0127903318391049, 4, "0 .005 .01 .015"],
  [0.609692767464228, 1.65299664673656, 5, ".6 .8 1 1.2 1.4 1.6"],
  [0.0219043921423096, 0.100701290721393, 5, ".02 .04 .06 .08 .1"],
  [0.609692767464228, 1.65299664673656, 4, ".5 1 1.5 2"],
  [0.0051003171646184, 0.0148552324294959, 5, ".005 .01 .015"],
  [144.430258440473, 1054.53569840562, 5, "200 400 600 800 1000"],
  [0.0051003171646184, 0.0148552324294959, 4, ".005 .01 .015"],
  [1.31738533255821, 11.6413354195728, 5, "2 4 6 8 10 12"],
  [1.25664506265584, 8.1050931656474, 5, "2 4 6 8"],
  [1.31738533255821, 11.6413354195728, 4, "0 5 10 15"],
];
test("ticks match 120 axes Stata drew", () => {
  for (const [lo, hi, n, want] of GRAPHS)
    assert.equal(
      ticks(lo, hi, n).map(stata).join(" "),
      want,
      `${lo} ${hi} #${n}`,
    );
});

// [lo, hi, n, r(min), r(max), r(delta)] from _natscale lo hi n.
const NATSCALE = [
  [0.0000281438131092, 0.0000361684585881, 2, 0.00003, 0.00004, 0.000005],
  [0.0000252274067709, 0.0000660658831671, 2, 0.00002, 0.00006, 0.00002],
  [4.48008399646991, 71.1750136846369, 2, 0, 100, 100],
  [-24.71707306299, -15.8739217092773, 2, -25, -15, 5],
  [0.0018416648565508, 0.101279139051182, 2, 0, 0.1, 0.05],
  [670.043320570023, 697.359514159229, 2, 660, 700, 20],
  [-0.0000250879190851, -0.0000227973421253, 3, -0.000025, -0.000023, 0.000001],
  [14.490126498518, 66.6534130016481, 3, 20, 60, 20],
  [0.0198308001254852, 0.019947719357219, 3, 0.01985, 0.01995, 0.00005],
  [0, 0.0008460907727098, 3, 0, 0.001, 0.0005],
  [452.070025065184, 5173.67199173122, 3, 0, 6000, 2000],
  [0.00004, 0.00005, 3, 0.00004, 0.00005, 0.000005],
  [-93.5452215190496, 38998.5685977568, 4, 0, 40000, 10000],
  [-2.47825247683392, 15.9537069558284, 4, -5, 15, 5],
  [2.4902216486416, 83.5634472033779, 4, 0, 80, 20],
  [0.0748523105315619, 0.144644088621766, 4, 0.08, 0.14, 0.02],
  [0, 0.0094038109103424, 4, 0, 0.01, 0.005],
  [-1142.13661416841, -712.388195151195, 4, -1100, -700, 100],
  [0.553213206177779, 0.584859151118694, 6, 0.555, 0.585, 0.005],
  [0.0051254740948801, 0.01783310808799, 6, 0.006, 0.018, 0.002],
  [2098.1636180618, 5628.40587446495, 6, 2000, 6000, 1000],
  [0.0563815403041507, 0.0569220213640044, 6, 0.0564, 0.0569, 0.0001],
  [40, 110, 6, 40, 120, 20],
  [0.0075893476499651, 0.81414262472373, 6, 0, 0.8, 0.2],
  [0, 50.1504176233026, 7, 0, 50, 10],
  [0.0136835813440652, 0.021674729775204, 7, 0.014, 0.022, 0.002],
  [0.0037498842172707, 0.0978472901542852, 7, 0, 0.1, 0.02],
  [0.0003499680865088, 0.0035004454356688, 7, 0.0005, 0.0035, 0.0005],
  [0.6, 5.5, 7, 0, 6, 1],
  [0, 4.33648120534856, 7, 0, 5, 1],
  [183.433894279959, 280.186235932941, 8, 180, 280, 20],
  [0, 6.31862198356204, 8, 0, 7, 1],
  [0, 3343.67461040933, 8, 0, 3500, 500],
  [0.060693834441199, 0.230917199710776, 8, 0.05, 0.25, 0.05],
  [-1.5886026889002, 0.923139841869932, 8, -1.5, 1, 0.5],
  [5726.77893575721, 9225.527885187, 8, 5500, 9500, 500],
  [29.0386431790582, 119.032451917469, 10, 30, 120, 10],
  [-14.3059180798733, 78.8053903350434, 10, -10, 80, 10],
  [0, 0.81, 10, 0, 0.8, 0.1],
  [0.609067012834356, 0.799911114233727, 10, 0.6, 0.8, 0.02],
  [3.89711938141016, 11.2962143957703, 10, 4, 12, 1],
  [0.273911270181296, 0.319045569627514, 10, 0.275, 0.32, 0.005],
  [2.10642297637316, 7.9306823807783, 15, 2, 8, 0.5],
  [47.4787434547069, 49.5587331717563, 15, 47.4, 49.6, 0.2],
  [0.476500059021072, 4.75561490626991, 15, 0.5, 5, 0.5],
  [0.0035797052083127, 0.0724506201999939, 15, 0.005, 0.075, 0.005],
  [-0.225215459879896, 0.378774277655915, 15, -0.25, 0.4, 0.05],
  [0.290861095588757, 0.558033395207146, 15, 0.28, 0.56, 0.02],
];
test("ticks match _natscale for other numbers of labels", () => {
  for (const [lo, hi, n, min, max, delta] of NATSCALE) {
    const want = [];
    for (let k = 0; min + k * delta <= max + delta / 1e6; k++)
      want.push(stata(Number((min + k * delta).toPrecision(10))));
    assert.equal(
      ticks(lo, hi, n).map(stata).join(" "),
      want.join(" "),
      `${lo} ${hi} #${n}`,
    );
  }
});

test("by() refuses rows() with cols(), and lines need numbers", () => {
  const s = labor();
  const both = refused(s, "scatter wage educ, by(female, cols(2) rows(2))");
  assert.equal(both.rc, 198);
  assert.match(both.text, /may not specify both rows\(\) and cols\(\)/);
  const line = refused(s, "scatter wage educ, yline(abc)");
  assert.equal(line.rc, 198);
  assert.match(line.text, /invalid line argument, abc/);
  assert.equal(refused(s, "scatter wage educ, xline(1 abc)").rc, 198);
  // yline() with nothing in it draws no line, as in Stata.
  assert.equal(s.run("scatter wage educ, yline()").rc, 0);
});

test("graph combine needs graphs and graph dir lists them in columns", () => {
  const s = labor();
  const none = refused(s, "graph combine");
  assert.equal(none.rc, 198);
  assert.match(none.text, /graph specification required/);
  assert.equal(refused(s, "graph combine, cols(2)").rc, 199);
  for (const name of ["alongergraphname", "abcdefghi", "abcdefgh", "g1", "g2"])
    assert.equal(s.run(`scatter wage educ, name(${name})`).rc, 0);
  // Stata, at linesize 80.
  s.run("set linesize 80");
  assert.deepEqual(
    s.run("graph dir").output.flatMap((o) => o.lines ?? []),
    ["    abcdefgh          alongergraphname  g2", "    abcdefghi         g1"],
  );
});

// ---- Fourth round: the problems a tester found at 8e2f4ff, each value
// recorded from Stata 19 MP (version 17, set processors 1) by exporting the
// same graph with graph export … .svg and reading its <text> elements. The
// printed messages, graph dir and the histogram bin lines are compared in
// tools/output-cases.txt (case graph-axes-merge).

test("legend(on) outside by() draws a legend in every panel", () => {
  const s = labor();
  // Stata: Hourly wage three times, the y title and one legend per panel.
  assert.equal(
    count(graph(s, "scatter wage educ, by(female) legend(on)"), "Hourly wage"),
    3,
  );
  // Two plots: a legend in each panel and the shared one, three of each.
  for (const command of [
    "twoway (scatter wage educ) (lfit wage educ), by(female) legend(on)",
    "twoway (scatter wage educ) (lfit wage educ), by(female, legend(on)) legend(on)",
  ]) {
    const svg = graph(s, command);
    assert.equal(count(svg, "Hourly wage"), 3);
    assert.equal(count(svg, "Fitted values"), 3);
  }
  // by(…, legend(on)) gives a single plot the shared legend: twice.
  assert.equal(
    count(graph(s, "scatter wage educ, by(female, legend(on))"), "Hourly wage"),
    2,
  );
  // by(…, legend(off)) leaves only the panels' legends.
  assert.equal(
    count(
      graph(s, "scatter wage educ, by(female, legend(off)) legend(on)"),
      "Hourly wage",
    ),
    3,
  );
  const off = graph(
    s,
    "twoway (scatter wage educ) (lfit wage educ), by(female, legend(off)) legend(on)",
  );
  assert.equal(count(off, "Hourly wage"), 2);
  assert.equal(count(off, "Fitted values"), 2);
  // With total, three panels: the y title and three legends.
  assert.equal(
    count(
      graph(s, "scatter wage educ, by(female, total) legend(on)"),
      "Hourly wage",
    ),
    4,
  );
});

test("histogram labels its x axis as Stata does", () => {
  const s = labor();
  const x = (command) => xLabels(graph(s, command));
  // Stata labels over the first bar's left edge (histogram gives start())
  // to the middle of the last bar.
  for (const command of ["histogram education", "histogram education, bin(5)"])
    assert.deepEqual(x(command), ["8", "10", "12", "14", "16", "18"]);
  assert.deepEqual(x("histogram wage, width(5)"), [
    "0",
    "10",
    "20",
    "30",
    "40",
    "50",
  ]);
  for (const command of [
    "histogram satisfaction, discrete",
    "histogram satisfaction, discrete frequency",
  ])
    assert.deepEqual(x(command), ["0", "1", "2", "3", "4", "5"]);
  for (const rule of ["#3", "#4"])
    assert.deepEqual(x(`histogram wage, xlabel(${rule})`), ["0", "50"]);
  // twoway histogram, with no start(), from the middle of the first bar.
  assert.deepEqual(x("twoway (histogram wage, width(5))"), [
    "10",
    "20",
    "30",
    "40",
    "50",
  ]);
  // A curve reaches the data's ends, or the bars' edges when discrete.
  assert.deepEqual(x("histogram educ, kdensity"), ["5", "10", "15", "20"]);
  assert.deepEqual(x("histogram satisfaction, discrete normal"), [
    "0",
    "2",
    "4",
    "6",
  ]);
});

// [seed, N, x, command, Stata's x labels, Stata's y labels]: histograms of
// random data drawn in Stata, every sixth of 160 histogram commands and
// every ninth of 160 twoway histogram commands.
const HISTOGRAMS = [
  [
    506,
    242,
    "runiform()*120 + 1990",
    "histogram x, bin(9)",
    "2000 2020 2040 2060 2080 2100",
    "0 .005 .01 .015",
  ],
  [
    512,
    164,
    "runiform()*7 + -40",
    "histogram x, width(1.4)",
    "-40 -38 -36 -34",
    "0 .05 .1 .15 .2",
  ],
  [
    518,
    86,
    "runiform()*1000 + 0.2",
    "histogram x",
    "0 200 400 600 800 1000",
    "0 5.0e-04 .001 .0015",
  ],
  [
    524,
    308,
    "runiform()*0.4 + -3",
    "histogram x",
    "-3 -2.9 -2.8 -2.7 -2.6",
    "0 1 2 3 4",
  ],
  [
    530,
    230,
    "runiform()*1 + 0",
    "histogram x",
    "0 .2 .4 .6 .8 1",
    "0 .5 1 1.5",
  ],
  [
    536,
    152,
    "runiform()*120 + 1990",
    "histogram x, bin(5)",
    "2000 2020 2040 2060 2080 2100",
    "0 .002 .004 .006 .008 .01",
  ],
  [
    542,
    74,
    "floor(runiform()*8)*0.5 + -40",
    "histogram x, discrete",
    "-40 -39 -38 -37 -36",
    "0 .1 .2 .3 .4",
  ],
  [
    548,
    296,
    "runiform()*1000 + 0.2",
    "histogram x",
    "0 200 400 600 800 1000",
    "0 5.0e-04 .001 .0015",
  ],
  [
    554,
    218,
    "runiform()*0.4 + -3",
    "histogram x",
    "-3 -2.9 -2.8 -2.7 -2.6",
    "0 1 2 3 4",
  ],
  [
    560,
    140,
    "runiform()*1 + 0",
    "histogram x",
    "0 .2 .4 .6 .8 1",
    "0 .5 1 1.5 2",
  ],
  [
    566,
    62,
    "runiform()*120 + 1990",
    "histogram x, bin(18)",
    "2000 2050 2100",
    "0 .005 .01 .015 .02",
  ],
  [
    572,
    284,
    "runiform()*7 + -40",
    "histogram x, width(3.5)",
    "-40 -39 -38 -37 -36 -35",
    "0 .05 .1 .15",
  ],
  [
    578,
    206,
    "runiform()*1000 + 0.2",
    "histogram x",
    "0 200 400 600 800 1000",
    "0 5.0e-04 .001 .0015",
  ],
  [
    584,
    128,
    "floor(runiform()*2)*1 + -3",
    "histogram x, discrete",
    "-3.5 -3 -2.5 -2",
    "0 .1 .2 .3 .4 .5",
  ],
  [590, 50, "runiform()*1 + 0", "histogram x", "0 .2 .4 .6 .8 1", "0 .5 1 1.5"],
  [
    596,
    272,
    "runiform()*120 + 1990",
    "histogram x, bin(14)",
    "2000 2050 2100",
    "0 .005 .01 .015",
  ],
  [
    602,
    194,
    "runiform()*7 + -40",
    "histogram x, width(1.4)",
    "-40 -38 -36 -34",
    "0 .05 .1 .15",
  ],
  [
    608,
    116,
    "runiform()*1000 + 0.2",
    "histogram x",
    "0 200 400 600 800 1000",
    "0 5.0e-04 .001 .0015 .002",
  ],
  [
    614,
    38,
    "runiform()*0.4 + -3",
    "histogram x",
    "-3 -2.9 -2.8 -2.7 -2.6",
    "0 1 2 3",
  ],
  [
    620,
    260,
    "runiform()*1 + 0",
    "histogram x",
    "0 .2 .4 .6 .8 1",
    "0 .5 1 1.5",
  ],
  [
    626,
    182,
    "floor(runiform()*8)*0.5 + 1990",
    "histogram x, discrete",
    "1990 1991 1992 1993 1994",
    "0 .1 .2 .3",
  ],
  [
    632,
    104,
    "runiform()*7 + -40",
    "histogram x, width(0.88)",
    "-40 -38 -36 -34 -32",
    "0 .05 .1 .15 .2",
  ],
  [
    638,
    26,
    "runiform()*1000 + 0.2",
    "histogram x",
    "0 200 400 600 800 1000",
    "0 5.0e-04 .001 .0015",
  ],
  [
    644,
    248,
    "runiform()*0.4 + -3",
    "histogram x",
    "-3 -2.9 -2.8 -2.7 -2.6",
    "0 1 2 3 4",
  ],
  [
    650,
    170,
    "runiform()*1 + 0",
    "histogram x",
    "0 .2 .4 .6 .8 1",
    "0 .5 1 1.5",
  ],
  [
    656,
    92,
    "runiform()*120 + 1990",
    "histogram x, bin(6)",
    "2000 2020 2040 2060 2080 2100",
    "0 .002 .004 .006 .008 .01",
  ],
  [
    504,
    168,
    "runiform()*0.4 + -3",
    "twoway (histogram x)",
    "-3 -2.9 -2.8 -2.7 -2.6",
    "0 1 2 3 4",
  ],
  [
    513,
    201,
    "runiform()*13 + 0",
    "twoway (histogram x)",
    "0 5 10 15",
    "0 .05 .1 .15",
  ],
  [
    522,
    234,
    "runiform()*7 + -40",
    "twoway (histogram x, width(1.2))",
    "-40 -38 -36 -34 -32",
    "0 .05 .1 .15",
  ],
  [
    531,
    267,
    "runiform()*3 + 100",
    "twoway (histogram x, bin(17) xlabel(#9))",
    "100 100.5 101 101.5 102 102.5 103",
    "0 .1 .2 .3 .4 .5",
  ],
  [
    540,
    300,
    "runiform()*1 + 0",
    "twoway (histogram x)",
    "0 .2 .4 .6 .8 1",
    "0 .5 1 1.5",
  ],
  [
    549,
    33,
    "floor(runiform()*3)*2 + 2",
    "twoway (histogram x, discrete)",
    "2 3 4 5 6",
    "0 .05 .1 .15 .2",
  ],
  [
    558,
    66,
    "runiform()*1000 + 0.2",
    "twoway (histogram x)",
    "0 200 400 600 800 1000",
    "0 5.0e-04 .001 .0015 .002",
  ],
  [
    567,
    99,
    "runiform()*2.5 + 5",
    "twoway (histogram x, width(0.42) xlabel(#5))",
    "5 5.5 6 6.5 7 7.5",
    "0 .1 .2 .3 .4 .5",
  ],
  [
    576,
    132,
    "runiform()*120 + 1990",
    "twoway (histogram x, bin(11) start(-50))",
    "0 500 1000 1500 2000",
    "0 .001 .002 .003 .004 .005",
  ],
  [
    585,
    165,
    "runiform()*55 + 17",
    "twoway (histogram x)",
    "20 30 40 50 60 70",
    "0 .005 .01 .015 .02 .025",
  ],
  [
    594,
    198,
    "runiform()*0.4 + -3",
    "twoway (histogram x)",
    "-3 -2.9 -2.8 -2.7 -2.6",
    "0 1 2 3 4",
  ],
  [
    603,
    231,
    "runiform()*13 + 0",
    "twoway (histogram x, xlabel(#9))",
    "0 2 4 6 8 10 12",
    "0 .02 .04 .06 .08 .1",
  ],
  [
    612,
    264,
    "floor(runiform()*6)*1 + -40",
    "twoway (histogram x, discrete)",
    "-40 -39 -38 -37 -36 -35",
    "0 .05 .1 .15 .2",
  ],
  [
    621,
    297,
    "runiform()*3 + 100",
    "twoway (histogram x, bin(5) start(-50))",
    "-50 0 50 100",
    "0 .01 .02 .03 .04",
  ],
  [
    630,
    30,
    "runiform()*1 + 0",
    "twoway (histogram x)",
    ".2 .4 .6 .8 1",
    "0 .5 1 1.5 2",
  ],
  [
    639,
    63,
    "runiform()*0.07 + 2.25",
    "twoway (histogram x, xlabel(#5))",
    "2.26 2.28 2.3 2.32",
    "0 5 10 15 20 25",
  ],
  [
    648,
    96,
    "runiform()*1000 + 0.2",
    "twoway (histogram x)",
    "0 200 400 600 800 1000",
    "0 5.0e-04 .001 .0015",
  ],
  [
    657,
    129,
    "runiform()*2.5 + 5",
    "twoway (histogram x, width(0.42))",
    "5 5.5 6 6.5 7 7.5",
    "0 .1 .2 .3 .4 .5",
  ],
];
test("histograms of random data are labelled as Stata labels them", () => {
  for (const [seed, n, x, command, xs, ys] of HISTOGRAMS) {
    const s = labor();
    for (const line of [
      "clear",
      `set seed ${seed}`,
      `set obs ${n}`,
      `generate x = ${x}`,
    ])
      assert.equal(s.run(line).rc, 0);
    const svg = graph(s, command);
    assert.equal(xLabels(svg).join(" "), xs, `${seed} ${command}`);
    assert.equal(yLabels(svg).join(" "), ys, `${seed} ${command}`);
  }
});

test("#0 labels nothing in by() panels, and minmax each panel's ends", () => {
  const s = labor();
  for (const command of [
    "scatter wage educ, by(female) ylabel(#0)",
    "scatter wage educ, by(union) ylabel(#0)",
    "scatter hours educ, by(female) ylabel(#0)",
    "scatter wage educ, by(female, total) ylabel(#0)",
    "histogram wage, by(female) ylabel(#0)",
    "scatter wage educ, by(female) ylabel(#-1)",
  ])
    assert.deepEqual(yLabels(graph(s, command)), [], command);
  assert.deepEqual(
    xLabels(graph(s, "scatter wage educ, by(female) xlabel(#0)")),
    [],
  );
  // #1 labels the ends of all the panels' data; minmax the first panel's.
  assert.deepEqual(
    yLabels(graph(s, "scatter wage educ, by(female) ylabel(#1)")),
    ["4.81", "50.77"],
  );
  assert.deepEqual(
    yLabels(graph(s, "scatter wage educ, by(female) ylabel(minmax)")),
    ["5.06", "50.77"],
  );
});

test("axis labels are written in the display format of the plotted variable", () => {
  const s = labor();
  const y = (command) => yLabels(graph(s, command)),
    x = (command) => xLabels(graph(s, command));
  for (const line of [
    "generate double yr = 2000000 + wage/100",
    "generate double lwd = ln(wage)",
    "generate w2 = wage",
    "format w2 %9.1f",
    "generate e2 = educ",
    "format e2 %9.2f",
    "generate double big = 123456789.123 + wage",
    "generate double tiny = wage/1e7",
    "generate fl = wage*1000000",
    "generate double lw = ln(wage)",
    "generate double le = ln(educ)",
    "generate cw = wage*1000",
    "format cw %9.0gc",
  ])
    assert.equal(s.run(line).rc, 0, line);
  assert.deepEqual(y("scatter yr educ"), [
    "2000000",
    "2000000.1",
    "2000000.2",
    "2000000.3",
    "2000000.4",
    "2000000.5",
  ]);
  assert.deepEqual(y("scatter lwd educ, ylabel(#0)"), [
    "1.5706971",
    "3.9273056",
  ]);
  assert.equal(s.run("format lwd %9.2f").rc, 0);
  assert.deepEqual(y("scatter lwd educ"), [
    "1.50",
    "2.00",
    "2.50",
    "3.00",
    "3.50",
    "4.00",
  ]);
  assert.deepEqual(y("scatter lwd educ, ylabel(#0)"), ["1.57", "3.93"]);
  const tenths = ["0.0", "10.0", "20.0", "30.0", "40.0", "50.0"];
  assert.deepEqual(y("scatter w2 educ"), tenths);
  // The first plot's variable names the format; a fit's is %9.0g.
  assert.deepEqual(y("scatter w2 lwd educ"), tenths);
  assert.deepEqual(y("scatter lwd w2 educ"), [
    "0.00",
    "10.00",
    "20.00",
    "30.00",
    "40.00",
    "50.00",
  ]);
  assert.deepEqual(y("twoway (lfit w2 educ) (scatter w2 educ)"), [
    "0",
    "10",
    "20",
    "30",
    "40",
    "50",
  ]);
  assert.deepEqual(x("scatter wage e2"), ["5.00", "10.00", "15.00", "20.00"]);
  assert.deepEqual(y("scatter w2 educ, by(female)"), [
    "0.0",
    "20.0",
    "40.0",
    "60.0",
  ]);
  assert.deepEqual(x("histogram w2"), tenths);
  assert.deepEqual(y("scatter w2 educ, ylabel(minmax)"), ["4.8", "50.8"]);
  // Bar heights are %6.4g; a density Stata makes is %10.0g.
  assert.deepEqual(y("histogram wage, ylabel(#0)"), ["0", ".057"]);
  assert.deepEqual(y("histogram hours, ylabel(#0)"), ["0", ".0753"]);
  assert.deepEqual(y("histogram w2, frequency ylabel(#0)"), ["0", "64"]);
  assert.deepEqual(y("histogram w2, percent ylabel(#0)"), ["0", "10.92"]);
  assert.deepEqual(y("histogram w2, fraction ylabel(#0)"), ["0", ".1092"]);
  assert.deepEqual(y("kdensity w2, ylabel(#0)"), [".00032904", ".05556199"]);
  const density = graph(s, "twoway (kdensity lw), ylabel(#0) xlabel(#0)");
  assert.deepEqual(yLabels(density), [".01678597", ".8854821"]);
  assert.deepEqual(xLabels(density), ["1.5706971", "3.9273056"]);
  const fit = graph(s, "twoway (lfit lw le), ylabel(#0) xlabel(#0)");
  assert.deepEqual(yLabels(fit), ["2.260064", "3.322691"]);
  assert.deepEqual(xLabels(fit), ["2.079442", "2.944439"]);
  const smooth = graph(s, "twoway (lowess lw le), ylabel(#0) xlabel(#0)");
  assert.deepEqual(yLabels(smooth), ["2.4121203", "3.5055441"]);
  assert.deepEqual(xLabels(smooth), ["2.0794415", "2.944439"]);
  assert.deepEqual(y("scatter big educ"), Array(6).fill("1.235e+08"));
  assert.deepEqual(y("scatter tiny educ"), [
    "0",
    "1.000e-06",
    "2.000e-06",
    "3.000e-06",
    "4.000e-06",
    "5.000e-06",
  ]);
  assert.deepEqual(y("scatter fl educ, ylabel(#0)"), ["4810000", "5.08e+07"]);
  assert.deepEqual(y("scatter cw educ"), [
    "0",
    "10,000",
    "20,000",
    "30,000",
    "40,000",
    "50,000",
  ]);
});

test("label rules are read as Stata reads them", () => {
  const s = labor();
  const y = (rule) => yLabels(graph(s, `scatter wage educ, ylabel(${rule})`));
  assert.deepEqual(y("minmax"), ["4.81", "50.77"]);
  assert.deepEqual(y("minmax 25"), ["4.81", "50.77", "25"]);
  assert.deepEqual(y("#3 10"), ["0", "20", "40", "60", "10"]);
  assert.deepEqual(y('#3 10 "ten"'), ["0", "20", "40", "60", "ten"]);
  // A value of the rule that follows it too is drawn where the list puts it.
  assert.deepEqual(y("#3 20"), ["0", "40", "60", "20"]);
  assert.deepEqual(y('#3 20 "x"'), ["0", "40", "60", "x"]);
  assert.deepEqual(y('0(10)30 20 "x"'), ["0", "10", "30", "x"]);
  assert.deepEqual(y("#3 10(5)20"), ["0", "40", "60", "10", "15", "20"]);
  assert.deepEqual(y("."), []);
  assert.deepEqual(y(". 10"), ["10"]);
  assert.deepEqual(y('. 10 "ten"'), ["ten"]);
  assert.deepEqual(y('none 10 "x"'), ["x"]);
  assert.deepEqual(y("none, nogrid"), []);
  assert.deepEqual(y('10 15 "x"'), ["10", "x"]);
  assert.deepEqual(y("10(5)20 30(5)40"), ["10", "15", "20", "30", "35", "40"]);
  assert.deepEqual(y('10 20(5)30 "x"'), ["10", "20", "25", "x"]);
  assert.deepEqual(y('10/20 "x"'), [
    ..."10 11 12 13 14 15 16 17 18 19".split(" "),
    "x",
  ]);
  assert.deepEqual(y('1e1 "a"'), ["a"]);
  assert.deepEqual(y('10 ""'), ["10"]);
  assert.deepEqual(y('10 20 ""'), ["10", "20"]);
  assert.deepEqual(y('10 "a" 10 "b"'), ["a", "b"]);
  assert.deepEqual(y('10 "a" 10 "b" 20'), ["a", "b", "20"]);
  // ##3 is for minor ticks: Stata says so and draws no labels.
  const minor = s.run("scatter wage educ, ylabel(##3)");
  assert.equal(minor.rc, 0);
  assert.deepEqual(
    minor.output.flatMap((o) => o.lines ?? []),
    ["##3 ignored, only allowed for minor ticks"],
  );
  for (const [rule, shown] of [
    ["#3 #4", "#4"],
    ['10 "ten" none 30', '10 "ten" none 30'],
    ["none none", "none"],
    ['10(5)20 "x"', '"x"'],
    ['. "missing"', '"missing"'],
    ["25 minmax", "25 minmax"],
    ["minmax #3", "#3"],
    ["#3 none", "none"],
    ["10 . 20", "10 . 20"],
    ["MINMAX", "MINMAX"],
    ['#3 "x"', '"x"'],
  ]) {
    const out = refused(s, `scatter wage educ, ylabel(${rule})`);
    assert.equal(out.rc, 198, rule);
    assert.equal(
      out.text.split("\n")[0],
      `invalid label specifier, :  ${shown}:`,
      rule,
    );
  }
});

test("repeated label and line options are merged, as are those in a plot", () => {
  const s = labor();
  const lines = (svg) =>
    (svg.match(/stroke="#333333" stroke-width="1"\/>/g) ?? []).length;
  assert.equal(lines(graph(s, "scatter wage educ, yline(10) yline(20)")), 2);
  assert.equal(lines(graph(s, "scatter wage educ, xline(10) xline(12)")), 2);
  assert.equal(lines(graph(s, "scatter wage educ, yline(10 20) yline(30)")), 3);
  // A later label option replaces the values and keeps the suboptions.
  const y = (options) => yLabels(graph(s, `scatter wage educ, ${options}`));
  assert.deepEqual(
    xLabels(graph(s, "scatter wage educ, xlabel(10) xlabel(12)")),
    ["12"],
  );
  assert.deepEqual(y("ylabel(10 20) ylabel(30)"), ["30"]);
  assert.deepEqual(y("ylabel(10 20) ylabel()"), ["10", "20"]);
  assert.deepEqual(y("ylabel(10 20, grid) ylabel(#3)"), [
    "0",
    "20",
    "40",
    "60",
  ]);
  assert.deepEqual(y("ylabel(#3, nogrid) ylabel(10)"), ["10"]);
  assert.deepEqual(y('ylabel(10 "a") ylabel(20 "b")'), ["b"]);
  assert.deepEqual(y("ylabel(10 20) ylabel(none)"), []);
  // The graph's options written inside a plot are the graph's.
  const inside = graph(
    s,
    "twoway (scatter wage educ, title(hi) xlabel(#9) yline(20))",
  );
  assert.equal(count(inside, "hi"), 1);
  assert.equal(lines(inside), 1);
  assert.deepEqual(xLabels(inside), ["8", "10", "12", "14", "16", "18", "20"]);
  assert.equal(
    count(
      graph(
        s,
        "twoway (scatter wage educ, title(a)) (lfit wage educ, title(b)), title(c)",
      ),
      "c",
    ),
    1,
  );
  assert.deepEqual(
    yLabels(
      graph(
        s,
        "twoway (scatter wage educ, ylabel(10 20)) (lfit wage educ, ylabel(30))",
      ),
    ),
    ["30"],
  );
  assert.equal(
    count(
      graph(
        s,
        "twoway (scatter wage educ, xtitle(X)) (lfit wage educ), xtitle(Y)",
      ),
      "Y",
    ),
    1,
  );
});

test("generated plots are titled, and histogram's curves named, as in Stata", () => {
  const s = labor();
  assert.equal(count(graph(s, "twoway (lfit wage educ)"), "Fitted values"), 1);
  assert.equal(count(graph(s, "twoway (qfit wage educ)"), "Fitted values"), 1);
  // Stata: the y title lowess w2 e2 (recorded with w2 and e2 copies of
  // wage and educ).
  assert.equal(s.run("generate w2 = wage").rc, 0);
  assert.equal(s.run("generate e2 = educ").rc, 0);
  assert.equal(count(graph(s, "twoway (lowess w2 e2)"), "lowess w2 e2"), 1);
  const density = graph(s, "twoway (kdensity wage)");
  assert.equal(count(density, "kdensity wage"), 1);
  assert.equal(count(density, "x"), 1);
  // histogram draws a legend only when asked.
  assert.equal(count(graph(s, "histogram wage, normal"), "Density"), 1);
  assert.equal(
    count(graph(s, "histogram wage, kdensity legend(order(1 2))"), "Density"),
    1,
  );
  const asked = graph(s, "histogram wage, normal legend(on)");
  assert.equal(count(asked, "Density"), 2);
  assert.equal(count(asked, "normal wage"), 1);
});
