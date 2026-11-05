import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  WORKED_EXAMPLES,
  exampleById,
  splitDoFile,
  sourceMatches,
  resolveSection,
  exampleAddress,
} from "../src/worked-examples.js";
import { WORKED_EXAMPLE_HASHES } from "../src/worked-example-hashes.js";
import { LESSONS } from "../src/lessons.js";

test("every reader outline covers the exact downloadable source once, with matching build hashes", async () => {
  assert.equal(WORKED_EXAMPLES.length, 7);
  for (const e of WORKED_EXAMPLES) {
    const bytes = await fs.readFile(
      new URL("../CodeLibrary/scripts/" + e.file, import.meta.url),
    );
    const source = bytes.toString("utf8"),
      sections = splitDoFile(source, e);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      WORKED_EXAMPLE_HASHES[e.id],
    );
    assert.equal(sections.flatMap((s) => s.lines).join("\n"), source);
    assert.equal(sections[0].start, 1);
    for (let i = 1; i < sections.length; i++)
      assert.equal(sections[i].start, sections[i - 1].end + 1);
    for (const section of sections)
      assert.equal(section.lines.length, section.end - section.start + 1);
  }
});
test("source search is literal, case-insensitive and bounded, and line links resolve to the containing section", () => {
  const e = exampleById("panel");
  const source = e.sections
    .map((_, i) =>
      i === 0
        ? "clear\n* a [literal] <img>\n"
        : "* SECTION " + i + ": label\nregress y x\n",
    )
    .join("");
  const sections = splitDoFile(source, e);
  assert.equal(sourceMatches(source, "[literal]").total, 1);
  assert.equal(sourceMatches(source, ".*").total, 0);
  assert.equal(sourceMatches(source, "REGRESS", 2).matches.length, 2);
  assert.equal(sourceMatches(source, "REGRESS", 2).total, 8);
  const hit = sourceMatches(source, "[literal]").matches[0];
  assert.deepEqual(resolveSection(sections, "section-6", "#L" + hit.line), {
    index: 0,
    line: 2,
  });
  assert.deepEqual(resolveSection(sections, "no-such-section", "#L999999999"), {
    index: 0,
    line: null,
  });
  assert.equal(
    exampleAddress(e, sections[3], sections[3].start),
    "?example=panel&section=section-3#L" + sections[3].start,
  );
});
test("unknown examples and changed outlines cannot be mistaken for reviewed source sections", () => {
  assert.equal(exampleById("../scripts/arbitrary.do"), undefined);
  assert.throws(
    () => splitDoFile("clear", exampleById("panel")),
    /do not match/,
  );
  assert.throws(
    () => splitDoFile("x".repeat(200001), exampleById("panel")),
    /size limit/,
  );
  assert.throws(
    () => exampleAddress({ id: "bad" }, { id: "preparation" }),
    /Unknown/,
  );
});
test("panel reference output and native evidence belong to the actual downloadable file", async () => {
  const output = JSON.parse(
    await fs.readFile(
      new URL("../assets/data/panel-output.json", import.meta.url),
      "utf8",
    ),
  );
  const receipt = JSON.parse(
    await fs.readFile(
      new URL("../docs/verification/panel-native.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(receipt.returnCode, "0");
  assert.equal(output.sourceSha256, WORKED_EXAMPLE_HASHES.panel);
  assert.equal(receipt.sourceSha256, output.sourceSha256);
  assert.equal(output.rows.length, 17);
  for (const term of ["experience", "competition", "innovation"]) {
    const fe = output.rows.find((r) => r.model === "fe" && r.term === term);
    const within = output.rows.find(
      (r) => r.model === "hybrid" && r.term === term + "_within",
    );
    const between = output.rows.find(
      (r) => r.model === "hybrid" && r.term === term + "_mean",
    );
    assert.ok(Math.abs(fe.b - within.b) < 1e-9);
    assert.ok(between.se > 0 && Number.isFinite(between.se));
  }
});
test("every interpretation check has complete targeted feedback and companion links reach existing lessons", async () => {
  const panel = exampleById("panel");
  assert.equal(panel.guides.filter((g) => g.question).length, 8);
  for (const guide of panel.guides)
    if (guide.question) {
      const q = guide.question;
      assert.equal(q.options.length, q.feedback.length);
      assert.ok(q.options[q.correct]);
      assert.equal(new Set(q.feedback).size, q.options.length);
    }
  for (const e of WORKED_EXAMPLES)
    for (const link of [e.prerequisite, e.companion]) {
      const u = new URL(link.href, "https://test/CodeLibrary/");
      await fs.access(
        new URL(
          ".." + u.pathname + (u.pathname.endsWith("/") ? "index.html" : ""),
          import.meta.url,
        ),
      );
      if (u.pathname === "/Learn/" && u.hash)
        assert.ok(
          LESSONS.some((l) => l.id === u.hash.slice(1)),
          link.href,
        );
    }
});
