// Records what installed Stata does for the new runtime's two foundations:
// the syntax command (which the runtime's command grammar reimplements) and
// storage types (which the runtime's data store reimplements).
// tests/runtime-*.test.mjs compare src/runtime with this record, so the
// comparison runs without Stata.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { format } from "prettier";

// Variables every syntax case can name. Values do not matter to parsing.
export const SYNTAX_VARIABLES = [
  ["make", "str8"],
  ["price", "double"],
  ["mpg", "double"],
  ["rep78", "double"],
  ["weight", "double"],
  ["wage1", "double"],
  ["wage2", "double"],
  ["group", "double"],
  ["id", "double"],
];

// Each entry: a syntax declaration, the locals it can set, and command tails.
export const SYNTAX = [
  {
    id: "report",
    declaration:
      "varlist [if] [in] [, Detail MEANonly SEParator(integer 5) Format]",
    locals: [
      "varlist",
      "if",
      "in",
      "detail",
      "meanonly",
      "separator",
      "format",
    ],
    lines: [
      "price mpg",
      "pri",
      "wage*",
      "price-rep78",
      "_all",
      "*",
      "wage? m*",
      "price mpg price",
      "make price",
      "*e",
      "p*e",
      "price if mpg > 20 & rep78 < .",
      "price in 1/3",
      "price if mpg>20 in 2/4, detail",
      "price in 2/4 if mpg>20",
      "price   if   mpg  >  20",
      "price in 2",
      "price in f/l",
      "price in -2/l",
      "price in 4/2",
      "price in 1/99",
      "price in 0",
      "price, d",
      "price, det mean",
      "price, sep(3)",
      "price, separator( 7 )",
      "price, separator(x)",
      "price, separator(2.5)",
      "price, separator()",
      "price, sep",
      "price, detail(3)",
      "price, bogus",
      "",
      "nosuch",
      "w",
      "wag",
      "price [fw=mpg]",
      "price using f",
      "price = 3",
      "price, detail detail",
      "price,detail",
      "price , detail , meanonly",
      "price if",
      "price in",
      "price, MEAN",
      "price, me",
      "price, mean f",
      'price if make == "a, b"',
      "price if inlist(rep78, 1, 2), d",
      "price if mpg[1] > 2",
      "price mpg, sep(3) d",
      "price-nosuch",
      "rep78-price",
      "price i",
      "price, ",
      "price if mpg > 20, det if",
      "price if mpg > 20 if rep78 > 1",
      "price in 1/2 in 3/4",
      "price, sep (3)",
      "price, nodetail",
      "price mpg if price > mpg in 1/4 , f",
    ],
  },
  {
    id: "estimate",
    declaration:
      "[varlist(default=none numeric max=2)] [fweight aweight] [, noCONStant Level(cilevel) *]",
    locals: ["varlist", "weight", "exp", "constant", "level", "options"],
    lines: [
      "",
      "price",
      "price mpg rep78",
      "make",
      "price [fw=rep78]",
      "price [aweight = mpg*2], nocons",
      "price [pw=mpg]",
      "price [fweight=rep78]",
      "price [aw=rep78]",
      "price [w=rep78]",
      "price [freq=rep78]",
      "price [fweight rep78]",
      "price [fw=]",
      "price, level(90) robust vce(cluster group)",
      "price, l(101)",
      "price, l(9)",
      "price, level(99.5)",
      "price, nocon",
      "price, noc",
      "price, noconstant",
      "price, constant",
      "price if mpg>3",
      "price in 1/2",
      "price, robust nocons cluster(id)",
      "price [fw=rep78] , level(80)",
      "[fw=rep78]",
      ", robust",
    ],
  },
  {
    id: "assign",
    declaration: "newvarname =exp [if] [in]",
    locals: ["varlist", "typlist", "exp", "if", "in"],
    lines: [
      "x = price*2",
      "x=price*2 if mpg>20",
      "price = 1",
      "x",
      "x y = 1",
      "x == 1",
      "x = price == 2 in 1/2",
      "1x = 3",
      'x = "a=b"',
      "byte x = 1",
      "str5 x = make",
      "double x = price in 1 if mpg > 2",
      "x = cond(mpg >= 20, 1, 0)",
      "x = mpg != 3",
      "x = ",
      "_all = 1",
      "if = 1",
      "x = 1, replace",
      "pri = 1",
      "x:lbl = 1",
    ],
  },
  {
    id: "combine",
    declaration:
      'anything(name=spec id="specification") using/ [, GENerate(name) KEEPusing(string) REPLACE noLabel Title(string) SAVing(string asis) N(numlist) R(real 1.5)]',
    locals: [
      "spec",
      "using",
      "generate",
      "keepusing",
      "replace",
      "label",
      "title",
      "saving",
      "n",
      "r",
    ],
    lines: [
      "1:1 id using other",
      '1:1 id using "my file.dta", gen(_m) keepusing(price mpg)',
      "1:1 id",
      "using f",
      'm:1 id using f, title("a b") saving("x y", replace) n(1/3 5) r(2)',
      "m:1 id using f, nol",
      "m:1 id using f, nolabel replace",
      "m:1 id using f, label",
      "m:1 id using f, gen(1bad)",
      "m:1 id using f, gen(a b)",
      "m:1 id using f, r(abc)",
      "m:1 id using f, r(-2.50)",
      "m:1 id using f, r(1e2)",
      "m:1 id using f, n(1(2)9)",
      "m:1 id using f, n(1 2 to 6)",
      "m:1 id using f, n(5/1)",
      "m:1 id using f, n(1 2:8)",
      "m:1 id using f, n(1[3]10)",
      "m:1 id using f, n(a)",
      "m:1 id using f, n(1.5 .25 -3)",
      "m:1 id using f, title(a) title(b)",
      "m:1 id using f, title(a (b) c)",
      'm:1 id using f, title(`"a "b" c"\')',
      "m:1 id using f, ti( spaced  out )",
      "m:1 id using f.dta if id > 2",
      "m:1 id using",
      "m:1 id using f g",
    ],
  },
  {
    id: "group",
    declaration: "varname(numeric) [if] , BY(varlist) [ Generate(name) ]",
    locals: ["varlist", "if", "by", "generate"],
    lines: [
      "price, by(group)",
      "price",
      "price mpg, by(group)",
      "price, by(group id) g(z)",
      "make, by(group)",
      "price, by(nosuch)",
      "price, by(gro)",
      "price, by()",
      "price, g(z)",
      "price if mpg > 2, by(wage*)",
      "pr, by(group)",
    ],
  },
  {
    id: "names",
    declaration: "[namelist(min=1 max=3)] [, CLEAR]",
    locals: ["namelist", "clear"],
    lines: ["a b c", "a b c d", "", "a 1b", "a, clear", "a, CLEAR", "a, cle"],
  },
  {
    id: "lower",
    declaration: "[, replace Clear]",
    locals: ["replace", "clear"],
    lines: [", replace", ", rep", ", c", ", cl", "x", ", replace clear", ""],
  },
  {
    id: "open",
    declaration: "[anything] [using] [if] [in] [, *]",
    locals: ["anything", "using", "if", "in", "options"],
    lines: [
      "",
      "a b (c d) e",
      'using "x y.dta", clear',
      "a if b in 1/2 using c, d(e) f",
      'a "b if c" d',
      "a, b(c, d) e",
      "a = b",
      "using f",
      "a using b.dta",
      "a in 2",
    ],
  },
];

