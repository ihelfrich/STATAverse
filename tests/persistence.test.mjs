import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyStore,
  parseStore,
  validateStore,
  validateBackup,
} from "../src/persistence.js";
test("valid practice state round-trips and keeps notes and executed commands", () => {
  const s = emptyStore();
  s.lessons["first-commands"] = {
    step: 1,
    completed: [0],
    history: ["describe"],
    code: "list id in 1/5",
    note: "One row per student",
  };
  assert.deepEqual(parseStore(JSON.stringify(s)), s);
});
test("corrupt or oversized state cannot crash later through a malformed free record", () => {
  for (const value of [
    { ...emptyStore(), free: true },
    { ...emptyStore(), lessons: [] },
    { ...emptyStore(), lessons: { "first-commands": { step: -1 } } },
    { ...emptyStore(), lessons: { "first-commands": { history: [1] } } },
    { ...emptyStore(), free: { study: { completed: [3] } } },
  ])
    assert.throws(() => validateStore(value));
  assert.throws(() => parseStore("x".repeat(2000001)));
});
test("workspace imports cannot overwrite arbitrary same-origin application keys", () => {
  assert.throws(() =>
    validateBackup({
      profile: {},
      progress: { "some-other-app:settings": "{}" },
    }),
  );
});
test("legacy workspace notes and new practice history both survive a backup", () => {
  const value = {
    profile: { name: "Test", role: "", focus: "" },
    progress: {
      "stataverse:progress:/lesson": JSON.stringify({
        checks: [true, false],
        notes: { note: "A question" },
      }),
    },
    practice: emptyStore(),
  };
  const copy = validateBackup(value);
  assert.deepEqual(copy.practice, value.practice);
  assert.deepEqual(copy.progress, value.progress);
  assert.equal(copy.profile.name, "Test");
});
