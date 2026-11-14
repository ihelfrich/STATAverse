// The data commands on a student's own files (fourth round, 13 November
// 2026): split, recode with value labels, reshape's report, inspect,
// misstable, xtdescribe, outsheet, weighted collapse quantiles, merge's
// update and replace, and the messages append, merge, tostring and
// mvdecode print. Every expected value and line was recorded from Stata 19
// MP (version 17, set processors 1) on the same simulated data. The printed
// text is also compared by the output cases datacmds-* in
// tools/output-cases.txt; these tests cover what those cannot: .dta files
// read from bytes, the text outsheet writes, and inspect lines that begin
// with a dot, which the recorder would take for a command.
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";
import { Session } from "../src/runtime/session.js";

const lines = (s, source) =>
  s
    .run(source)
    .output.flatMap((o) => o.lines)
    .join("\n");
/** A .dta file's bytes, written by a session that runs the source. */
function dta(source) {
  const s = createConsoleSession();
  assert.equal(s.run(source).rc, 0);
  return s.exportData().bytes;
}

test('split with parse(" ") splits at every single blank', () => {
  const s = createConsoleSession();
  s.run(
    'clear\ninput str20 city\n"  El Paso "\n"New York City"\n"San  Antonio  "\nend\ngenerate tr = trim(city)',
  );
  const out = s.run('split tr, parse(" ") generate(part)');
  assert.equal(out.rc, 0);
  // Stata 19: variables created as string: part1 part2 part3; the double
  // blank in "San  Antonio" leaves part2 empty.
  assert.deepEqual(out.output.at(-1).lines, [
    "variables created as string: ",
    "part1  part2  part3",
  ]);
  const listed = lines(s, "list part1 part2 part3, noobs clean");
  assert.match(listed, /El\s+Paso/);
  assert.match(listed, /New\s+York\s+City/);
  assert.match(listed, /San\s+Antonio/);
  // Stata 19: notrim with blanks as the separator is r(198).
  assert.equal(s.run("split city, generate(h) notrim").rc, 198);
  // Stata 19: r(nvars) "3", r(k_new) 3.
  assert.equal(s.run("split tr, generate(k)").rc, 0);
  assert.equal(
    s.run('display r(nvars) " " r(k_new)').output.at(-1).lines[0],
    "3 3",
  );
});

test("recode defines and attaches the value labels written in its rules", () => {
  const s = createConsoleSession();
  s.run(
    'clear\nset obs 12\ngenerate byte educ = mod(_n,4)+1\nreplace educ = . in 12\nlabel define el 1 "Less" 2 "HS" 3 "Some college" 4 "BA+"\nlabel values educ el',
  );
  const out = s.run(
    'recode educ (1 2 = 1 "HS or less") (3 4 = 2 "More than HS"), generate(educ2)',
  );
  // Stata 19: (9 differences between educ and educ2).
  assert.deepEqual(out.output.at(-1).lines, [
    "(9 differences between educ and educ2)",
  ]);
  const table = lines(s, "tabulate educ2");
  assert.match(table, /HS or less \|\s+5\s+45\.45/);
  assert.match(table, /More than HS \|\s+6\s+54\.55/);
  // Stata 19: educ2 byte %12.0g educ2, "RECODE of educ".
  assert.match(
    lines(s, "describe educ2"),
    /educ2\s+byte\s+%12\.0g\s+educ2\s+RECODE of educ/,
  );
  // Stata 19: label() names the label; the variable keeps %9.0g.
  s.run(
    'recode educ (1=10 "ten") (2=20) (else=99 "other"), generate(e3) label(mylab)',
  );
  assert.match(lines(s, "describe e3"), /e3\s+byte\s+%9\.0g\s+mylab/);
  assert.match(lines(s, "tabulate e3"), /other \|\s+7/);
  // Stata 19: labels in rules are refused when the variable is replaced.
  const refused = s.run('recode educ (1=1 "one") (2=2 "two")');
  assert.equal(refused.rc, 198);
  assert.match(
    refused.output.at(-1).lines.join("\n"),
    /Rules defining value labels not allowed when overwriting a variable/,
  );
});

test("reshape prints the j values and Stata's transition table", () => {
  const s = createConsoleSession();
  s.run(
    "clear\nset obs 6\ngenerate id = ceil(_n/3)\ngenerate wave = mod(_n-1,3)+1\ngenerate income = 100*_n\ngenerate hours = _n",
  );
  const wide = s.run("reshape wide income hours, i(id) j(wave)");
  // Stata 19, line for line (trailing blanks removed).
  assert.deepEqual(
    wide.output.at(-1).lines.map((line) => line.trimEnd()),
    [
      "(j = 1 2 3)",
      "",
      "Data                               Long   ->   Wide",
      "-".repeat(77),
      "Number of observations                6   ->   2",
      "Number of variables                   4   ->   7",
      "j variable (3 values)              wave   ->   (dropped)",
      "xij variables:",
      "                                 income   ->   income1 income2 income3",
      "                                  hours   ->   hours1 hours2 hours3",
      "-".repeat(77),
    ],
  );
  // Stata 19: reshape long alone reverses it with the same report.
  const long = s.run("reshape long").output.at(-1).lines;
  assert.equal(long[0], "(j = 1 2 3)");
  assert.equal(
    long[6].trimEnd(),
    "j variable (3 values)                     ->   wave",
  );
  assert.equal(
    long[8].trimEnd(),
    "                income1 income2 income3   ->   income",
  );
});