// Storage cases. Values are written as Stata would read them; the runtime
// parses the same text.
const gen = (name, values, type) => ({ op: "generate", name, values, type });
const sgen = (name, values, type) => ({
  op: "generate",
  name,
  values,
  type,
  string: true,
});
const rep = (name, values, range) => ({ op: "replace", name, values, range });
const srep = (name, values, range) => ({
  op: "replace",
  name,
  values,
  range,
  string: true,
});
const ones = (n) => Array(n).fill("1");
export const STORAGE = [
  {
    id: "generate-default-float",
    n: 6,
    steps: [gen("x", ["0.1", "1", "16777217", ".", ".a", "1e39"])],
  },
  {
    id: "generate-byte",
    n: 8,
    steps: [
      gen(
        "x",
        ["100", "101", "-127", "-128", "2.7", "-2.7", ".b", "0"],
        "byte",
      ),
    ],
  },
  {
    id: "generate-int",
    n: 5,
    steps: [gen("x", ["32740", "32741", "-32767", "-32768", "99.99"], "int")],
  },
  {
    id: "generate-long",
    n: 5,
    steps: [
      gen(
        "x",
        ["2147483620", "2147483621", "-2147483647", "-2147483648", "0.5"],
        "long",
      ),
    ],
  },
  {
    id: "generate-float-limits",
    n: 6,
    steps: [
      gen(
        "x",
        [
          "1.7014117331926443e38",
          "1.70141178e38",
          "-1.7014117331926443e38",
          "-1.8e38",
          "1e-46",
          ".z",
        ],
        "float",
      ),
    ],
  },
  {
    id: "generate-double",
    n: 5,
    steps: [
      gen(
        "x",
        [
          "0.1",
          "8.9884656743115785e307",
          "-8.9884656743115785e307",
          "1e-320",
          ".c",
        ],
        "double",
      ),
    ],
  },
  ...[
    ["byte-to-int", "byte", ["101", "1", "1"]],
    ["byte-to-long", "byte", ["40000", "1", "1"]],
    ["byte-to-double", "byte", ["3e9", "1", "1"]],
    ["byte-to-float", "byte", ["0.5", "1", "1"]],
    ["byte-fraction-large", "byte", ["16777217.5", "1", "1"]],
    ["byte-missing-kept", "byte", [".a", ".", "2"]],
    ["byte-negative", "byte", ["-128", "1", "1"]],
    ["int-to-long", "int", ["32741", "1", "1"]],
    ["int-to-float", "int", ["0.5", "1", "1"]],
    ["int-to-double", "int", ["-2147483648", "1", "1"]],
    ["long-to-double", "long", ["0.5", "1", "1"]],
    ["long-large", "long", ["2147483621", "1", "1"]],
    ["float-stays", "float", ["0.1", "16777217", "1e39"]],
    ["float-huge", "float", ["1e300", "1", "1"]],
    ["double-stays", "double", ["0.1", "1e300", "1"]],
  ].map(([id, type, values]) => ({
    id: "replace-" + id,
    n: 3,
    steps: [gen("x", ones(3), type), rep("x", values)],
  })),
  {
    id: "replace-range-ignores-unassigned",
    n: 3,
    steps: [gen("x", ones(3), "byte"), rep("x", ["300", "5", "6"], [2, 3])],
  },
  {
    id: "replace-range-promotes",
    n: 3,
    steps: [gen("x", ones(3), "byte"), rep("x", ["5", "300", "6"], [2, 2])],
  },
  {
    id: "string-default-width",
    n: 4,
    steps: [sgen("s", ["a", "abc", "", "ab"])],
  },
  {
    id: "string-all-empty",
    n: 2,
    steps: [sgen("s", ["", ""])],
  },
  {
    id: "string-truncates",
    n: 3,
    steps: [sgen("s", ["abcdef", "ab", "a"], "str2")],
  },
  {
    id: "string-wider-than-needed",
    n: 2,
    steps: [sgen("s", ["ab", "a"], "str10")],
  },
  {
    id: "string-replace-widens",
    n: 3,
    steps: [sgen("s", ["a", "b", "c"]), srep("s", ["a", "bcdef", "c"], [2, 2])],
  },
  {
    id: "string-replace-never-narrows",
    n: 2,
    steps: [sgen("s", ["abcdef", "b"]), srep("s", ["a", "b"])],
  },
  {
    id: "string-bytes",
    n: 2,
    steps: [sgen("s", ["é", "aé"])],
  },
  {
    id: "type-mismatch",
    n: 2,
    steps: [
      gen("x", ["1", "2"]),
      sgen("s", ["a", "b"]),
      srep("x", ["a", "b"]),
      rep("s", ["1", "2"]),
      sgen("t", ["a", "b"], "byte"),
      gen("u", ["1", "2"], "str3"),
      gen("x", ["1", "2"]),
    ],
  },
  {
    id: "names",
    n: 1,
    steps: [
      "_all",
      "if",
      "byte",
      "str5",
      "x_1",
      "a23456789012345678901234567890123",
      "a2345678901234567890123456789012",
      "_n",
      "_cons",
      "1x",
      "x.y",
      "X",
      "_",
      "using",
      "strL",
      "str",
      "in",
      "_pi",
      "float",
      "e",
      "with",
      "_b",
      "_x",
    ].map((name) => gen(name, ["1"])),
  },
  ...[
    ["double-to-float", "double", ["0.1", "0.5"], "float"],
    ["double-to-float-exact", "double", ["0.5", "2"], "float"],
    ["to-byte", "double", ["1", "200"], "byte"],
    ["to-byte-fits", "double", ["1", "100"], "byte"],
    ["fraction-to-int", "float", ["0.5", "2"], "int"],
    ["widen", "byte", ["1", "2"], "double"],
    ["float-to-long", "float", ["16777216", ".a"], "long"],
    ["numeric-to-string", "double", ["1", "2"], "str5"],
  ].flatMap(([id, from, values, to]) => [
    {
      id: "recast-" + id,
      n: 2,
      steps: [gen("x", values, from), { op: "recast", name: "x", type: to }],
    },
    {
      id: "recast-force-" + id,
      n: 2,
      steps: [
        gen("x", values, from),
        { op: "recast", name: "x", type: to, force: true },
      ],
    },
  ]),
  ...[false, true].map((force) => ({
    id: "recast-string" + (force ? "-force" : ""),
    n: 2,
    steps: [
      sgen("s", ["abcdef", "ab"]),
      { op: "recast", name: "s", type: "str2", force },
      sgen("t", ["a", "b"]),
      { op: "recast", name: "t", type: "str9", force },
      { op: "recast", name: "t", type: "byte", force },
    ],
  })),
  {
    id: "sort-numeric-missing",
    n: 7,
    steps: [
      gen("x", ["3", ".", "-1", ".b", "2.5", ".a", "0"], "double"),
      gen("k", ["1", "2", "3", "4", "5", "6", "7"], "byte"),
      { op: "sort", keys: ["x"] },
    ],
  },
  {
    id: "sort-string",
    n: 7,
    steps: [
      sgen("s", ["b", "B", "a", "", " a", "ab", "10"]),
      gen("k", ["1", "2", "3", "4", "5", "6", "7"], "byte"),
      { op: "sort", keys: ["s"] },
    ],
  },
  {
    id: "sort-two-keys",
    n: 6,
    steps: [
      gen("g", ["2", "1", "2", "1", "2", "1"], "byte"),
      gen("t", ["3", "3", "1", "2", "2", "1"], "byte"),
      { op: "sort", keys: ["g", "t"] },
    ],
  },
  {
    id: "gsort-descending",
    n: 5,
    steps: [
      gen("x", ["3", ".", "-1", ".a", "2"], "double"),
      { op: "gsort", keys: ["-x"] },
    ],
  },
  {
    id: "gsort-mixed",
    n: 6,
    steps: [
      gen("g", ["2", "1", "2", "1", "2", "1"], "byte"),
      gen("t", ["3", "3", "1", "2", "2", "1"], "byte"),
      { op: "gsort", keys: ["g", "-t"] },
    ],
  },
  {
    id: "gsort-ascending-only",
    n: 3,
    steps: [gen("x", ["3", "1", "2"], "byte"), { op: "gsort", keys: ["x"] }],
  },
  ...[
    ["replace-key", [rep("t", ["9", "9", "9", "9", "9", "9"])]],
    ["replace-first-key", [rep("g", ["9", "9", "9", "9", "9", "9"])]],
    ["replace-other", [rep("z", ["9", "9", "9", "9", "9", "9"])]],
    ["generate", [gen("w", ["9", "9", "9", "9", "9", "9"])]],
    ["drop-second-key", [{ op: "drop", names: ["t"] }]],
    ["drop-first-key", [{ op: "drop", names: ["g"] }]],
    ["drop-other", [{ op: "drop", names: ["z"] }]],
    ["rename-key", [{ op: "rename", from: "t", to: "time" }]],
    ["more-observations", [{ op: "obs", n: 8 }]],
    ["drop-observations", [{ op: "dropin", range: [2, 3] }]],
    ["order", [{ op: "order", names: ["z", "t"] }]],
    ["recast-key", [{ op: "recast", name: "t", type: "double" }]],
    ["sort-again-on-prefix", [{ op: "sort", keys: ["g"] }]],
  ].map(([id, steps]) => ({
    id: "sorted-after-" + id,
    n: 6,
    // Unique (g, t) pairs, so the order after sort is determined.
    steps: [
      gen("g", ["2", "1", "2", "1", "2", "1"], "byte"),
      gen("t", ["3", "3", "1", "2", "2", "1"], "byte"),
      gen("z", ["1", "2", "3", "4", "5", "6"], "byte"),
      { op: "sort", keys: ["g", "t"] },
      ...steps,
    ],
  })),
  {
    id: "variables",
    n: 2,
    steps: [
      gen("a", ["1", "2"], "byte"),
      sgen("b", ["x", "y"]),
      gen("c", ["3", "4"], "double"),
      gen("d", ["5", "6"], "long"),
      { op: "rename", from: "a", to: "b" },
      { op: "rename", from: "a", to: "alpha" },
      { op: "rename", from: "nosuch", to: "q" },
      { op: "rename", from: "c", to: "1c" },
      { op: "order", names: ["d", "b"] },
      { op: "order", names: ["nosuch"] },
      { op: "drop", names: ["nosuch"] },
      { op: "keep", names: ["d", "alpha", "c"] },
      { op: "obs", n: 1 },
      { op: "obs", n: 4 },
      { op: "dropin", range: [1, 1] },
      { op: "dropin", range: [3, 9] },
    ],
  },
];

