import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { PracticeSession } from "../src/engine.js";
import {
  executePracticeRequest,
  executePracticeRequestAsync,
  executionInputs,
  offsetExecutionSources,
  PRACTICE_PROTOCOL,
} from "../src/practice-execution.js";
import { createPracticeRunner } from "../src/practice-runner.js";

const requestFor = (session, source) =>
  structuredClone({
    ...executionInputs(session, "study"),
    task: "run",
    source,
  });
test("synchronous and cooperative engines agree on every programming fixture and replay", async () => {
  const fixtures = JSON.parse(
    await fs.readFile(
      new URL("./fixtures/program-cases.json", import.meta.url),
      "utf8",
    ),
  );
  for (const fixture of fixtures) {
    const request = requestFor(new PracticeSession(), fixture.source);
    const expected = executePracticeRequest(structuredClone(request));
    const actual = await executePracticeRequestAsync(structuredClone(request));
    assert.deepEqual(actual, expected, fixture.id);
    const replay = {
      ...request,
      task: "replay",
      commands: expected.state.history,
    };
    assert.deepEqual(
      await executePracticeRequestAsync(structuredClone(replay)),
      executePracticeRequest(structuredClone(replay)),
      fixture.id + " replay",
    );
  }
});
test("worker execution leaves committed data intact until acceptance and joins bounded undo history", () => {
  const session = new PracticeSession();
  session.run("generate double original = hours");
  const before = session.snapshot();
  const response = executePracticeRequest(
    requestFor(
      session,
      'preserve\nkeep if group == "A"\ngenerate double squared = hours^2',
    ),
  );
  assert.deepEqual(session.snapshot(), before);
  assert.equal(response.state.data.rows.length, 12);
  assert.equal(response.undo.length, 3);
  session.acceptExecution(
    structuredClone(response.state),
    structuredClone(response.undo),
  );
  assert.equal(session.undoStack.length, 4);
  assert.equal(session.data.rows.length, 12);
  session.undo();
  assert.ok(!session.data.columns.some((c) => c.name === "squared"));
  session.undo();
  assert.equal(session.data.rows.length, 24);
  session.undo();
  assert.deepEqual(session.snapshot(), before);
  session.undo();
  assert.ok(!session.data.columns.some((c) => c.name === "original"));
});
test("worker command failures retain preceding successes while structural failures return no candidate", () => {
  const session = new PracticeSession(),
    before = session.snapshot();
  const response = executePracticeRequest(
    requestFor(
      session,
      "forvalues i=1/3 {\n generate double repeated = `i'\n}\nclear",
    ),
  );
  assert.equal(response.results.at(-1).code, 110);
  assert.equal(response.results.at(-1).source.line, 2);
  assert.equal(response.state.data.rows[0].repeated, 1);
  assert.equal(response.state.history.length, 1);
  assert.deepEqual(session.snapshot(), before);
  assert.throws(
    () =>
      executePracticeRequest(
        requestFor(session, "generate double x=1\nforvalues i=1/2 {\n clear"),
      ),
    /closing brace/,
  );
  assert.deepEqual(session.snapshot(), before);
});
test("background replay is bounded, preserves the request and identifies the first invalid saved command", () => {
  const commands = Array.from({ length: 250 }, (_, i) => `display ${i + 1}`);
  const response = executePracticeRequest({
    task: "replay",
    dataset: "study",
    commands,
  });
  assert.equal(response.state.history.length, 250);
  assert.equal(response.results.length, 200);
  assert.equal(response.receipts.length, 250);
  assert.equal(response.undo.length, 50);
  assert.equal(response.replayFailed, false);
  const failedCommands = [
    "generate double x=1",
    "unsupported_stata_command",
    "clear",
  ];
  const failed = executePracticeRequest({
    task: "replay",
    dataset: "study",
    commands: failedCommands,
  });
  assert.equal(failed.replayFailed, true);
  assert.deepEqual(failed.state.history, ["generate double x=1"]);
  assert.equal(failed.state.data.rows.length, 24);
  assert.equal(failedCommands.length, 3);
  assert.equal(failed.results.at(-1).code, 199);
});
test("transferred undo states retain memory limits and calculated models across the worker boundary", () => {
  const session = new PracticeSession();
  session.run("regress score hours");
  const model = structuredClone(session.model);
  const response = executePracticeRequest(
    requestFor(session, "predict double fitted\ngenerate double changed=1"),
  );
  session.acceptExecution(
    structuredClone(response.state),
    structuredClone(response.undo),
  );
  session.undo();
  session.undo();
  assert.deepEqual(session.model, model);
  assert.equal(session.history.length, 1);
  const many = executePracticeRequest(
    requestFor(session, "forvalues i=1/100 {\n display `i'\n}"),
  );
  session.acceptExecution(many.state, many.undo);
  assert.equal(session.undoStack.length, 50);
});
test("worker inputs omit original imported source records and source offsets apply once to aliases", () => {
  const session = new PracticeSession();
  session.customDatasets = {
    fixture: {
      id: "fixture",
      file: "fixture.csv",
      data: session.data,
      record: { source: "original source", filename: "original upload.csv" },
    },
  };
  const inputs = executionInputs(session, "study");
  assert.deepEqual(Object.keys(inputs.customDatasets.fixture), [
    "id",
    "file",
    "data",
  ]);
  const source = { from: 5, to: 10, line: 2, endLine: 2 },
    copy = structuredClone(source);
  offsetExecutionSources([{ source }, { source: copy }], [{ source }], {
    from: 20,
    line: 4,
  });
  assert.deepEqual(source, { from: 25, to: 30, line: 5, endLine: 5 });
  assert.deepEqual(copy, source);
});

