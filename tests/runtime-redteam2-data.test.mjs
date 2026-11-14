// Return codes, r() results and refusals for the second red-team round on the
// data commands (13 November 2026). Expected codes and values were recorded
// from Stata 19 MP (version 17, set processors 1); the printed text is
// compared by the output cases encode-format-with-no-labels-used,
// duplicates-list-options-and-drop, list-abbreviate,
// label-define-empty-text-and-dot, tab1-headings-errors-and-weights,
// tabulate-cumulative-ties, codebook-blanks, blanks-inside-strings and
// egen-options-by-function. A test that expects a refusal checks the rule
// that an option Stata has and the runtime lacks is refused with r(198),
// never ignored and never reported as an error Stata would make.
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";
import { splitCommands } from "../src/runtime/dofile.js";

const last = (s, command) => s.run(command).output.at(-1).lines.at(-1);

test("duplicates drop returns r(N) beside r(N_drop)", () => {
  const s = createConsoleSession();
  s.run("clear\nset obs 5\ngenerate x = 1");
  assert.equal(s.run("duplicates drop x, force").rc, 0);
  // Stata 19: r(N_drop) = 4, r(N) = 5.
  assert.equal(last(s, "display r(N_drop)"), "4");
  assert.equal(last(s, "display r(N)"), "5");
  s.run("clear\nset obs 4\ngenerate id = _n");
  s.run("duplicates drop id, force");
  // Stata 19: no duplicates gives r(N_drop) = 0 and r(N) = 4.
  assert.equal(last(s, "display r(N_drop)"), "0");
  assert.equal(last(s, "display r(N)"), "4");
  // Stata 19: force without a varlist is r(101).
  assert.equal(s.run("duplicates drop, force").rc, 101);
});

test("duplicates list passes options naming variables outside its varlist to list", () => {
  const s = createConsoleSession();
  s.run(
    'clear\nset obs 6\ngenerate str5 s = word("b a c a b d", _n)\ngenerate x = mod(_n, 2)',
  );
  const out = s.run("duplicates list s, sepby(x)");
  assert.equal(out.rc, 0);
  assert.ok(out.output.at(-1).lines.some((line) => line.includes("| Group")));
});

test("list refuses abbreviate() outside 1 to 129 with r(198)", () => {
  const s = createConsoleSession();
  s.run("clear\nset obs 1\ngenerate x = 1");
  // Stata 19: "abbreviate() must be between 1 and 129", r(198).
  assert.equal(s.run("list x, abbreviate(0)").rc, 198);
  assert.equal(s.run("list x, abbreviate(130)").rc, 198);
  assert.equal(s.run("list x, abbreviate(129)").rc, 0);
});

test("label list leaves missing r(min) and r(max) for a label of extended missing values", () => {
  const s = createConsoleSession();
  s.run('clear\nlabel define z .a "only missing" .c "c"\nlabel list z');
  // Stata 19: r(min) = ., r(max) = ., r(hasemiss) = 1, r(k) = 2.
  assert.equal(last(s, "display r(min)"), ".");
  assert.equal(last(s, "display r(max)"), ".");
  assert.equal(last(s, "display r(hasemiss)"), "1");
  assert.equal(last(s, "display r(k)"), "2");
});

test("label define refuses ., and add refuses a changed value with r(180), leaving the label as it was", () => {
  const s = createConsoleSession();
  // Stata 19: "may not label .", r(198), and no label is made.
  assert.equal(s.run('label define dot 1 one . "sys"').rc, 198);
  assert.equal(s.run("label list dot").rc, 111);
  s.run("label define e 1 one");
  // Stata 19: "invalid attempt to modify label", r(180).
  assert.equal(s.run("label define e 3 three 1 uno, add").rc, 180);
  assert.deepEqual(s.run("label list e").output.at(-1).lines, [
    "e:",
    "           1 one",
  ]);
  // Stata 19: empty text removes a value under add as under modify.
  assert.equal(s.run('label define e 1 "", add').rc, 0);
  assert.deepEqual(s.run("label list e").output.at(-1).lines, ["e:"]);
});

