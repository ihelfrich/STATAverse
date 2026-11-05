import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { format } from "prettier";
import { PracticeSession } from "../src/engine.js";
import { createDataset } from "../src/datasets.js";

const rows = Array.from({ length: 96 }, (_, j) => {
  const i = j + 1,
    g = (i % 3) + 1,
    h = Math.ceil(i / 3) % 2;
  const x = i / 9,
    z = (i % 7) / 5;
  return {
    g,
    h,
    x,
    z,
    y: 2 + x + 3 * g + 0.7 * g * x + 0.8 * h + (i % 11) / 9,
  };
});
// These observations exercise listwise deletion and out-of-sample predictions.
rows[0].y = null;
rows[1].x = null;
const dataset = {
  id: "factors",
  name: "Invented factor-variable comparison",
  columns: Object.keys(rows[0]).map((name) => ({
    name,
    type: "numeric",
    label: name,
  })),
  rows,
};
const specifications = [
  "i.g",
  "g##h",
  "g#h",
  "i.g#c.x",
  "i.g##c.x",
  "x i.g#c.x",
  "i.g x i.g#c.x",
  "c.x##c.z",
  "c.x##c.x",
  "ib2.g##h",
  "ibn.g",
  "i.g i.h g#h",
  "g#h x",
  "i.g##i.h##c.x",
  "i.g#c.x##c.z",
  "i.g##c.(x z)",
  "i.g##(c.x c.z)",
  "ib(last).g##c.x",
  "ib(freq).g##c.x",
  "ib9.g",
  "2.g#c.x",
  "c.x#c.x#c.x",
  "i.g##c.x if g!=3",
  "i.g##c.x in 3/70",
  "i.g#i.g",
  "c.x##c.z##c.x",
  "i.g##c.x#c.x",
  "i.g#c.x##c.x",
  "i.g##c.x c.z##i.g",
  "i.g##i.h if g!=1 | h!=0",
  "ib2.g##ib1.h##c.x",
  "i.g if g==2",
  "i.g##c.x if g==2",
];
const cases = specifications.flatMap((s, i) =>
  [false, true].map((robust) => ({
    id: `factor-${i}-${robust ? "robust" : "ols"}`,
    source: `regress y ${s}${robust ? ", robust" : ""}`,
    dataset,
  })),
);
for (const source of [
  "reg hours attendance##score",
  "reg hours c.attendance##c.score",
  "reg hours c.attendance##c.score, robust",
])
  cases.push({
    id: `reported-${cases.length}`,
    source,
    dataset: createDataset(),
  });
const folder = await fs.mkdtemp(
  path.join(os.tmpdir(), "stataverse-factor-native-"),
);
const wrapper = ["set processors 1", "set more off"];
for (const [index, item] of cases.entries()) {
  const names = item.dataset.columns
    .filter((c) => c.type === "numeric")
    .map((c) => c.name);
  const input = [
    "version 16",
    "clear",
    `input ${names.map((name) => "double " + name).join(" ")}`,
    ...item.dataset.rows.map((row) =>
      names.map((n) => row[n] ?? ".").join(" "),
    ),
    "end",
    item.source,
  ];
  input.push(
    "matrix B=e(b)",
    "matrix V=e(V)",
    "local names : colnames B",
    "local count=colsof(B)",
    `file open stats using "stats-${index}.tsv", write text replace`,
    "file write stats %24.17g (e(N)) _tab %24.17g (e(df_r)) _tab %24.17g (e(rss)) _tab %24.17g (e(r2)) _n",
    "file close stats",
    `file open coefs using "coefs-${index}.tsv", write text replace`,
    "forvalues j=1/`count' {",
    "local name : word `j' of `names'",
    "file write coefs \"`name'\" _tab %24.17g (B[1,`j']) _n",
    "}",
    "file close coefs",
    `file open cov using "cov-${index}.tsv", write text replace`,
    "forvalues j=1/`count' {",
    "forvalues k=1/`count' {",
    "file write cov %24.17g (V[`j',`k']) _tab",
    "}",
    "file write cov _n",
    "}",
    "file close cov",
    "predict double fit",
    "predict double resid, residuals",
    `file open predictions using "predictions-${index}.tsv", write text replace`,
    "forvalues j=1/`=_N' {",
    "file write predictions %24.17g (fit[`j']) _tab %24.17g (resid[`j']) _n",
    "}",
    "file close predictions",
  );
  await fs.writeFile(
    path.join(folder, `case-${index}.do`),
    input.join("\n") + "\n",
  );
  wrapper.push(
    `capture noisily do "case-${index}.do"`,
    "local rc=_rc",
    `file open code using "code-${index}.txt", write text replace`,
    'file write code "`rc\'"',
    "file close code",
  );
}
wrapper.push("exit, clear", "");
await fs.writeFile(path.join(folder, "audit.do"), wrapper.join("\n"));
await promisify(execFile)(
  "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
  ["-b", "do", "audit.do"],
  { cwd: folder, timeout: 90000 },
);
const number = (value) => (value.trim() === "." ? null : Number(value));
const canonical = (name) =>
  name.replace(/(\d+)(?:bn|b|o)\./g, "$1.").replace(/\bco\./g, "c.");
