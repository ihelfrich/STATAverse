// Recheck, expression group: what the recorded Results text cannot hold.
// Every expected value was recorded from Stata 19 (StataMP, run in batch
// under version 17 with set processors 1); the cases whose printed text
// can be compared are in tools/output-cases.txt (expr-*).
import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleSession } from "../src/console-session.js";
import { StataError } from "../src/runtime/errors.js";
import { ERROR_MARK } from "../src/runtime/errors.js";
import { FUNCTIONS } from "../src/runtime/functions.js";
import { stataMatch, stataPattern } from "../src/runtime/stata-regex.js";

// The regular-expression cases here were recorded under version 17, where
// regexm() reads patterns with Spencer's library.
function run(source) {
  const session = createConsoleSession();
  session.run("version 17");
  const result = session.run(source, { doFile: true });
  return result.output.map((o) => ({
    command: o.command,
    rc: o.rc,
    lines: o.lines.map((line) =>
      line.startsWith(ERROR_MARK) ? line.slice(ERROR_MARK.length) : line,
    ),
  }));
}
const lastLines = (source) => run(source).at(-1).lines;
// A number as %21x prints it, +1.1b614b0f52819X-003.
const hex = (text) => {
  const m = /^([+-])1\.([0-9a-f]{13})X([+-]\d{3})$/.exec(text);
  return (
    (m[1] === "-" ? -1 : 1) *
    (1 + parseInt(m[2], 16) / 2 ** 52) *
    2 ** Number(m[3])
  );
};
const close = (actual, expected, tolerance = 1e-10) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.abs(expected),
    `${actual} is not ${expected}`,
  );
const call = (name, ...args) => FUNCTIONS[name].fn(...args);

test("regexm() reads a long string without exhausting the stack", () => {
  // Stata: gen strL big = "ab" * 20000; regexm(big, "^(ab)*$") is 1 and
  // regexs(0) holds all 40000 bytes.
  const out = lastLines(`clear
set obs 1
gen strL big = "ab" * 20000
gen m = regexm(big, "^(ab)*" + char(36))
gen k = strlen(regexs(0))
display m[1] " " k[1]`);
  assert.deepEqual(out, ["1 40000"]);
});

test("regexm() and regexs() over 10,000 observations, as Stata gives them", () => {
  const started = Date.now(),
    output = run(`clear
set obs 10000
gen s = "item " + string(_n) + "-abc"
gen n = regexs(1) if regexm(s, "([0-9]+)-([a-z]+)" + char(36))
count if n == string(_n)
gen long2 = regexm(substr(s * 300, 1, 2000), "^(item [0-9]+-abc)+" + char(36))
count if long2`);
  // Stata: 10,000 and 9.
  assert.deepEqual(output.at(-3).lines, ["  10,000"]);
  assert.deepEqual(output.at(-1).lines, ["  9"]);
  assert.ok(Date.now() - started < 20000);
});

test("a regular expression that would run for ever is refused as a StataError", () => {
  const program = stataPattern("(a|aa)*(b|c)").program;
  assert.throws(
    () => stataMatch(program, "a".repeat(40)),
    (error) => error instanceof StataError && error.code === 901,
  );
});

test("Spencer's patterns: what is literal, what is an operator", () => {
  // Each value is regexm()'s in Stata 19.
  const cases = [
    ["GA 30303", "[0-9]{5}", 0],
    ["a{2}", "a{2}", 1],
    ["a1", "\\d", 0],
    ["ad", "\\d", 1],
    ["a b", "a\\sb", 0],
    ["A", "[[:upper:]]", 0],
    [":]", "[[:upper:]]", 1],
    ["a^b", "a^b", 0],
    ["a^b", "a\\^b", 1],
    ["a\nb", "a.b", 1],
    ["a\nb", "a$", 0],
    ["café", "^caf.$", 0],
    ["café", "^caf..", 1],
    ["é", "^[é]$", 0],
    ["b", "[a-c-e]", 1],
    ["-", "[a-c-e]", 0],
    ["d", "[a-c-e]", 1],
    ["]x", "[]]x", 1],
    ["", "^$", 1],
    ["x", "^?x", 1],
  ];
  for (const [s, pattern, expected] of cases)
    assert.equal(
      call("regexm", { version: 17 }, s, pattern),
      expected,
      `regexm("${s}", "${pattern}")`,
    );
});

test("Spencer's messages for patterns it cannot read, in regcomp's order", () => {
  const cases = [
    ["x**", "nested *?+"],
    ["a+?", "nested *?+"],
    ["(a)*+", "nested *?+"],
    ["(a*)*", "*+ operand could be empty"],
    ["(a?)+", "*+ operand could be empty"],
    ["^*", "*+ operand could be empty"],
    ["[b-a]", "invalid [] range"],
    ["[abc", "unmatched []"],
    ["[]", "unmatched []"],
    ["(abc", "unterminated ()"],
    ["abc)", "unmatched ()"],
    ["abc\\", "trailing \\"],
    ["((((((((((a))))))))))", "too many ()"],
    ["*a", "?+* follows nothing"],
    ["(?i)abc", "?+* follows nothing"],
  ];
  for (const [pattern, message] of cases) {
    const notes = [],
      state = { version: 17, note: (line) => notes.push(line) };
    assert.equal(call("regexm", state, "x", pattern), 0);
    assert.deepEqual(notes, [`regexp: ${message}`], pattern);
  }
});