test("tab1 leaves _rc for a failed table but returns 0, and passes refusals on", () => {
  const s = createConsoleSession();
  s.run(
    'clear\nset obs 20\ngenerate c = mod(_n, 2)\ngenerate str3 a = cond(_n < 8, "x", "y")',
  );
  // Stata 19: tab1 c a, mising prints "option mising not allowed" and the
  // do-file goes on; capture noisily tab1 then leaves _rc at 0.
  const run = s.run('tab1 c a, mising\ndisplay "continued"\ndisplay _rc');
  assert.equal(run.rc, 0);
  assert.equal(run.output.at(-1).lines.at(-1), "198");
  s.run("capture noisily tab1 c, nosuchopt");
  assert.equal(last(s, "display _rc"), "0");
  // Stata 19: pweights are refused by tab1's own syntax, r(101).
  assert.equal(s.run("tab1 c [pweight=c]").rc, 101);
  // Stata tabulates with aweights and iweights, and so does the runtime.
  assert.equal(s.run("tab1 c a [aweight=c]").rc, 0);
  assert.equal(s.run("tabulate c [iweight=c]").rc, 0);
  // What the runtime refuses, tab1 passes on rather than returning 0.
  for (const command of ["tab1 c, plot", "tabulate c, matcell(m)"]) {
    const out = s.run(command);
    assert.equal(out.rc, 198, command);
    assert.match(out.output.at(-1).lines.join("\n"), /not available/, command);
  }
  // Stata 19: fweights pass through tab1.
  assert.equal(s.run("tab1 c [fweight=c]").rc, 0);
});

test("egen takes only the options each function declares", () => {
  const s = createConsoleSession();
  s.run(
    'clear\nset obs 6\ngenerate g = mod(_n, 2)\ngenerate x = _n\ngenerate y = 7 - _n\ngenerate str1 t = "a"',
  );
  // Stata 19 return codes.
  const codes = [
    ["egen a = count(x), missing", 198],
    ["egen a = count(t), missing", 198],
    ["egen a = mean(x), missing", 198],
    ["egen a = max(x), mi", 198],
    ["egen a = rowmean(x y), by(g)", 190],
    ["egen a = concat(x y), by(g)", 190],
    ["egen a = tag(x), by(g)", 190],
    ["egen a = first(x)", 133],
    ["egen a = p50(x)", 133],
    ["egen a = rank(x), field track", 198],
    ["egen a = total(x), by(g) missing", 0],
    ["egen b = max(x), by(g) missing", 0],
    ["egen c = rowtotal(x y), missing", 0],
    ["egen d = rank(x), field", 0],
  ];
  for (const [command, rc] of codes)
    assert.equal(s.run(command).rc, rc, command);
  // Options and functions Stata has that the runtime lacks are refused.
  for (const command of [
    "egen e = std(x), mean(1) sd(2)",
    "egen e = seq(), from(2)",
    "egen e = group(g), label",
    "egen e = rank(x), unique",
    "egen e = rowmedian(x y)",
    "egen e = rownonmiss(t), strok",
    "egen e = concat(x y), decode",
  ]) {
    const out = s.run(command);
    assert.equal(out.rc, 198, command);
    assert.match(out.output.at(-1).lines.join("\n"), /not available/, command);
  }
});

test("the do-file reader keeps blanks inside strings", () => {
  const commands = splitCommands(
    'display "[  a]"\nlocal m `"p  q"\'\ngenerate str20 w = "  lead" + string(_n) ///\n   + "x"\n',
  );
  assert.equal(commands[0].text, 'display "[  a]"');
  assert.equal(commands[1].text, 'local m `"p  q"\'');
  // A continued command is one command, its string intact.
  assert.equal(commands.length, 3);
  assert.match(
    commands[2].text,
    /^generate str20 w = " {2}lead" \+ string\(_n\) +\+ "x"$/,
  );
  const s = createConsoleSession();
  // Stata 19: 3 and [  a].
  assert.equal(last(s, 'display length("  a")'), "3");
  assert.equal(last(s, 'display "[  a]"'), "[  a]");
});
