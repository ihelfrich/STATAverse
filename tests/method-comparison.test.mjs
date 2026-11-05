import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  METHOD_CATALOG,
  METHOD_GROUPS,
  methodSelections,
  comparisonQuery,
  compareMethods,
  methodPlanText,
} from "../src/method-comparison.js";
import { methodGuide } from "../tools/build-method-guides.mjs";
import { LESSONS } from "../src/lessons.js";

const choices = {
  outcome: "binary",
  structure: "panel",
  design: "unresolved",
  dependence: "clustered",
};
const combinations = METHOD_GROUPS.reduce(
  (rows, group) =>
    rows.flatMap((row) =>
      group.options.map((o) => ({ ...row, [group.id]: o.id })),
    ),
  [{}],
);

test("all 200 comparisons distinguish outcome models, proposed designs and unresolved inference", () => {
  assert.equal(combinations.length, 200);
  for (const choice of combinations) {
    const c = compareMethods(choice),
      ids = c.methods.map((m) => m.id);
    assert.equal(c.missing.length, 0);
    const designExpected =
      ["iv", "did"].includes(choice.design) && choice.outcome !== "duration";
    assert.equal(
      ids.includes("iv"),
      designExpected && choice.design === "iv",
      JSON.stringify(choice),
    );
    assert.equal(
      ids.includes("did"),
      designExpected && choice.design === "did",
      JSON.stringify(choice),
    );
    assert.equal(ids.includes("lpm"), choice.outcome === "binary");
    for (const method of c.methods) {
      assert.doesNotMatch(method.code, /\{vce\}/);
      assert.ok(method.scope && method.assumptions.length && method.pitfall);
      if (["survey", "unresolved"].includes(choice.dependence))
        assert.equal(method.blocked, true);
      if (method.blocked)
        assert.ok(
          method.code.split("\n").every((line) => line.startsWith("*")),
        );
      if (
        choice.structure === "panel" &&
        choice.dependence === "independent" &&
        !["panel", "panelCount"].includes(method.id)
      )
        assert.equal(method.blocked, true);
    }
  }
});

test("binary and fractional panels keep the linear specification's interpretation visible", () => {
  const c = compareMethods(choices);
  assert.deepEqual(
    c.methods.map((m) => m.id),
    ["lpm", "logit", "panel"],
  );
  assert.match(c.methods[1].scope, /pooled/);
  assert.match(c.methods[2].scope, /linear probability/);
  assert.match(
    compareMethods({ ...choices, outcome: "fraction" }).methods.at(-1).scope,
    /outside \[0,1\]/,
  );
  assert.match(
    c.notices.map((n) => n.text).join(" "),
    /does not establish an instrument/,
  );
});

test("panel count inference uses a supported command for each covariance choice", () => {
  const c = compareMethods({ ...choices, outcome: "count" }).methods.at(-1);
  assert.match(
    c.code,
    /poisson y x1 x2 i.id i.time, vce\(cluster cluster_id\)/,
  );
  assert.doesNotMatch(c.code, /xtpoisson/);
  const independent = compareMethods({
    ...choices,
    outcome: "count",
    dependence: "independent",
  });
  assert.equal(independent.methods[0].blocked, true);
  assert.match(independent.methods[1].code, /xtpoisson.*fe vce\(robust\)/);
});

test("survival panels require risk intervals and never inherit a generic linear causal template", () => {
  for (const design of ["iv", "did"]) {
    const c = compareMethods({ ...choices, outcome: "duration", design });
    assert.deepEqual(
      c.methods.map((m) => m.id),
      ["hazard"],
    );
    assert.match(
      c.methods[0].code,
      /stset stop, enter\(time start\) failure\(event\) id\(id\)/,
    );
    assert.match(c.notices[0].text, /No linear design command/);
  }
});

test("invalid or incomplete query values cannot select methods or enter exported markup", () => {
  for (const input of [
    null,
    undefined,
    "bad",
    { ...choices, design: "<img onerror=alert(1)>" },
  ]) {
    const c = compareMethods(input);
    assert.ok(c.missing.length);
    assert.equal(c.methods.length, 0);
    assert.throws(() => methodPlanText(c), /Complete/);
  }
  assert.deepEqual(methodSelections({ ...choices, extra: "bad" }), choices);
  assert.equal(
    comparisonQuery({ ...choices, extra: "bad" }),
    "outcome=binary&structure=panel&design=unresolved&dependence=clustered",
  );
});

test("export preserves every notice, condition, limitation and code block with actual line breaks", () => {
  for (const choice of combinations) {
    const c = compareMethods(choice),
      text = methodPlanText(
        c,
        "https://ihelfrich.github.io/learn/stata/MethodLab/?" +
          comparisonQuery(choice),
      );
    assert.ok(text.split("\n").length > 20);
    assert.doesNotMatch(text, /\\n/);
    for (const n of c.notices) assert.ok(text.includes(n.text));
    for (const m of c.methods) {
      for (const part of [
        m.scope,
        m.pitfall,
        m.diagnostic,
        m.code,
        ...m.assumptions,
      ])
        assert.ok(text.includes(part));
    }
  }
});

test("native reference downloads derive from the same reviewed claims and only print commands", async () => {
  for (const compact of [false, true]) {
    const text = methodGuide({ compact });
    const filename = `../CodeLibrary/scripts/02_method_decision_tree${compact ? "" : "_v2"}.do`;
    assert.equal(
      await fs.readFile(new URL(filename, import.meta.url), "utf8"),
      text,
    );
    for (const line of text.split("\n")) {
      assert.ok(
        /^(?:\s*(?:\*|display |if |local |version |args |exit |\})|\s*$)/.test(
          line,
        ),
        line,
      );
    }
    assert.match(text, /independent panels/);
    assert.match(text, /A 0\/1 outcome does not prohibit OLS/);
  }
});

test("all comparison links reach existing local resources and lesson hashes", async () => {
  for (const m of Object.values(METHOD_CATALOG.methods))
    for (const link of m.links || []) {
      if (link.href.startsWith("https:")) continue;
      const url = new URL(link.href, "https://test/MethodLab/");
      const file = new URL(
        ".." + url.pathname + (url.pathname.endsWith("/") ? "index.html" : ""),
        import.meta.url,
      );
      await fs.access(file);
      if (url.pathname === "/Learn/" && url.hash)
        assert.ok(
          LESSONS.some((lesson) => lesson.id === url.hash.slice(1)),
          link.href,
        );
    }
});
