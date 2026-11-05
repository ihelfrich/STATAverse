import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { PracticeSession } from "../src/engine.js";
import { executionRange } from "../src/do-file.js";
import { resultHTML } from "../src/render.js";
import {
  executePracticeRequest,
  executePracticeRequestAsync,
  executionInputs,
} from "../src/practice-execution.js";
const fixture = JSON.parse(
  await fs.readFile(
    new URL("./fixtures/prefix-native.json", import.meta.url),
    "utf8",
  ),
);
const fresh = () =>
  new PracticeSession("prefixes", { prefixes: { data: fixture.dataset } });
test("prefixes, return codes, output and data match 39 installed-native examples", () => {
  for (const item of fixture.cases) {
    const session = fresh(),
      output = session.run(item.source);
    assert.equal(
      output.find((r) => r.kind === "error")?.code || 0,
      item.returnCode,
      item.id,
    );
    assert.deepEqual(
      session.data.columns.map((c) => c.name),
      item.columns.map((c) => c.name),
      item.id,
    );
    for (const c of item.columns)
      session.data.rows.forEach((r, i) => {
        const expected = c.values[i];
        if (expected === null) assert.equal(r[c.name], null);
        else
          assert.ok(
            Math.abs(r[c.name] - expected) <
              1e-8 * Math.max(1, Math.abs(expected)),
            item.id,
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
      item.visible,
      item.id,
    );
    const replay = fresh();
    for (const c of session.history)
      assert.ok(
        !replay.run(c).some((r) => r.kind === "error"),
        item.id + " replay",
      );
    assert.deepEqual(replay.data, session.data, item.id + " replay data");
    assert.equal(replay.returnCode, session.returnCode, item.id + " replay rc");
  }
});
test("prefixed runs and replay have identical worker/cooperative state including _rc", async () => {
  for (const item of fixture.cases) {
    const session = fresh();
    const request = structuredClone({
      ...executionInputs(session, "prefixes"),
      task: "run",
      source: item.source,
    });
    const sync = executePracticeRequest(structuredClone(request)),
      async = await executePracticeRequestAsync(request);
    assert.deepEqual(async, sync, item.id);
    const replay = await executePracticeRequestAsync({
      ...request,
      task: "replay",
      commands: sync.state.history,
    });
    assert.deepEqual(replay.state.data, sync.state.data, item.id);
    assert.equal(replay.state.returnCode, sync.state.returnCode, item.id);
  }
});
test("captured failures preserve existing data/model, commit their code and undo cleanly", () => {
  const s = fresh();
  s.run("reg score hours");
  const before = s.snapshot();
  const failure = s.run("cap drop hours missing_column")[0];
  assert.equal(failure.kind, "captured");
  assert.equal(s.returnCode, 111);
  assert.deepEqual(s.model, before.model);
  assert.deepEqual(s.data, before.data);
  s.undo();
  assert.deepEqual(s.snapshot(), before);
  s.run("capture error 459");
  const beforeGroup = s.snapshot();
  s.run("capture {\ngen temporary=1\ndrop absent\n}");
  assert.equal(s.returnCode, 111);
  assert.ok(s.data.columns.some((c) => c.name === "temporary"));
  assert.equal(s.model, null);
  s.undo();
  assert.deepEqual(s.snapshot(), beforeGroup);
});
test("quiet output is hidden while noisily and uncaptured errors remain visible", () => {
  const s = fresh();
  const quiet = s.run("qui summarize hours")[0];
  assert.equal(resultHTML(quiet, 0), "");
  const capture = s.run("cap confirm variable absent")[0];
  assert.equal(resultHTML(capture, 0), "");
  assert.equal(capture.code, 111);
  const noisy = s.run("cap noi confirm variable absent")[0];
  assert.match(resultHTML(noisy, 0), /r\(111\)/);
  assert.match(resultHTML(noisy, 0), /Execution continued/);
  const error = s.run("quietly drop absent\ngen should_not_exist=1")[0];
  assert.equal(error.kind, "error");
  assert.match(resultHTML(error, 0), /r\(111\)/);
  assert.ok(!s.data.columns.some((c) => c.name === "should_not_exist"));
});
test("capture cannot swallow bounds, aborted work, or malformed structural input", async () => {
  const s = fresh();
  let r = s.run("capture forvalues j=1/1001 {\ncount\n}\ngen skipped=1").at(-1);
  assert.equal(r.kind, "error");
  assert.equal(r.code, 901);
  assert.ok(!s.data.columns.some((c) => c.name === "skipped"));
  const before = s.snapshot();
  r = s
    .run("capture {\nforvalues j=1/199 {\nreplace hours=hours+1\n}\n}")
    .at(-1);
  assert.equal(r.code, 901);
  assert.deepEqual(s.data, before.data);
  assert.deepEqual(s.history, before.history);
  assert.throws(() => s.run("capture {\ncount"), /closing brace/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    s.runAsync("capture {\ncount\n}", { signal: controller.signal }),
    { name: "AbortError" },
  );
});
test("Run current selects a full prefixed block and aliases preserve _rc expressions", () => {
  const source =
    "capture noisily {\nconfirm variable missing\ngenerate double no=1\n}\ndi _rc";
  assert.equal(
    executionRange(source, source.indexOf("confirm")).text,
    source.split("\ndi")[0],
  );
  const s = fresh();
  s.run("cap error 459");
  assert.equal(s.run("dis _rc + 1")[0].value, 460);
  assert.equal(s.run('di "_rc"')[0].value, "_rc");
  s.run("generate double saved=_rc");
  assert.equal(s.data.rows[0].saved, 459);
  assert.equal(s.run("count if _rc == 459")[0].n, 4);
  assert.equal(s.run("generate double _rc=0")[0].kind, "error");
});