class FakeWorker {
  terminated = false;
  postMessage(message) {
    this.message = message;
  }
  terminate() {
    this.terminated = true;
  }
  complete() {
    const { id, version, request } = this.message;
    this.onmessage({
      data: {
        id,
        version,
        kind: "complete",
        ...executePracticeRequest(structuredClone(request)),
      },
    });
  }
}
function setup(options = {}) {
  const workers = [];
  const runner = createPracticeRunner({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    ...options,
  });
  return { runner, workers };
}
test("canceled workers and late responses cannot settle or overwrite a newer job", async () => {
  const { runner, workers } = setup();
  const request = requestFor(
    new PracticeSession(),
    "generate double canceled=1",
  );
  const first = runner.run(request),
    rejected = assert.rejects(first, { name: "AbortError" });
  await assert.rejects(runner.run(request), /already active/);
  runner.cancel();
  await rejected;
  assert.equal(workers[0].terminated, true);
  const second = runner.run(
    requestFor(new PracticeSession(), "generate double accepted=1"),
  );
  workers[0].complete();
  assert.equal(runner.busy, true);
  workers[1].complete();
  const result = await second;
  assert.equal(result.state.data.rows[0].accepted, 1);
  assert.equal(result.state.data.rows[0].canceled, undefined);
  assert.equal(runner.busy, false);
  assert.equal(workers[1].terminated, true);
});
test("mismatched assets, invalid results and timeouts release the pending job", async () => {
  for (const failure of ["protocol", "malformed", "unknown"]) {
    const { runner, workers } = setup();
    const pending = runner.run(requestFor(new PracticeSession(), "count"));
    const rejected = assert.rejects(pending);
    const worker = workers[0],
      { id, version } = worker.message;
    if (failure === "protocol")
      worker.onmessage({
        data: { id, version: version + 1, kind: "complete" },
      });
    if (failure === "malformed")
      worker.onmessage({ data: { id, version, kind: "complete", state: {} } });
    if (failure === "unknown")
      worker.onmessage({ data: { id, version, kind: "unknown" } });
    await rejected;
    assert.equal(runner.busy, false);
    assert.equal(worker.terminated, true);
    const retry = runner.run(requestFor(new PracticeSession(), "count"));
    workers[1].complete();
    assert.equal((await retry).results.at(-1).n, 24);
  }
  const { runner, workers } = setup({ timeoutMs: 5 });
  await assert.rejects(
    runner.run(requestFor(new PracticeSession(), "count")),
    /exceeded two minutes/,
  );
  assert.equal(workers[0].terminated, true);
  assert.equal(runner.busy, false);
});
test("worker construction failures use the same engine locally and Stata parser errors keep source evidence", async () => {
  let attempts = 0;
  const runner = createPracticeRunner({
    createWorker: () => {
      attempts++;
      throw new Error("worker unavailable");
    },
  });
  const session = new PracticeSession(),
    original = session.snapshot();
  const result = await runner.run(
    requestFor(session, "generate double copied=hours\ncount"),
  );
  assert.equal(result.state.data.rows[0].copied, session.data.rows[0].hours);
  assert.equal(result.results.at(-1).n, 24);
  assert.deepEqual(session.snapshot(), original);
  await runner.run(requestFor(session, "count"));
  assert.equal(attempts, 1);
  assert.equal(runner.busy, false);
  const { runner: other, workers } = setup();
  const pending = other.run(requestFor(new PracticeSession(), "count"));
  const rejected = assert.rejects(
    pending,
    (e) => e.code === 198 && e.source.line === 3,
  );
  workers[0].onmessage({
    data: {
      id: workers[0].message.id,
      version: PRACTICE_PROTOCOL,
      kind: "failure",
      error: { message: "Unclosed block", code: 198, source: { line: 3 } },
    },
  });
  await rejected;
});

test("worker load and decoding errors recover from the original snapshot; late replies are ignored", async () => {
  for (const failure of ["crash", "decode"]) {
    const { runner, workers } = setup();
    const session = new PracticeSession(),
      before = session.snapshot();
    const pending = runner.run(
      requestFor(session, "generate double recovered=hours"),
    );
    const worker = workers[0];
    if (failure === "crash") worker.onerror({ preventDefault() {} });
    else worker.onmessageerror();
    worker.onmessage({
      data: {
        id: worker.message.id,
        version: PRACTICE_PROTOCOL,
        kind: "failure",
        error: { message: "late failure" },
      },
    });
    const result = await pending;
    assert.equal(
      result.state.data.rows[0].recovered,
      before.data.rows[0].hours,
    );
    assert.deepEqual(session.snapshot(), before);
    assert.equal(worker.terminated, true);
  }
});

test("cooperative runs can stop after a command without committing data and recover", async () => {
  const session = new PracticeSession(),
    before = session.snapshot();
  const runner = createPracticeRunner({
    createWorker: () => {
      throw new Error("blocked");
    },
  });
  let completed = 0;
  const pending = runner.run(
    requestFor(
      session,
      "generate double abandoned=1\nforvalues i=1/30 {\n replace abandoned=abandoned+1\n}",
    ),
    ({ commands }) => {
      if (commands === 2) {
        completed = commands;
        runner.cancel();
      }
    },
  );
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(completed, 2);
  assert.deepEqual(session.snapshot(), before);
  const result = await runner.run(requestFor(session, "count"));
  assert.equal(result.results.at(-1).n, 24);
  assert.equal(
    result.state.data.columns.some((c) => c.name === "abandoned"),
    false,
  );
});