const near = (a, b, description) => {
  if (a === null || b === null) assert.equal(a, b, description);
  else
    assert.ok(
      Math.abs(a - b) <= 2e-8 * Math.max(1, Math.abs(b)),
      `${description}: ${a} != ${b}`,
    );
};
const fixtures = [];
for (const [index, item] of cases.entries()) {
  assert.equal(
    (await fs.readFile(path.join(folder, `code-${index}.txt`), "utf8")).trim(),
    "0",
    item.source,
  );
  const coefs = (
    await fs.readFile(path.join(folder, `coefs-${index}.tsv`), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => {
      const [name, b] = line.split("\t");
      return { name: canonical(name), b: number(b) };
    });
  const covariance = (
    await fs.readFile(path.join(folder, `cov-${index}.tsv`), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => line.trim().split("\t").map(number));
  const predictions = (
    await fs.readFile(path.join(folder, `predictions-${index}.tsv`), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => line.split("\t").map(number));
  const [n, df, sse, r2] = (
    await fs.readFile(path.join(folder, `stats-${index}.tsv`), "utf8")
  )
    .trim()
    .split("\t")
    .map(number);
  const session = new PracticeSession(item.dataset.id, {
    [item.dataset.id]: { data: item.dataset },
  });
  const result = session.run(item.source)[0];
  assert.equal(result.kind, "regress", item.source + ": " + result.message);
  const model = result.model;
  assert.equal(model.n, n, item.source + " N");
  assert.equal(model.df, df, item.source + " df");
  near(model.sse, sse, item.source + " SSE");
  near(model.r2, r2, item.source + " R2");
  for (const c of model.coefficients) {
    const j = coefs.findIndex((other) => other.name === c.name);
    assert.ok(j >= 0, item.source + " missing native term " + c.name);
    near(c.b, coefs[j].b, item.source + " " + c.name);
    if (df > 0)
      for (const [k, other] of model.coefficients.entries()) {
        const nativeK = coefs.findIndex((c) => c.name === other.name);
        near(
          model.covariance[model.coefficients.indexOf(c)][k],
          covariance[j][nativeK],
          item.source + " covariance " + c.name + "/" + other.name,
        );
      }
  }
  const generated = session.run(
    "predict double fit\npredict double resid, residuals",
  );
  assert.ok(
    generated.every((r) => r.kind === "predict"),
    item.source + " predict",
  );
  session.data.rows.forEach((r, i) => {
    near(r.fit, predictions[i][0], item.source + " prediction " + i);
    near(r.resid, predictions[i][1], item.source + " residual " + i);
  });
  fixtures.push({
    ...item,
    n,
    df,
    sse,
    r2,
    coefficients: coefs,
    covariance,
    predictions,
  });
}
await fs.writeFile(
  "tests/fixtures/factor-native.json",
  await format(
    JSON.stringify(
      {
        description:
          "Invented datasets; independently executed native Stata numerical output only.",
        cases: fixtures,
      },
      null,
      2,
    ),
    { parser: "json" },
  ),
);
await fs.writeFile(
  "docs/verification/factor-native.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      cases: fixtures.length,
      checks: [
        "N and residual degrees of freedom",
        "coefficients by expanded term name",
        "full covariance for retained terms when df > 0",
        "SSE and R-squared",
        "predict and residuals, including observations outside estimation sample",
      ],
      source: "https://www.stata.com/manuals/u11.pdf",
      limits: [
        "Selected fixtures only, not all factor-variable syntax or collinearity patterns.",
        "Native startup logs remain in a private temporary folder.",
        "Saturated fits have no inference in browser output.",
      ],
      fixtureSha256: createHash("sha256")
        .update(await fs.readFile("tests/fixtures/factor-native.json"))
        .digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    passed: fixtures.length,
    receipt: "docs/verification/factor-native.json",
  }),
);