test("inspect, misstable, xtdescribe and outsheet are recognized", () => {
  const s = createConsoleSession();
  s.run(
    "clear\nset obs 6\ngenerate id = ceil(_n/3)\ngenerate wave = mod(_n-1,3)+1\ngenerate x = _n\nreplace x = . in 2",
  );
  for (const command of [
    "inspect x",
    "misstable summarize",
    "misstable patterns",
    "xtset id wave",
    "xtdescribe",
    "outsheet using x.csv, comma replace",
  ])
    assert.equal(s.run(command).rc, 0, command);
  // Stata 19: misstable tree exists; this runtime refuses it with r(198).
  assert.equal(s.run("misstable tree x").rc, 198);
});

test("inspect of a string or all-missing variable shows no values", () => {
  const s = createConsoleSession();
  s.run('clear\nset obs 4\ngenerate str5 s = "a"\ngenerate x = .');
  // Stata 19, for both: Missing 4, "." and -9.0e+307 as the range, and
  // (0 unique value).
  for (const name of ["s", "x"]) {
    const out = s.run(`inspect ${name}`).output.at(-1).lines;
    assert.equal(
      out.find((line) => line.includes("Missing")),
      "|                            Missing             4",
    );
    assert.ok(
      out.includes(".             -9.0e+307                          4"),
      out.join("\n"),
    );
    assert.ok(out.includes("   (0 unique value)"));
  }
});

test("outsheet writes the text Stata writes", () => {
  const s = new Session();
  s.run(
    [
      "clear",
      "set obs 4",
      "generate id = _n",
      "generate double big = 123456789.123 * _n",
      "generate float f = 1/_n",
      "replace f = . in 2",
      "replace f = .a in 3",
      'generate str12 s = "a b"',
      `replace s = \`"say "hi""' in 2`,
      'replace s = "x,y" in 3',
      'replace s = "" in 4',
      "generate int d = 21000 + _n",
      "format d %td",
      "generate byte g = mod(_n,2)",
      'label define gl 0 "zero" 1 "one"',
      "label values g gl",
      "format f %6.2f",
      "outsheet using o1.csv, comma replace",
      "outsheet using o2, replace",
      "outsheet id s g using o3.csv, comma nolabel noquote replace",
      'outsheet id s if id > 2 using o4.csv, nonames replace delimiter(";")',
    ].join("\n"),
  );
  // The files Stata 19 wrote from the same commands.
  assert.equal(
    s.files.get("o1.csv").text,
    'id,big,f,s,d,g\n1,1.235e+08,1.00,"a b",01jul2017,"one"\n2,2.469e+08,,"say "hi"",02jul2017,"zero"\n3,3.704e+08,.a,"x,y",03jul2017,"one"\n4,4.938e+08,0.25,"",04jul2017,"zero"\n',
  );
  assert.equal(
    s.files.get("o2.out").text,
    'id\tbig\tf\ts\td\tg\n1\t1.235e+08\t1.00\t"a b"\t01jul2017\t"one"\n2\t2.469e+08\t\t"say "hi""\t02jul2017\t"zero"\n3\t3.704e+08\t.a\t"x,y"\t03jul2017\t"one"\n4\t4.938e+08\t0.25\t""\t04jul2017\t"zero"\n',
  );
  assert.equal(
    s.files.get("o3.csv").text,
    'id,s,g\n1,a b,1\n2,say "hi",0\n3,x,y,1\n4,,0\n',
  );
  assert.equal(s.files.get("o4.csv").text, '3;"x,y"\n4;""\n');
  // Stata 19: an existing file without replace is r(602).
  assert.equal(s.run("outsheet using o1.csv, comma").rc, 602);
});

