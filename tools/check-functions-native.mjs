// Runs expression-function, subscript and by-prefix cases in installed Stata
// and records what Stata returned. tests/functions.test.mjs compares the
// browser interpreter with this record, so the comparison runs without Stata.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { format } from "prettier";

export const NUMERIC = [
  "cond(1,2,3)",
  "cond(0,2,3)",
  "cond(.,2,3)",
  "cond(.,2,3,4)",
  "cond(5,2,3,4)",
  "max(1,.,3)",
  "max(.,.)",
  "min(4,.,2)",
  "min(.)",
  "int(2.7)",
  "int(-2.7)",
  "trunc(-0.5)",
  "floor(-2.5)",
  "ceil(-2.5)",
  "ceil(2.1)",
  "sign(-3)",
  "sign(0)",
  "sign(.)",
  "mod(7,3)",
  "mod(-7,3)",
  "mod(7,0)",
  "mod(7,-3)",
  "mod(5.5,2)",
  "mod(.,2)",
  "log10(1000)",
  "log10(0)",
  'strlen("hello")',
  'length("")',
  'strpos("hello","l")',
  'strpos("hello","z")',
  'strpos("hello","")',
  'strpos("","a")',
  'real("12.5")',
  'real(" 3 ")',
  'real("abc")',
  'real("1e3")',
  'real("")',
  'real("1,000")',
  'real(".5")',
  'real("-.5e1")',
  'real("5.")',
  'real("+2")',
  'real("1 2")',
  "max(2,cond(1,5,6))",
];
export const STRING = [
  'upper("aBc1")',
  'strupper("z")',
  'lower("ABc")',
  'strlower("Q")',
  'strtrim("  a b  ")',
  'trim(" x ")',
  'ltrim("  a ")',
  'rtrim("  a  ")',
  'itrim("a   b  c")',
  'stritrim("  a  b ")',
  'substr("abcdef",2,3)',
  'substr("abcdef",-2,2)',
  'substr("abcdef",3,.)',
  'substr("abcdef",0,2)',
  'substr("abcdef",7,1)',
  'substr("abcdef",6,5)',
  'substr("abcdef",2,0)',
  'substr("abcdef",2,-1)',
  'substr("abcdef",.,2)',
  'substr("abcdef",-9,2)',
  'substr("abcdef",2.9,1.9)',
  'subinstr("a-b-c","-","+",.)',
  'subinstr("a-b-c","-","+",1)',
  'subinstr("a-b-c","-","",.)',
  'subinstr("abc","","x",.)',
  'subinstr("aaa","a","b",0)',
  'subinstr("aaa","aa","b",.)',
  'cond(1,"a","b")',
  'cond(.,"a","b")',
  '"a"+upper("b")',
  'strtrim(itrim("  x   y "))',
];
export const DATA_ROWS = [
  [2, 2, 4],
  [1, 3, 7],
  [3, 1, 9],
  [1, 1, 5],
  [2, 1, 2],
  [1, 2, null],
];
export const DATA = [
  [
    "bysort-n",
    "bysort g (t): generate double n=_n\nby g: generate double total=_N",
  ],
  [
    "lag-lead",
    "bysort g (t): generate double lag=x[_n-1]\nby g (t): generate double lead=x[_n+1]",
  ],
  [
    "first-last",
    "bysort g (t): generate double first=_n==1\nby g: generate double last=_n==_N",
  ],
  ["if-n", "bysort g (t): generate double one=1 if _n==1"],
  ["carry-forward", "sort g t\nreplace x=x[_n-1] if missing(x)"],
  [
    "running-sum",
    "sort g t\ngenerate double run=x\nby g: replace run=run[_n-1]+x if _n>1",
  ],
  ["not-sorted", "by g: generate double z=1"],
  ["sort-then-by", "sort g t\nby g: generate double z=_n"],
  ["sorted-on-prefix-only", "sort g\nby g (t): generate double z=_n"],
  [
    "replace-key-breaks-order",
    "sort g t\nreplace t=t+1\nby g (t): generate double z=_n",
  ],
  [
    "replace-key-keeps-prefix",
    "sort g t\nreplace t=t+1\nby g: generate double z=_N",
  ],
  ["by-sort-option", "by g (t), sort: generate double z=_n"],
  ["egen-under-by", "bysort g (t): egen double m=mean(x)"],
  ["in-with-by", "bysort g (t): generate double z=1 in 1/2"],
  [
    "whole-data-subscripts",
    "sort g t\ngenerate double prev=x[_n-1]\ngenerate double top=x[1]\ngenerate double bottom=x[_N]\ngenerate double beyond=x[_N+1]",
  ],
  ["drop-keeps-order", "sort g t\ndrop if x==.\nby g: generate double z=_n"],
  [
    "generate-keeps-order",
    "sort g t\ngenerate double y=1\nby g (t): generate double z=_n",
  ],
  ["if-subscript", "sort g t\ngenerate double same=1 if x==x[_n-1]"],
  [
    "by-replace-condition",
    "bysort g (t): generate double keepme=0\nby g: replace keepme=1 if _n==_N & _N>1",
  ],
  [
    "condition-sees-earlier-writes",
    "sort g t\nreplace x=0 if missing(x[_n-1]) & _n>1",
  ],
  [
    "fill-chain",
    "sort g t\ngenerate double y=x if t==1\nby g: replace y=y[_n-1] if missing(y)",
  ],
  ["bys-abbreviation", "bys g (t): gen double z=_n*10"],
  ["two-keys", "bysort g t: generate double z=_N\nby g: generate double w=_n"],
];

