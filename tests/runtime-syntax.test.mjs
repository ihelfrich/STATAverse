import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applySyntax, parseDeclaration } from "../src/runtime/syntax.js";
import { parseNumlist } from "../src/runtime/numlist.js";
import { expandVarlist } from "../src/runtime/varlist.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/stata-runtime.json", import.meta.url),
    "utf8",
  ),
);
const context = {
  names: fixture.syntaxVariables.map(([name]) => name),
  types: Object.fromEntries(fixture.syntaxVariables),
  n: 5,
  level: 95,
};

// Stata's syntax compiles if and =exp, so it rejects an expression that
// names a missing variable or has the wrong type. The runtime leaves that to
// its expression compiler, which is not part of this module. These cases are
// compared once that compiler is attached.
const NEEDS_EXPRESSIONS = new Set([
  'assign|x = "a=b"',
  "assign|str5 x = make",
  "open|a if b in 1/2 using c, d(e) f",
]);

test("command lines parse as Stata's syntax command parses them", () => {
  let compared = 0;
  for (const c of fixture.syntax) {
    const key = `${c.group}|${c.line}`;
    if (NEEDS_EXPRESSIONS.has(key)) continue;
    let code = 0,
      locals = {};
    try {
      locals = applySyntax(
        fixture.declarations[c.group],
        c.line,
        context,
      ).locals;
    } catch (error) {
      if (error.name !== "StataError") throw error;
      code = error.code;
    }
    assert.equal(code, c.rc, `${key}: return code`);
    if (c.rc) continue;
    // Stata leaves a trailing blank on a clause that another clause follows.
    for (const [name, value] of Object.entries(c.locals))
      assert.equal(
        locals[name] ?? "",
        value.trimEnd(),
        `${key}: local ${name}`,
      );
    compared++;
  }
  assert.ok(compared >= 88, `only ${compared} accepted lines were compared`);
  const skipped = fixture.syntax.filter((c) =>
    NEEDS_EXPRESSIONS.has(`${c.group}|${c.line}`),
  );
  assert.equal(skipped.length, NEEDS_EXPRESSIONS.size);
});

test("the expression hook sees every if, =exp and weight expression", () => {
  const seen = [];
  const result = applySyntax(
    "newvarname =exp [if] [in] [fweight]",
    "double z = price * 2 if mpg > 20 in 2/4 [fw = rep78]",
    { ...context, expression: (text, clause) => seen.push([clause, text]) },
  );
  assert.deepEqual(seen, [
    ["exp", "price * 2"],
    ["if", "mpg > 20"],
    ["weight", "rep78"],
  ]);
  assert.deepEqual(result.varlist, ["z"]);
  assert.deepEqual(result.types, ["double"]);
  assert.deepEqual(result.in, [2, 4]);
  assert.deepEqual(result.weight, { type: "fweight", exp: "rep78" });
  assert.throws(
    () =>
      applySyntax("varlist [if]", "price if nosuch > 1", {
        ...context,
        expression: () => {
          throw Object.assign(new Error("nosuch not found"), {
            name: "StataError",
            code: 111,
          });
        },
      }),
    { code: 111 },
  );
});

test("structured results carry typed option values", () => {
  const { options } = applySyntax(
    "varlist [, Detail SEParator(integer 5) BY(varlist) N(numlist) Level(cilevel) noCONStant *]",
    "price, by(wage*) n(1/3) sep(2) nocons vce(robust)",
    context,
  );
  assert.deepEqual(options, {
    by: ["wage1", "wage2"],
    n: [1, 2, 3],
    separator: 2,
    constant: false,
    level: 95,
    "*": ["vce(robust)"],
  });
});

test("declarations record minimum abbreviations and requirements", () => {
  const decl = parseDeclaration(
    "varname(numeric) [if] , BY(varlist) [ Generate(name) noLabel replace ]",
  );
  assert.deepEqual(
    decl.options.map((o) => [o.name, o.minimum, o.kind, o.required]),
    [
      ["by", 2, "varlist", true],
      ["generate", 1, "name", false],
      ["label", 1, "off", false],
      ["replace", 7, "flag", false],
    ],
  );
  assert.equal(decl.positional.kind, "varname");
  assert.equal(decl.positional.specs.numeric, true);
  assert.throws(() => parseDeclaration("varlist [, Bad(colour)]"));
});

test("number lists and variable lists reject malformed input", () => {
  assert.deepEqual(parseNumlist("0(0.1)0.3"), [0, 0.1, 0.2, 0.3]);
  assert.deepEqual(parseNumlist("10 8 to 2"), [10, 8, 6, 4, 2]);
  for (const text of ["1/", "1(0)3", "to 3", "1 to 3", "1(2", "1(-1)3"])
    assert.throws(() => parseNumlist(text), { code: 121 }, text);
  const names = context.names;
  assert.deepEqual(expandVarlist("wage~", ["wage1"]), ["wage1"]);
  assert.throws(() => expandVarlist("wage~", names), { code: 111 });
  assert.throws(() => expandVarlist("i.group", names), { code: 101 });
  assert.throws(() => expandVarlist("L.price", names), { code: 101 });
  assert.throws(() => expandVarlist("price-", names), { code: 198 });
});

test("an option listed after a bar is recognised and refused, not ignored", () => {
  const declaration = "varlist [, Detail | ROW COLumn Level(cilevel)]";
  assert.deepEqual(applySyntax(declaration, "price, detail", context).options, {
    detail: true,
  });
  for (const line of ["price, row", "price, col", "price, level(90)"])
    assert.throws(() => applySyntax(declaration, line, context), {
      code: 198,
      message: /not available in the browser yet/,
    });
  assert.throws(() => applySyntax(declaration, "price, bogus", context), {
    code: 198,
    message: /not allowed/,
  });
});
