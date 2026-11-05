import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { format } from "prettier";
import { createHash } from "node:crypto";
import { PracticeSession } from "../src/engine.js";
const dataset = {
  id: "prefixes",
  name: "Invented prefix fixture",
  columns: ["hours", "attendance", "score"].map((name) => ({
    name,
    label: name,
    type: "numeric",
  })),
  rows: [
    { hours: 1, attendance: 60, score: 20 },
    { hours: 2, attendance: 70, score: 31 },
    { hours: 3, attendance: 80, score: 35 },
    { hours: 4, attendance: 90, score: 49 },
  ],
};
const sources = [
  [
    "direct-loop-stop",
    "generate double first=0\ngenerate double skipped=0\ncap forvalues j=1/3 {\nreplace first=first+1\nerror 459\nreplace skipped=skipped+1\n}\ngenerate double marker=_rc",
  ],
  [
    "captured-foreach",
    "capture foreach v in hours attendance {\ngenerate double once=1\n}\ngenerate double marker=_rc",
  ],
  [
    "block-around-loop",
    "capture {\nforvalues j=1/3 {\ngenerate double once=`j'\n}\n}\ngenerate double marker=_rc",
  ],
  [
    "noisy-in-capture",
    'capture {\nnoisily display "__SV_VISIBLE_captured"\nerror 459\n}\ngenerate double marker=_rc',
  ],
  [
    "nested-quiet-blocks",
    'quietly {\nnoisily {\ndisplay "__SV_VISIBLE_nested"\n}\ndisplay "__SV_VISIBLE_hidden"\n}',
  ],
  [
    "exit-rc",
    "capture drop absent\ncapture exit _rc\ngenerate double marker=_rc",
  ],
  [
    "empty-capture",
    "capture drop absent\ncapture if 0 {\ndrop hours\n}\ngenerate double marker=_rc",
  ],
  [
    "capture-local-in-block",
    "capture {\nlocal amount=2\ngenerate double value=`amount'\n}\ngenerate double marker=_rc",
  ],
  [
    "quoted-rc",
    'capture drop absent\ndisplay "__SV_VISIBLE_literal_rc"\ngenerate double marker=_rc',
  ],
  ["missing-drop", "capture drop absent\ngenerate double marker=_rc"],
  [
    "repeatable",
    "cap drop result\ngenerate double result=1\ncap drop result\ngenerate double result=2",
  ],
  ["atomic-drop", "capture drop hours absent\ngenerate double marker=_rc"],
  [
    "rc-persists",
    "cap drop absent\nlocal first=_rc\nqui count\nlocal second=_rc\ndi _rc\ngenerate double marker=`first'+`second'+_rc",
  ],
  ["nested-prefix", "cap cap drop absent\ngenerate double marker=_rc"],
  ["noisy-error", "capture noisily drop absent\ngenerate double marker=_rc"],
  [
    "quiet-regression",
    'quietly regress score hours\nquietly predict double fitted\nnoisily display "__SV_VISIBLE_regression"',
  ],
  [
    "confirm-numeric",
    "cap confirm numeric variable hours attendance\ngenerate double marker=_rc",
  ],
  ["confirm-new", "cap confirm new variable hours\ngenerate double marker=_rc"],
  [
    "confirm-new-valid",
    "cap confirm new variable created\ngenerate double marker=_rc",
  ],
  [
    "confirm-string-mismatch",
    "capture confirm string variable hours\ngenerate double marker=_rc",
  ],
  [
    "confirm-missing",
    "capture confirm variable absent\ngenerate double marker=_rc",
  ],
  [
    "partial-block",
    "capture {\ngenerate double first=1\ndrop absent\ngenerate double skipped=2\n}\ngenerate double marker=_rc",
  ],
  [
    "nested-block",
    "capture {\ncapture drop absent\ngenerate double inner=_rc\n}\ngenerate double marker=_rc",
  ],
  [
    "noisy-in-quiet",
    'quietly {\ndisplay "__SV_VISIBLE_hidden"\nnoisily display "__SV_VISIBLE_shown"\n}\ndisplay "__SV_VISIBLE_after"',
  ],
  [
    "quiet-in-noisy",
    'noisily {\nquietly display "__SV_VISIBLE_hidden"\ndisplay "__SV_VISIBLE_shown"\n}',
  ],
  ["quiet-then-noisy", 'qui noi di "__SV_VISIBLE_order"'],
  ["noisy-then-quiet", 'noi qui di "__SV_VISIBLE_order"'],
  [
    "colon-prefix",
    "cap: noi: confirm variable absent\ngenerate double marker=_rc",
  ],
  [
    "captured-loop",
    "cap forvalues j=1/3 {\ngenerate double once=`j'\n}\ngenerate double marker=_rc",
  ],
  [
    "captured-if",
    "capture if 1 {\ngenerate double first=1\nerror 459\ngenerate double skipped=2\n}\ngenerate double marker=_rc",
  ],
  [
    "rc-condition",
    "cap drop absent\nif _rc==111 {\ngenerate double found=_rc\n}\ngenerate double marker=_rc",
  ],
  [
    "capture-local",
    "capture local foo=absent\ngenerate double marker=_rc\ncapture local foo=2\ngenerate double value=`foo'",
  ],
  [
    "error-command",
    "generate double first=1\nerror 459\ngenerate double skipped=2",
  ],
  ["exit-error", "capture exit 459\ngenerate double marker=_rc"],
  ["exit-zero", "generate double first=1\nexit 0\ngenerate double skipped=2"],
  [
    "exit-zero-in-capture",
    "capture {\ngenerate double first=1\nexit\ngenerate double skipped=2\n}\ngenerate double after=3",
  ],
  [
    "block-rc",
    "capture drop absent\nquietly {\ngenerate double inside=_rc\n}\ngenerate double marker=_rc",
  ],
  [
    "capture-expression",
    "capture generate double invalid=absent\ngenerate double marker=_rc",
  ],
  [
    "prefix-macro",
    "local prefix cap\n`prefix' drop absent\ngenerate double marker=_rc",
  ],
];
const folder = await fs.mkdtemp(
  path.join(os.tmpdir(), "stataverse-prefix-native-"),
);
const audit = ["set processors 1", "set more off"];
for (const [i, [id, source]] of sources.entries()) {
  const native = [
    "version 16",
    "clear",
    "input double hours double attendance double score",
    "1 60 20",
    "2 70 31",
    "3 80 35",
    "4 90 49",
    "end",
    source,
    "",
  ];
  await fs.writeFile(path.join(folder, `case-${i}.do`), native.join("\n"));
  audit.push(
    `log using "visible-${i}.log", text replace name(visible)`,
    `capture noisily do "case-${i}.do"`,
    "local rc=_rc",
    "log close visible",
    `file open out using "code-${i}.txt", write text replace`,
    'file write out "`rc\'"',
    "file close out",
    `file open out using "data-${i}.tsv", write text replace`,
    "unab vars: _all",
    "foreach v of local vars {",
    'file write out "`v\'"',
    "forvalues j=1/4 {",
    "file write out _tab %24.17g (`v'[ `j' ])",
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
const cases = [];
for (const [i, [id, source]] of sources.entries()) {
  const columns = (
    await fs.readFile(path.join(folder, `data-${i}.tsv`), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => {
      const [name, ...values] = line.split("\t");
      return {
        name,
        values: values.map((v) => (v.trim() === "." ? null : Number(v))),
      };
    });
  const nativeCode = Number(
    await fs.readFile(path.join(folder, `code-${i}.txt`), "utf8"),
  );
  const visible = (
    await fs.readFile(path.join(folder, `visible-${i}.log`), "utf8")
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^__SV_VISIBLE_\w+$/.test(s));
  const session = new PracticeSession("prefixes", {
      prefixes: { data: dataset },
    }),
    output = session.run(source);
  const error = output.find((r) => r.kind === "error");
  assert.equal(
    error?.code || 0,
    nativeCode,
    id + " return code: " + error?.message,
  );
  assert.deepEqual(
    session.data.columns.map((c) => c.name),
    columns.map((c) => c.name),
    id + " columns",
  );
  for (const col of columns)
    session.data.rows.forEach((row, j) => {
      const a = row[col.name],
        b = col.values[j];
      if (a === null || b === null) assert.equal(a, b, id);
      else
        assert.ok(
          Math.abs(a - b) < 1e-8 * Math.max(1, Math.abs(b)),
          `${id} ${col.name}: ${a} != ${b}`,
        );
    });
  assert.deepEqual(
    output
      .filter(
        (r) =>
          r.kind === "display" &&
          !r.suppressed &&
          String(r.value).startsWith("__SV_VISIBLE_"),
      )
      .map((r) => r.value),
    visible,
    id + " visible output",
  );
  const replay = new PracticeSession("prefixes", {
    prefixes: { data: dataset },
  });
  for (const command of session.history)
    assert.ok(
      !replay.run(command).some((r) => r.kind === "error"),
      id + " replay",
    );
  assert.deepEqual(replay.data, session.data, id + " replay data");
  assert.equal(replay.returnCode, session.returnCode, id + " replay _rc");
  cases.push({ id, source, columns, returnCode: nativeCode, visible });
}
await fs.writeFile(
  "tests/fixtures/prefix-native.json",
  await format(JSON.stringify({ dataset, cases }), { parser: "json" }),
);
await fs.writeFile(
  "docs/verification/prefix-native.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      cases: cases.length,
      checks: [
        "return code",
        "dataset columns and values",
        "quiet/noisy visible output sentinels",
        "saved-history replay and captured return code",
      ],
      references: [
        "https://www.stata.com/manuals/pcapture.pdf",
        "https://www.stata.com/manuals/pquietly.pdf",
      ],
      limits: [
        "Selected examples only; installed executable provenance is not certified as an unmodified licensed vendor binary.",
        "Native logs remain outside the project.",
        "Browser limits, cancellation and malformed structural input are not swallowed by capture.",
      ],
      fixtureSha256: createHash("sha256")
        .update(await fs.readFile("tests/fixtures/prefix-native.json"))
        .digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ passed: cases.length }));
