import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
const backup = {
  version: 2,
  profile: { name: "Learner", role: "Student", focus: "Regression" },
  progress: {
    "stataverse:progress:/test": JSON.stringify({
      checks: [true, false],
      notes: { one: "Question about units" },
    }),
  },
  practice: {
    version: 2,
    current: "first-commands",
    free: {},
    lessons: {
      "first-commands": {
        step: 1,
        completed: [0],
        history: ["describe"],
        code: "list id",
        note: "Rows are students",
      },
    },
  },
};
const upload = (data) => ({
  name: "backup.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(data)),
});
test("workspace imports and exports both reading and practice work", async ({
  page,
}) => {
  await page.goto("/Workspace/");
  await page.locator("#workspace-import").setInputFiles(upload(backup));
  await expect(page.locator("#workspace-status")).toContainText(
    "Backup imported",
  );
  await expect(page.locator("[data-tasks-count]")).toHaveText("2");
  await expect(page.locator("[data-notes-count]")).toHaveText("2");
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export workspace" }).click();
  const downloaded = JSON.parse(
    await fs.readFile(await (await waiting).path(), "utf8"),
  );
  expect(downloaded).toEqual({
    ...backup,
    practice: {
      ...backup.practice,
      version: 3,
      imports: {},
      mode: "guided",
      activeDataset: "study",
    },
  });
  await page.goto("/Learn/");
  await expect(page.locator("#student-notes")).toHaveValue("Rows are students");
  await expect(page.locator("#results")).toContainText("describe");
});
test("invalid imports and canceled erasure leave all stored work intact", async ({
  page,
}) => {
  await page.goto("/Workspace/");
  await page.evaluate(() => {
    localStorage.setItem("unrelated:app", "keep");
    localStorage.setItem(
      "stataverse:user",
      JSON.stringify({ name: "Existing" }),
    );
  });
  await page
    .locator("#workspace-import")
    .setInputFiles(
      upload({ ...backup, progress: { "unrelated:app": "replace" } }),
    );
  await expect(page.locator("#workspace-status")).toContainText(
    "Import failed",
  );
  expect(await page.evaluate(() => localStorage.getItem("unrelated:app"))).toBe(
    "keep",
  );
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("stataverse:user")).name,
    ),
  ).toBe("Existing");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Clear local data" }).click();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("stataverse:user")).name,
    ),
  ).toBe("Existing");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Clear local data" }).click();
  await expect(page.locator("#workspace-status")).toContainText(
    "saved work cleared",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("stataverse:user")),
  ).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("unrelated:app"))).toBe(
    "keep",
  );
});
test("a partial storage failure rolls back earlier writes", async ({
  page,
}) => {
  await page.goto("/Workspace/");
  await page.evaluate(() => {
    localStorage.setItem(
      "stataverse:user",
      JSON.stringify({ name: "Existing" }),
    );
    const original = Storage.prototype.setItem;
    let writes = 0;
    Storage.prototype.setItem = function (key, value) {
      if (++writes === 2) throw new DOMException("full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#workspace-import").setInputFiles(upload(backup));
  await expect(page.locator("#workspace-status")).toContainText(
    "previous saved work was restored",
  );
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("stataverse:user")).name,
    ),
  ).toBe("Existing");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("stataverse:progress:/test"),
    ),
  ).toBeNull();
});
test("an import in another tab cannot be overwritten by an old practice session", async ({
  page,
  context,
}) => {
  await page.goto("/Learn/");
  await page.locator("#run").click();
  const workspace = await context.newPage();
  await workspace.goto("/Workspace/");
  workspace.once("dialog", (dialog) => dialog.accept());
  await workspace.locator("#workspace-import").setInputFiles(upload(backup));
  await expect(page.locator("#storage-warning")).toContainText("another tab");
  await page.getByText("Your notes", { exact: true }).click();
  await page.locator("#student-notes").fill("Unsaved other copy");
  await page.locator("#run").click();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("stataverse:practice:v2")).lessons[
          "first-commands"
        ].note,
    ),
  ).toBe("Rows are students");
  await workspace.close();
});
test("workspace reports blocked storage", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });
  await page.goto("/Workspace/");
  await expect(page.locator("#workspace-status")).toContainText(
    "could not be read",
  );
  await page.locator("#workspace-name").fill("Test");
  await expect(page.locator("#workspace-status")).toContainText(
    "could not save",
  );
});

// A write in another tab reaches this tab's copy of localStorage a moment
// after it is made. This test reproduces that moment exactly: the practice
// tab keeps reading the old value and its storage event is held back, as was
// observed in Chrome under load, until after it has saved.
test("an import the practice tab has not yet received is restored when its notice arrives", async ({
  page,
  context,
}) => {
  // Storage notices are routed through a gate that can hold them back.
  await page.addInitScript(() => {
    const add = window.addEventListener.bind(window),
      held = [];
    window.addEventListener = (type, listener, options) =>
      type === "storage"
        ? add(
            type,
            (event) => {
              if (window.lagging) held.push([listener, event]);
              else listener(event);
            },
            options,
          )
        : add(type, listener, options);
    window.catchUp = () => {
      window.lagging = false;
      for (const [listener, event] of held.splice(0)) listener(event);
    };
  });
  await page.goto("/Learn/");
  await page.locator("#run").click();
  await expect(page.locator("#save-status")).toContainText("saved");
  await page.evaluate(() => {
    const key = "stataverse:practice:v2",
      read = Storage.prototype.getItem,
      write = Storage.prototype.setItem;
    let own = read.call(localStorage, key);
    // The tab sees its own writes at once and nothing from elsewhere.
    Storage.prototype.getItem = function (name) {
      return name === key && window.lagging ? own : read.call(this, name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (name === key) own = String(value);
      return write.call(this, name, value);
    };
    window.lagging = true;
  });
  const workspace = await context.newPage();
  await workspace.goto("/Workspace/");
  workspace.once("dialog", (dialog) => dialog.accept());
  await workspace.locator("#workspace-import").setInputFiles(upload(backup));
  await expect(workspace.locator("#workspace-status")).toContainText(
    "imported",
  );
  // The practice tab saves without having seen the import.
  await page.getByText("Your notes", { exact: true }).click();
  await page.locator("#student-notes").fill("Typed before the import arrived");
  await page.locator("#run").click();
  await expect(page.locator("#save-status")).toContainText("saved");
  const stored = () =>
    workspace.evaluate(
      () =>
        JSON.parse(localStorage.getItem("stataverse:practice:v2")).lessons[
          "first-commands"
        ].note,
    );
  await expect.poll(stored).toBe("Typed before the import arrived");
  // The notice arrives: the import is put back and saving stops.
  await page.evaluate(() => window.catchUp());
  await expect(page.locator("#storage-warning")).toContainText("another tab");
  await expect.poll(stored).toBe("Rows are students");
  await page.locator("#student-notes").fill("Typed after the warning");
  await page.locator("#run").click();
  expect(await stored()).toBe("Rows are students");
  await workspace.close();
});