const quote = (text) => '`"' + text + "\"'";
const numericWriter = (name) => [
  "forvalues j=1/`=_N' {",
  `file write out "$CASE" _tab "val" _tab "${name}" _tab "\`j'" _tab (string(${name}[\`j'], "%21x")) _n`,
  "}",
];

function storageDo(c, k) {
  const out = [
    `global CASE "${k}"`,
    "clear",
    `set obs ${c.n}`,
    // Stata sets _N to 0 when the last variable is dropped, so an anchor
    // keeps the observations while the source variable comes and goes.
    "quietly generate byte __anchor = 0",
  ];
  for (const [s, step] of c.steps.entries()) {
    let command;
    if (step.values) {
      out.push(
        step.string
          ? 'quietly generate str1 __src = ""'
          : "quietly generate double __src = .",
      );
      step.values.forEach((v, i) =>
        out.push(
          `quietly replace __src = ${step.string ? quote(v) : v} in ${i + 1}`,
        ),
      );
      command =
        step.op === "generate"
          ? `generate ${step.type ? step.type + " " : ""}${step.name} = __src`
          : `replace ${step.name} = __src${step.range ? ` in ${step.range.join("/")}` : ""}`;
    } else if (step.op === "recast")
      command = `recast ${step.type} ${step.name}${step.force ? ", force" : ""}`;
    else if (step.op === "sort" || step.op === "gsort")
      command = `${step.op} ${step.keys.join(" ")}`;
    else if (step.op === "drop" || step.op === "keep" || step.op === "order")
      command = `${step.op} ${step.names.join(" ")}`;
    else if (step.op === "rename") command = `rename ${step.from} ${step.to}`;
    else if (step.op === "obs") command = `set obs ${step.n}`;
    else if (step.op === "dropin") command = `drop in ${step.range.join("/")}`;
    out.push(
      `capture noisily ${command}`,
      "local rc = _rc",
      `file write out "$CASE" _tab "step" _tab "${s}" _tab "\`rc'" _n`,
    );
    if (step.values) out.push("capture drop __src");
  }
  out.push("capture drop __anchor");
  out.push(
    'file write out "$CASE" _tab "n" _tab "`=_N\'" _n',
    "local sorted : sortedby",
    'file write out "$CASE" _tab "sorted" _tab "`sorted\'" _n',
    "capture unab vars : _all",
    'if _rc local vars ""',
    "foreach v of local vars {",
    "local t : type `v'",
    "local f : format `v'",
    'file write out "$CASE" _tab "var" _tab "`v\'" _tab "`t\'" _tab "`f\'" _n',
    "forvalues j=1/`=_N' {",
    'if substr("`t\'", 1, 3) == "str" {',
    'file write out "$CASE" _tab "val" _tab "`v\'" _tab "`j\'" _tab "[" (`v\'[`j\']) "]" _n',
    "}",
    "else {",
    'file write out "$CASE" _tab "val" _tab "`v\'" _tab "`j\'" _tab (string(`v\'[`j\'], "%21x")) _n',
    "}",
    "}",
    "}",
  );
  return out;
}