// Reporting commands under by leave only the last group's r() results in
// Stata, so each is compared with a collapse that computes the same numbers.
export const REPORTS = [
  [
    "by-summarize",
    "bysort g (t): summarize x",
    "collapse (count) n=x (mean) mean=x (sd) sd=x (min) min=x (max) max=x, by(g)",
  ],
  [
    "by-summarize-if",
    "bysort g (t): summarize x if t>1",
    "collapse (count) n=x (mean) mean=x (sd) sd=x (min) min=x (max) max=x if t>1, by(g)",
  ],
  [
    "by-count-within-group",
    "bysort g (t): count if _n<=2",
    "bysort g (t): generate byte k=_n<=2\ncollapse (sum) n=k, by(g)",
  ],
  [
    "by-count-missing",
    "bysort g (t): count if missing(x)",
    "generate byte k=missing(x)\ncollapse (sum) n=k, by(g)",
  ],
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "stataverse-functions-native-"),
  );
  const audit = [
    "version 16",
    "set processors 1",
    "set more off",
    'file open out using "scalar.txt", write text replace',
  ];
  for (const e of NUMERIC)
    audit.push(
      `capture file write out "N" _tab %24.17g (${e}) _n`,
      'if _rc file write out "E" _tab "`=_rc\'" _n',
    );
  for (const e of STRING)
    audit.push(
      `capture file write out "S" _tab "[" (${e}) "]" _n`,
      'if _rc file write out "E" _tab "`=_rc\'" _n',
    );
  audit.push("file close out");
  const programs = [
    ...DATA.map(([, source]) => source),
    ...REPORTS.map(([, , native]) => native),
  ];
  for (const [i, source] of programs.entries()) {
    await fs.writeFile(
      path.join(folder, `case-${i}.do`),
      [
        "version 16",
        "clear",
        "input double g double t double x",
        ...DATA_ROWS.map((r) => r.map((v) => v ?? ".").join(" ")),
        "end",
        source,
        "",
      ].join("\n"),
    );
    audit.push(
      `capture do "case-${i}.do"`,
      "local rc=_rc",
      `file open out using "data-${i}.tsv", write text replace`,
      'file write out "`rc\'" _n',
      "unab vars: _all",
      "foreach v of local vars {",
      'file write out "`v\'"',
      "forvalues j=1/`=_N' {",
      "file write out _tab %24.17g (`v'[`j'])",
      "}",
      "file write out _n",
      "}",
      "file close out",
    );
  }
  audit.push("exit, clear", "");
  await fs.writeFile(path.join(folder, "audit.do"), audit.join("\n"));
  await promisify(execFile)(
    "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
    ["-b", "do", "audit.do"],
    { cwd: folder, timeout: 90000 },
  );
  const scalar = (await fs.readFile(path.join(folder, "scalar.txt"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const expressions = [...NUMERIC, ...STRING];
  if (scalar.length !== expressions.length)
    throw new Error(
      `Stata wrote ${scalar.length} scalar results for ${expressions.length} cases.`,
    );
  const scalarCases = expressions.map((expression, k) => {
    const [kind, text] = scalar[k];
    if (kind === "E") return { expression, error: Number(text) };
    if (kind === "S") return { expression, expected: text.slice(1, -1) };
    return {
      expression,
      expected: text.trim() === "." ? null : Number(text),
    };
  });
  const dataCases = [];
  const ids = [
    ...DATA.map(([id, source]) => ({ id, source })),
    ...REPORTS.map(([id, source, native]) => ({ id, source, native })),
  ];
  for (const [i, { id, source, native }] of ids.entries()) {
    const [code, ...lines] = (
      await fs.readFile(path.join(folder, `data-${i}.tsv`), "utf8")
    )
      .trim()
      .split("\n");
    dataCases.push({
      id,
      source,
      ...(native ? { native } : {}),
      code: Number(code),
      columns: lines.map((line) => {
        const [name, ...values] = line.split("\t");
        return {
          name,
          values: values.map((v) => (v.trim() === "." ? null : Number(v))),
        };
      }),
    });
  }
  await fs.rm(folder, { recursive: true });
  await fs.writeFile(
    "tests/fixtures/stata-functions.json",
    await format(
      JSON.stringify({
        source:
          "Executed tools/check-functions-native.mjs with installed Stata (version 16 semantics); synthetic values only, no global installation changes.",
        rows: DATA_ROWS,
        scalar: scalarCases,
        data: dataCases.filter((c) => !c.native),
        reports: dataCases.filter((c) => c.native),
      }),
      { parser: "json" },
    ),
  );
  console.log(
    `Recorded ${scalarCases.length} scalar, ${DATA.length} data and ${REPORTS.length} report cases.`,
  );
}
