import { test } from "node:test";
import assert from "node:assert/strict";
import { LabProgressSession } from "../src/lab-progress-session.js";
import {
  LAB_PROGRESS_KEY,
  completeLabStep,
  emptyLabProgress,
  saveLabDraft,
  renewLabProgress,
} from "../src/lab-progress.js";
import { IV_INVESTIGATIONS } from "../src/labs/iv-investigations.js";

const addFirst = (value) =>
  completeLabStep(value, "matching-records", "unique-side");
const draft = (answer = "0.810") => ({
  ...IV_INVESTIGATIONS[0].steps[0].setup,
  step: "projected-record",
  answer,
  note: "The row is off the fitted line.",
  updatedAt: 1,
});
function fixture(options = {}) {
  let raw = options.raw ?? null;
  const writes = [];
  const session = new LabProgressSession({
    read: () => raw,
    write: (text) => {
      raw = text;
      writes.push(text);
    },
    lock: (callback) => Promise.resolve().then(callback),
    ...options,
  });
  return {
    session,
    writes,
    read: () => raw,
    replace: (text) => {
      raw = text;
    },
  };
}

test("coalesced lab saves retain all task states and the latest note under a held lock", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    lock: async (callback) => {
      await held;
      callback();
    },
  });
  const first = f.session.update(addFirst);
  let last;
  for (let i = 0; i < 20; i++)
    last = f.session.update((value) =>
      saveLabDraft(value, "iv-stages", { ...draft(), note: `note ${i}` }),
    );
  assert.equal(last, first);
  assert.equal(f.writes.length, 0);
  release();
  assert.equal(await first, true);
  assert.equal(f.writes.length, 1);
  const saved = JSON.parse(f.read());
  assert.equal(saved.drafts["iv-stages"].note, "note 19");
  assert.deepEqual(saved.completed["matching-records"], ["unique-side"]);
  assert.equal(f.session.savedRevision, f.session.revision);
  f.session.close();
});

test("an edit in the drain-completion microtask is included in the awaited save", async () => {
  let once = true,
    f;
  f = fixture({
    lock: (callback) => {
      callback();
      if (once) {
        once = false;
        Promise.resolve().then(() =>
          queueMicrotask(() =>
            f.session.update((value) =>
              saveLabDraft(value, "iv-stages", draft()),
            ),
          ),
        );
      }
      return Promise.resolve();
    },
  });
  await f.session.update(addFirst);
  assert.equal(
    JSON.parse(f.read()).drafts["iv-stages"].states["projected-record"].answer,
    "0.810",
  );
  assert.equal(f.session.savedRevision, f.session.revision);
  assert.equal(f.writes.length, 2);
  f.session.close();
});

test("an imported or removed stored copy wins over a waiting writer", async () => {
  for (const replacement of [
    null,
    JSON.stringify({ version: 1, completed: {} }),
  ]) {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const raw = JSON.stringify(addFirst(emptyLabProgress()));
    const f = fixture({
      raw,
      lock: async (callback) => {
        await held;
        callback();
      },
    });
    const pending = f.session.update((value) =>
      saveLabDraft(value, "iv-stages", draft()),
    );
    f.replace(replacement);
    release();
    assert.equal(await pending, false);
    assert.equal(f.read(), replacement);
    assert.equal(f.writes.length, 0);
    assert.equal(f.session.canSave, false);
    assert.ok(
      f.session.value.drafts["iv-stages"],
      "The unsaved work remains available for export",
    );
    assert.match(f.session.message, /another tab/);
    f.session.close();
  }
});

test("storage events, corrupt records and write failures never erase the stored copy", async () => {
  for (const event of [{ key: LAB_PROGRESS_KEY }, { key: null }]) {
    const f = fixture();
    f.session.storageListener(event);
    assert.equal(await f.session.update(addFirst), false);
    assert.equal(f.read(), null);
    f.session.close();
  }
  const corrupt = fixture({ raw: "invalid saved bytes" });
  assert.equal(await corrupt.session.update(addFirst), false);
  assert.equal(corrupt.read(), "invalid saved bytes");
  corrupt.session.close();
  const initial = JSON.stringify(emptyLabProgress());
  const quota = fixture({
    raw: initial,
    write: () => {
      throw new Error("quota");
    },
  });
  assert.equal(await quota.session.update(addFirst), false);
  assert.equal(quota.read(), initial);
  assert.match(quota.session.message, /could not save/);
  assert.deepEqual(quota.session.value.completed["matching-records"], [
    "unique-side",
  ]);
  quota.session.close();
});

test("repeated clears of an empty lab record invalidate an earlier pending save", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    lock: async (callback) => {
      await held;
      callback();
    },
  });
  const pending = f.session.update((value) =>
    saveLabDraft(value, "iv-stages", draft()),
  );
  const firstClear = renewLabProgress(),
    secondClear = renewLabProgress();
  assert.notEqual(firstClear.generation, secondClear.generation);
  f.replace(JSON.stringify(secondClear));
  release();
  assert.equal(await pending, false);
  assert.deepEqual(JSON.parse(f.read()), secondClear);
  const next = saveLabDraft(secondClear, "iv-stages", draft());
  assert.equal(next.generation, secondClear.generation);
  f.session.close();
});

// Another tab's write can be missing from this tab's copy of localStorage
// for a moment even while this tab holds the lock. These cases stand in for
// that: read() keeps returning the old text although a marked write exists.
function markerFixture(marked) {
  const state = { marked, sets: [] };
  return {
    state,
    marker: {
      get: async () => state.marked,
      set: async (generation) => {
        state.sets.push(generation);
        state.marked = { generation, at: 1000 };
        return true;
      },
    },
  };
}

test("a save is refused when another tab's recent write has not reached this tab's storage", async () => {
  const m = markerFixture({ generation: "written-elsewhere", at: 995 }),
    f = fixture({ marker: m.marker, now: () => 1000 });
  assert.equal(await f.session.update(addFirst), false);
  assert.deepEqual(f.writes, []);
  assert.equal(f.session.canSave, false);
  assert.match(f.session.message, /changed in another tab/);
});

test("a save proceeds past an old marker left by a writer that keeps none, and replaces it", async () => {
  const m = markerFixture({ generation: "long-ago", at: 0 }),
    f = fixture({ marker: m.marker, now: () => 60000 });
  assert.equal(await f.session.update(addFirst), true);
  assert.equal(f.writes.length, 1);
  const written = JSON.parse(f.writes[0]);
  assert.deepEqual(m.state.sets, [written.generation]);
});

test("each save carries a new generation and a session keeps saving after its own writes", async () => {
  const m = markerFixture(undefined),
    f = fixture({ marker: m.marker, now: () => 1000 });
  assert.equal(await f.session.update(addFirst), true);
  assert.equal(
    await f.session.update((value) =>
      saveLabDraft(value, "iv-stages", draft()),
    ),
    true,
  );
  const generations = f.writes.map((text) => JSON.parse(text).generation);
  assert.equal(new Set(generations).size, 2);
  assert.deepEqual(m.state.sets, generations);
  assert.equal(f.session.canSave, true);
});

test("without IndexedDB the session saves as before on the localStorage check alone", async () => {
  const f = fixture({
    marker: { get: async () => undefined, set: async () => false },
  });
  assert.equal(await f.session.update(addFirst), true);
  f.replace(JSON.stringify(renewLabProgress()));
  assert.equal(
    await f.session.update((value) =>
      saveLabDraft(value, "iv-stages", draft()),
    ),
    false,
  );
});