// %21x output such as +1.999999999999aX-004; exponent digits are hexadecimal.
export function hexToDouble(text) {
  const t = text.trim();
  if (/^\.[a-z]?$/.test(t)) return t;
  const m = t.match(/^([+-])([01])\.([0-9a-f]{13})X([+-])([0-9a-f]{3})$/);
  if (!m) throw new Error("Unrecognised %21x value: " + text);
  const mantissa = Number(m[2]) + parseInt(m[3], 16) / 2 ** 52,
    exponent = (m[4] === "-" ? -1 : 1) * parseInt(m[5], 16),
    value = mantissa * 2 ** exponent;
  // The mantissa form 0.xxx with exponent -3ff is a subnormal or zero.
  const exact =
    m[2] === "0" ? (parseInt(m[3], 16) / 2 ** 52) * 2 ** -1022 : value;
  return (m[1] === "-" ? -1 : 1) * exact;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "stataverse-runtime-native-"),
  );
  const audit = [
    "version 17",
    "set processors 1",
    "set more off",
    'file open out using "syntax.tsv", write text replace',
  ];
  let caseNumber = 0;
  const syntaxIndex = [];
  for (const group of SYNTAX) {
    audit.push(
      `capture program drop t_${group.id}`,
      `program define t_${group.id}`,
      `syntax ${group.declaration}`,
      `foreach m in ${group.locals.join(" ")} {`,
      'file write out "$CASE" _tab "`m\'" _tab `"[``m\'\']"\' _n',
      "}",
      "end",
      "clear",
      "set obs 5",
      ...SYNTAX_VARIABLES.map(([name, type]) =>
        type.startsWith("str")
          ? `generate ${type} ${name} = "a"`
          : `generate ${type} ${name} = _n`,
      ),
    );
    for (const line of group.lines) {
      const k = caseNumber++;
      syntaxIndex.push({ group: group.id, line });
      audit.push(
        `global CASE "${k}"`,
        `capture noisily t_${group.id} ${line}`,
        "local rc = _rc",
        `file write out "$CASE" _tab "_rc" _tab "\`rc'" _n`,
      );
    }
  }
  audit.push(
    "file close out",
    'file open out using "storage.tsv", write text replace',
  );
  STORAGE.forEach((c, k) => audit.push(...storageDo(c, k)));
  audit.push("file close out", "exit, clear", "");
  await fs.writeFile(path.join(folder, "audit.do"), audit.join("\n"));
  await promisify(execFile)(
    "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
    ["-b", "do", "audit.do"],
    { cwd: folder, timeout: 120000 },
  );
  const read = async (name) =>
    (await fs.readFile(path.join(folder, name), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));

  const syntaxCases = syntaxIndex.map((c) => ({ ...c, rc: null, locals: {} }));
  for (const [k, name, ...rest] of await read("syntax.tsv")) {
    const c = syntaxCases[Number(k)];
    if (name === "_rc") c.rc = Number(rest[0]);
    else c.locals[name] = rest.join("\t").slice(1, -1);
  }
  const unfinished = syntaxCases.filter((c) => c.rc === null);
  if (unfinished.length)
    throw new Error(
      `Stata did not report ${unfinished.length} syntax cases, first: ${unfinished[0].line}. See ${folder}/audit.log`,
    );
  for (const c of syntaxCases) if (c.rc) c.locals = {};

  const storageCases = STORAGE.map((c) => ({
    ...c,
    rc: [],
    observations: null,
    sortedBy: [],
    variables: [],
  }));
  for (const [k, kind, ...rest] of await read("storage.tsv")) {
    const c = storageCases[Number(k)];
    if (kind === "step") c.rc[Number(rest[0])] = Number(rest[1]);
    else if (kind === "n") c.observations = Number(rest[0]);
    else if (kind === "sorted")
      c.sortedBy = (rest[0] || "").split(" ").filter(Boolean);
    else if (kind === "var")
      c.variables.push({
        name: rest[0],
        type: rest[1],
        format: rest[2],
        values: [],
      });
    else if (kind === "val") {
      const variable = c.variables.find((v) => v.name === rest[0]),
        text = rest.slice(2).join("\t");
      variable.values[Number(rest[1]) - 1] = variable.type.startsWith("str")
        ? text.slice(1, -1)
        : hexToDouble(text);
    }
  }
  const short = storageCases.filter(
    (c) => c.observations === null || c.rc.length !== c.steps.length,
  );
  if (short.length)
    throw new Error(
      `Stata did not finish ${short.length} storage cases, first: ${short[0].id}. See ${folder}/audit.log`,
    );
  await fs.writeFile(
    "tests/fixtures/stata-runtime.json",
    await format(
      JSON.stringify({
        source:
          "Recorded from installed Stata by tools/check-runtime-native.mjs under version 17. Numeric values were written with %21x and are exact doubles; missing values are the strings ., .a to .z.",
        syntaxVariables: SYNTAX_VARIABLES,
        declarations: Object.fromEntries(
          SYNTAX.map((g) => [g.id, g.declaration]),
        ),
        syntax: syntaxCases,
        storage: storageCases,
      }),
      { parser: "json" },
    ),
  );
  console.log(
    `Recorded ${syntaxCases.length} syntax and ${storageCases.length} storage cases from installed Stata.`,
  );
  await fs.rm(folder, { recursive: true, force: true });
}
