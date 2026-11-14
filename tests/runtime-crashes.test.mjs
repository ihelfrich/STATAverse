// Commands that once crashed or stopped with a false error (development plan,
// package A3). Each test names the input that failed.
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";
import { readDta } from "../src/console-dta.js";

function labor() {
  const s = createConsoleSession();
  s.reset("labor");
  return s;
}
const text = (out) => out.output.flatMap((o) => o.lines ?? []);
const coefficients = (lines) =>
  lines.filter((line) => /^ *(experience|near_college|_cons) \|/.test(line));

test("ivregress, first runs above 254 observations, on the main equation's sample", () => {
  const s = labor(),
    out = s.run(
      "ivregress 2sls wage experience (education = near_college) if female == 1, first",
    );
  assert.equal(out.rc, 0);
  // The first stage is regress on the IV estimation sample, which drops the
  // rows where the outcome is missing.
  const first = coefficients(text(out)).slice(0, 3),
    plain = coefficients(
      text(
        labor().run(
          "regress education experience near_college if female == 1 & !missing(wage)",
        ),
      ),
    );
  assert.equal(first.length, 3);
  assert.deepEqual(first, plain);
});

test("destring and tostring with replace work on a dataset of one variable", () => {
  const s = labor(),
    out = s.run(
      "keep id\ntostring id, replace\ndestring id, replace\nsummarize id",
    );
  assert.equal(out.rc, 0);
  assert.match(text(out).join("\n"), /id \|\s+600\s+300\.5/);
  assert.equal(out.memory.variables.length, 1);
});

test("destring and tostring keep the variable's place and label", () => {
  const s = labor();
  s.run("tostring education, replace");
  const before = s.run("describe").memory.variables.map((v) => v.name);
  const out = s.run("destring education, replace\ndescribe education");
  assert.equal(out.rc, 0);
  assert.deepEqual(
    out.memory.variables.map((v) => v.name),
    before,
  );
  assert.match(text(out).join("\n"), /education\s+byte.*Years of schooling/);
});

test("a dataset holding a strL exports and reads back", () => {
  const s = labor();
  const out = s.run(
    "keep in 1/5\ngenerate strL note = region if id != 3\nreplace note = note + note in 4",
  );
  assert.equal(out.rc, 0);
  const { bytes } = s.exportData();
  const raw = new TextDecoder("latin1").decode(bytes);
  // Four non-empty cells, each a GSO entry; the empty one has none.
  assert.equal(raw.match(/GSO/g).length, 4);
  // GSO, v (4 bytes), o (8), type (1), length (4), then the text and a null.
  assert.match(raw, /GSO[\s\S]{17}([A-Za-z]+)\1\0/);
  const back = readDta(bytes).variables.find((v) => v.name === "note");
  assert.equal(back.type, "strL");
  // The third cell is empty; the fourth is a region written twice.
  assert.equal(back.data[2], "");
  assert.equal(back.data.filter(Boolean).length, 4);
  const half = back.data[3].slice(0, back.data[3].length / 2);
  assert.equal(back.data[3], half + half);
});

test("nbreg on underdispersed data reaches the Poisson fit, as Stata does", async () => {
  const fs = await import("node:fs");
  const { Session } = await import("../src/runtime/session.js");
  const { addTextFile } = await import("../src/runtime/delimited.js");
  const record = JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/stata-nbreg-boundary.json", import.meta.url),
      "utf8",
    ),
  );
  const s = new Session();
  addTextFile(
    s,
    "d.csv",
    fs.readFileSync(
      new URL("../ZeroToHero/data/fulfillment_delays.csv", import.meta.url),
      "utf8",
    ),
  );
  const out = s.run(
    `import delimited using d.csv, clear\nencode supplier_tier, generate(supplier_id)\n${record.command}`,
  );
  assert.equal(out.rc, 0);
  const model = s.estimates;
  for (const [name, [b, se]] of Object.entries(record.coefficients)) {
    const j = model.names.indexOf(name);
    assert.ok(j >= 0, name);
    assert.ok(
      Math.abs(model.b[j] - b) <= 1e-6 * Math.max(1, Math.abs(b)),
      name,
    );
    assert.ok(
      Math.abs(Math.sqrt(model.V[j][j]) - se) <= 1e-7 * se,
      `${name} standard error`,
    );
  }
  assert.ok(Math.abs(s.results.e.ll - record.ll) < 1e-6);
  assert.ok(Math.abs(s.results.e.ll_c - record.ll_c) < 1e-6);
  assert.ok(Math.abs(s.results.e.chi2 - record.chi2) < 1e-5);
  const printed = out.output
    .flatMap((o) => o.lines)
    .join("\n")
    .replace(/\s+/g, " ");
  assert.match(printed, /\/lnalpha \| -?[\d.]+ \. \. \./);
  assert.match(printed, /alpha \| [\d.e-]+ \. \. \./);
  for (const text of record.printed.slice(1))
    assert.ok(printed.includes(text), text);
});