test("collapse computes medians and percentiles with aweights, pweights and iweights", () => {
  const s = createConsoleSession();
  const cell = (command) => s.run(command).output.at(-1).lines.at(-1).trim();
  s.run(
    "clear\nset obs 4\ngenerate y = _n\ngenerate w = 1\nreplace w = 2 in 1",
  );
  // Stata 19: with pweights 2 1 1 1 the median is 2, p25 1 and p75 3.
  s.run("preserve");
  assert.equal(s.run("collapse (median) m=y (p25) a=y (p75) b=y [pw=w]").rc, 0);
  assert.equal(cell("display m[1] a[1] b[1]"), "213");
  s.run("restore\npreserve");
  // Stata 19: a cumulative weight that lands exactly on the point averages
  // the two values: aweights 2 0 1 1 give a median of 2.
  s.run("replace w = 0 in 2\ncollapse (median) m=y [aw=w]");
  assert.equal(cell("display m[1]"), "2");
  s.run("restore\npreserve");
  // Stata 19: iweights of .5 give a median of 2.5 and p25 of 1.5.
  s.run("replace w = .5\ncollapse (median) m=y (p25) a=y [iw=w]");
  assert.equal(cell('display m[1] " " a[1]'), "2.5 1.5");
  s.run("restore\npreserve");
  // Stata 19: a count with pweights is the sum of the weights.
  s.run("collapse (count) n=y [pw=w]");
  assert.equal(cell("display n[1]"), "5");
  s.run("restore");
  // Stata 19: sd is not allowed with pweights, r(135).
  assert.equal(s.run("collapse (sd) s=y [pw=w]").rc, 135);
});

test("merge update and replace on .dta files fill and overwrite as Stata does", () => {
  const right = dta(
    'clear\nset obs 4\ngenerate long id = _n + 1\ngenerate double v = _n * 10\nreplace v = . in 2\ngenerate str3 s = "u" + string(_n)\ngenerate byte r = _n\nlabel define reglbl 1 "east" 2 "west"\nlabel values r reglbl',
  );
  const left = dta(
    'clear\nset obs 4\ngenerate int id = _n\ngenerate byte v = _n\nreplace v = . in 3\ngenerate str1 s = "m"\nreplace s = "" in 2\ngenerate byte r = _n\nlabel define reglbl 1 "E" 2 "W"\nlabel values r reglbl',
  );
  const s = createConsoleSession();
  s.addData("left.dta", left);
  s.addData("right.dta", right);
  const out = s.run("use left, clear\nmerge 1:1 id using right, update");
  assert.equal(out.rc, 0);
  // Stata 19: the promotions, the label message and the update table.
  assert.deepEqual(out.output.at(-1).lines, [
    "(variable id was int, now long to accommodate using data's values)",
    "(variable v was byte, now double to accommodate using data's values)",
    "(variable s was str1, now str3 to accommodate using data's values)",
    "(label reglbl already defined)",
    "",
    "    Result                      Number of obs",
    "    -----------------------------------------",
    "    Not matched                             2",
    "        from master                         1  (_merge==1)",
    "        from using                          1  (_merge==2)",
    "",
    "    Matched                                 3",
    "        not updated                         0  (_merge==3)",
    "        missing updated                     0  (_merge==4)",
    "        nonmissing conflict                 3  (_merge==5)",
    "    -----------------------------------------",
  ]);
  // Stata 19: update fills s in id 2 and keeps the master's nonmissing v.
  assert.equal(
    s.run('display v[2] " " s[2] " " s[3] " " _merge[2]').output.at(-1)
      .lines[0],
    "2 u1 m 5",
  );
  s.run("use left, clear\nmerge 1:1 id using right, nogenerate update replace");
  // Stata 19: replace takes every nonmissing using value.
  assert.equal(
    s.run('display v[2] " " v[3] " " s[3] " " r[4]').output.at(-1).lines[0],
    "10 . u2 3",
  );
  // Stata 19: replace without update is r(198).
  assert.equal(
    s.run("use left, clear\nmerge 1:1 id using right, replace").rc,
    198,
  );
});

test("append, tostring, duplicates and mvdecode print Stata's messages", () => {
  const other = dta(
    'clear\nset obs 2\ngenerate long id = _n\ngenerate byte r = 1\nlabel define reglbl 1 "east"\nlabel values r reglbl',
  );
  const s = createConsoleSession();
  s.addData("other.dta", other);
  s.run(
    'clear\nset obs 3000\ngenerate int id = _n\ngenerate byte r = 1\nlabel define reglbl 1 "E"\nlabel values r reglbl',
  );
  // Stata 19.
  assert.deepEqual(s.run("append using other").output.at(-1).lines, [
    "(variable id was int, now long to accommodate using data's values)",
    "(label reglbl already defined)",
  ]);
  s.run("generate double inc = _n + 0.123\ngenerate h = mod(_n, 3)");
  assert.deepEqual(
    s.run("tostring inc, generate(inc_s) format(%9.2f) force").output.at(-1)
      .lines,
    [
      "inc_s generated as str7",
      "inc_s was forced to string; some loss of information",
    ],
  );
  assert.deepEqual(
    s.run("duplicates tag id, generate(dup)").output.at(-1).lines,
    ["", "Duplicates in terms of id"],
  );
  // Stata 19: the count has no thousands separator.
  assert.deepEqual(s.run("mvdecode h, mv(0)").output.at(-1).lines, [
    "           h: 1000 missing values generated",
  ]);
});
