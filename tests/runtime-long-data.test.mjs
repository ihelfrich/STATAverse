// Estimation on long data. Lists as long as the data were spread into
// Math.max and Math.min, which passes every observation as an argument and
// overflows the stack: poisson stopped with a RangeError somewhere between
// 95,000 and 133,000 observations. The runtime now loops over such lists.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

const text = (out) => out.output.flatMap((o) => o.lines ?? []).join("\n");

function longPanel(n = 160000) {
  const s = createConsoleSession();
  const made = s.run(
    [
      "clear",
      `set obs ${n}`,
      "set seed 20261123",
      "generate long firm = ceil(_n / 16)",
      "generate int year = 2004 + mod(_n, 16)",
      "generate x = rnormal()",
      "generate byte d = runiform() > .5",
      "generate y = rpoisson(exp(.2 + .3 * x + .1 * d))",
      "generate byte any = y > 0",
    ].join("\n"),
  );
  assert.equal(made.rc, 0, text(made));
  return s;
}

test("poisson fits 160,000 observations instead of overflowing the stack", () => {
  const s = longPanel();
  for (const command of [
    "poisson y x d",
    "poisson y x d i.year, vce(cluster firm)",
    "poisson y x d, noconstant",
  ]) {
    const out = s.run(command);
    assert.equal(out.rc, 0, `${command}\n${text(out)}`);
    assert.match(text(out), /Number of obs\s+=\s+160,000/, command);
  }
  // The coefficients are those of the model that made the data.
  const shown = s.run("poisson y x d\ndisplay %6.3f _b[x] %6.3f _b[d]");
  const [bx, bd] = text(shown).trim().split("\n").at(-1).trim().split(/\s+/);
  assert.ok(Math.abs(Number(bx) - 0.3) < 0.02, bx);
  assert.ok(Math.abs(Number(bd) - 0.1) < 0.02, bd);
});

test("the estimators of a firm-year analysis run on 160,000 observations", () => {
  const s = longPanel();
  for (const command of [
    "xtset firm year",
    "generate lx = L.x",
    "regress y x d i.year, vce(cluster firm)",
    "test x d",
    "areg y x d i.year, absorb(firm) vce(cluster firm)",
    "logit any x i.d i.year, vce(cluster firm)",
    "margins, dydx(x d)",
    "_pctile x, p(1 99)",
    "tabstat y x d, statistics(n mean sd p25 p50 p75) columns(statistics)",
    "correlate y x d",
    "codebook x, compact",
    "summarize x, detail",
    "xtsum x",
    "xtdescribe",
    "bsample, cluster(firm) idcluster(newfirm)",
  ]) {
    const out = s.run(command);
    assert.equal(out.rc, 0, `${command}\n${text(out)}`);
  }
});

test("no list is spread into Math.max or Math.min where it can be as long as the data", () => {
  // The places that remain spread lists whose length is a number of
  // variables, statistics, table columns or parameters. Each is listed, so
  // that a new one is looked at before it is allowed.
  const allowed = new Set(
    readFileSync(
      new URL("./fixtures/runtime-spread-allowlist.txt", import.meta.url),
      "utf8",
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
  const dir = new URL("../src/runtime/", import.meta.url),
    found = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const source = readFileSync(new URL(name, dir), "utf8");
    for (const m of source.matchAll(
      /Math\.(?:max|min)\(\s*(?:[^().]*,\s*)?\.\.\.\s*([^\n]*)/g,
    ))
      found.push(`${name}: ${m[1].trim().slice(0, 60)}`);
  }
  const unknown = found.filter((line) => !allowed.has(line));
  assert.deepEqual(unknown, []);
});