test("regexs() after an unreadable pattern or regexr() asks for regexm()", () => {
  const notes = [],
    state = { version: 17, note: (line) => notes.push(line) };
  call("regexm", state, "abc", "(a)");
  assert.equal(call("regexs", state, 1), "a");
  call("regexr", state, "xbx", "(b)", "Q");
  assert.equal(call("regexs", state, 1), "");
  assert.deepEqual(notes, [
    "a regular expression match function must be executed prior to retrieving a subexpression",
    "regexm required",
  ]);
});

test("the noncentral chi-squared, F and t functions Stata 19 has", () => {
  close(call("nchi2den", 3, 2, 1.5), hex("+1.12d871001ea0dX-003"));
  close(call("nchi2den", 1, 3, 0.01), hex("+1.cc4ef5b5a0898X-001"));
  close(call("nchi2tail", 3, 2, 1.5), hex("+1.b2059db0689a1X-001"));
  close(call("nchi2tail", 4, 10, 40), hex("+1.2f9f328b4f36dX-009"));
  close(call("invnchi2tail", 3, 2, 0.3), hex("+1.8c0f44cf3e076X+002"));
  close(call("invnchi2tail", 4, 10, 1e-8), hex("+1.471e00d044312X+006"));
  close(call("invnF", 2, 10, 3, 0.5), hex("+1.13a857d3eb1f0X+001"));
  close(call("invnF", 3, 7, 2, 0.99), hex("+1.adc0529457377X+003"));
  close(call("invnt", 10, 1, 0.5), hex("+1.0695a57a5e84aX+000"));
  close(call("invnt", 5, 2, 0.01), hex("-1.6de8744682659X-002"));
});

test("the derivatives of gammap() in x", () => {
  close(call("dgammapdx", 2, 1.5), hex("+1.56ba595b88516X-002"));
  close(call("dgammapdxdx", 2, 1.5), hex("-1.c8f87724b5c1eX-004"));
  close(call("dgammapdadx", 2, 1.5), hex("-1.7be3dd50aabadX-008"));
  close(call("dgammapdadx", 0.5, 0.2), hex("+1.767e04f1676b6X-002"));
});

test("a function Stata has that the browser does not is refused, not unknown", () => {
  const output = run(
    "capture noisily display tukeyprob(3, 10, 2)\ndisplay _rc",
  );
  assert.deepEqual(output.at(-1).lines, ["198"]);
});

test("the derivatives of gammap() in a", () => {
  // Stata 19, list with %21.0g. Where Stata's own figure is off (as at
  // a = 3, x = 10, by 3e-7, against a 40-digit evaluation), it is not
  // used here.
  const cases = [
    [2, 1.5, -0.3134886378250792971, 0.1005891983926435751],
    [0.5, 0.1, -0.8229360977954037759, 1.658631294712176851],
    [1, 1, -0.4317297106348987334, 0.0336180353001021837],
    [3, 0.5, -0.0285202358788289347, 0.0526886081780657406],
    [10, 9, -0.1270365119242686802, 0.01360468958046019],
    [0.01, 0.5, -0.565545911588379524, -0.5677203173183332785],
    [50, 45, -0.0455432921401243973, 0.0048080033241702062],
    [50, 60, -0.0212849927863494673, -0.0038864838466260987],
    [200, 210, -0.0216198810145952908, -0.001055232261780864],
  ];
  for (const [a, x, first, second] of cases) {
    close(call("dgammapda", a, x), first, 1e-9);
    close(call("dgammapdada", a, x), second, 1e-8);
  }
  // Below x = 0 both are 0; a <= 0 is missing.
  assert.equal(call("dgammapda", 5, -1), 0);
  assert.equal(call("dgammapdada", 5, 0), 0);
  assert.ok(call("dgammapda", 0, 2) > 8e307);
});

test("a repeat before a byte, a set or the end backs off at once", () => {
  // Stata 19 counts 0 for each at once; the browser refused the first two
  // as too complex.
  const started = Date.now(),
    output = run(`clear
set obs 1
gen strL s = "x" + 40000*"a"
count if regexm(s, ".*x$")
replace s = 5000*"abcdefgh"
count if regexm(s, "[a-z ]*[0-9]$")
count if regexm(s, "[a-z ]*[0-9]")`);
  assert.deepEqual(
    output.filter((o) => o.command.startsWith("count")).map((o) => o.lines),
    [["  0"], ["  0"], ["  0"]],
  );
  assert.ok(Date.now() - started < 5000);
});

test("bytes of one character cut apart join back into it", () => {
  // Stata 19: 1, and 1 2 1 1.
  const output = run(`clear
set obs 1
gen s = "é"
display regexm(s, "^(.)(.)$")
display (regexs(1) + regexs(2)) == "é"
gen a = regexs(1)
gen b = regexs(2)
gen c = a + b
display strlen(a) " " strlen(c) " " (c == "é") " " ustrlen(c)`);
  assert.deepEqual(output.at(-5).lines, ["1"]);
  assert.deepEqual(output.at(-1).lines, ["1 2 1 1"]);
});

test("under quietly, regexm()'s messages show, and count's result after them", () => {
  // Stata 19 prints the messages for each of these; count alone of them
  // goes on to print its result.
  const output = run(`clear
set obs 2
gen s = "abc"
gen x = _n
quietly count if regexm(s, "(") | 1
quietly summarize x if regexm(s, "(") | 1
quietly tab x if regexm(s, "(") | 1
quietly scalar k = regexm("a", "(")`);
  const message = "regexp: unterminated ()";
  assert.deepEqual(output.at(-4).lines, [message, message, "  2"]);
  assert.deepEqual(output.at(-3).lines, [message, message]);
  assert.deepEqual(output.at(-2).lines, [message, message]);
  assert.deepEqual(output.at(-1).lines, [message]);
});
