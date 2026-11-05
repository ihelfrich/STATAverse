import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { replaceEditor } from "./editor-helpers.js";
import { createImportRecord } from "../../src/import-library.js";
import { previewCSV } from "../../src/csv.js";

// Use the real calculation worker, but retain a completed reply until the test
// delivers it. A terminated worker can then be adversarially made to reply late.
async function delayedWorker(page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__holdPractice = false;
    window.__failPractice = false;
    window.__heldPractice = [];
    window.Worker = class {
      constructor(url, options) {
        if (!String(url).includes("practice-worker.js"))
          return new NativeWorker(url, options);
        if (window.__failPractice)
          throw new Error("Test worker startup failure");
        this.native = new NativeWorker(url, options);
        this.native.onmessage = (event) => {
          if (event.data.kind === "complete" && window.__holdPractice) {
            this.result = event.data;
            window.__heldPractice.push(this);
          } else this.onmessage?.(event);
        };
        this.native.onerror = (event) => this.onerror?.(event);
        this.native.onmessageerror = (event) => this.onmessageerror?.(event);
      }
      postMessage(data) {
        this.native.postMessage(data);
      }
      terminate() {
        this.native.terminate();
      }
    };
  });
}
const held = (page) =>
  expect
    .poll(() => page.evaluate(() => window.__heldPractice.length))
    .toBeGreaterThan(0);
const releaseOld = (page) =>
  page.evaluate(() => {
    for (const worker of window.__heldPractice)
      worker.onmessage?.({ data: worker.result });
  });

test("a completed run detects a replaced saved record even before storage events are delivered", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    window.addEventListener("storage", (event) =>
      event.stopImmediatePropagation(),
    ),
  );
  await delayedWorker(page);
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await replaceEditor(page, "count");
  await page.locator("#run").click();
  await expect(page.locator("#results")).toContainText("24 of 24");
  await page.evaluate(() => {
    window.__holdPractice = true;
  });
  await replaceEditor(page, "generate double delayed=1");
  await page.locator("#run").click();
  await held(page);
  const other = await context.newPage();
  await other.goto("/Workspace/");
  const external = await other.evaluate(() => {
    const value = JSON.parse(localStorage.getItem("stataverse:practice:v2"));
    value.free.study.note = "Imported while computation was pending";
    const raw = JSON.stringify(value);
    localStorage.setItem("stataverse:practice:v2", raw);
    return raw;
  });
  await releaseOld(page);
  await expect(page.locator("#run")).toBeEnabled();
  await expect(page.locator("#storage-warning")).toContainText("another tab");
  expect(
    await page.evaluate(() => localStorage.getItem("stataverse:practice:v2")),
  ).toBe(external);
  await other.close();
});

test("Stop discards the pending copy and late results cannot replace a later accepted run", async ({
  page,
}) => {
  await delayedWorker(page);
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await replaceEditor(page, "generate double original = hours");
  await page.locator("#run").click();
  await expect(page.locator("#dataset-count")).toContainText("6 variables");
  await page.evaluate(() => {
    window.__holdPractice = true;
  });
  await replaceEditor(page, "generate double canceled = 1");
  await page.locator("#run").click();
  await held(page);
  await expect(page.locator("#command-editor")).toHaveAttribute(
    "aria-readonly",
    "true",
  );
  await expect(page.locator("#dataset-count")).toContainText("6 variables");
  await expect(page.locator("#run")).toBeDisabled();
  await expect(page.locator("#undo")).toBeDisabled();
  await expect(page.locator("#export-open")).toBeDisabled();
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(audit.violations.map((v) => v.id)).toEqual([]);
  await page.getByRole("button", { name: "Stop run", exact: true }).click();
  await expect(page.locator("#run-status")).toContainText(
    "No commands from this run were applied",
  );
  await expect(page.locator("#command-editor")).toBeFocused();
  await page.evaluate(() => {
    window.__holdPractice = false;
  });
  await replaceEditor(page, "generate double accepted = 1");
  await page.locator("#run").click();
  await expect(page.locator("#dataset-count")).toContainText("7 variables");
  await releaseOld(page);
  await expect(page.locator("#data-table thead")).toContainText("accepted");
  await expect(page.locator("#data-table thead")).not.toContainText("canceled");
  const history = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("stataverse:practice:v2")).free.study
        .history,
  );
  expect(history).toEqual([
    "generate double original = hours",
    "generate double accepted = 1",
  ]);
  await page.locator("#undo").click();
  await expect(page.locator("#dataset-count")).toContainText("6 variables");
});

test("lesson navigation abandons a pending run and its delayed response cannot enter the new session", async ({
  page,
}) => {
  await delayedWorker(page);
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await page.evaluate(() => {
    window.__holdPractice = true;
  });
  await replaceEditor(page, "generate double abandoned = 1");
  await page.locator("#run").click();
  await held(page);
  await page.goto("/Learn/#macros-loops");
  await expect(page.locator("#lesson-title")).toHaveText(
    "A variable name stored as text",
  );
  await page.evaluate(() => {
    window.__holdPractice = false;
  });
  await releaseOld(page);
  await expect(page.locator("#dataset-count")).toContainText("5 variables");
  await expect(page.locator("#stop-run")).toBeHidden();
  await page.locator("#insert-example").click();
  await page.locator("#run").click();
  await expect(page.locator("#exercise-check")).toContainText(
    "expected result",
  );
  await expect(page.locator("#data-table thead")).not.toContainText(
    "abandoned",
  );
});

test("interrupted restoration preserves the exact stored original and retry restores its data and undo", async ({
  page,
}) => {
  await delayedWorker(page);
  const original = JSON.stringify({
    version: 3,
    mode: "free",
    activeDataset: "study",
    current: "first-commands",
    imports: {},
    lessons: {},
    free: {
      study: {
        step: 0,
        completed: [],
        history: ["generate double retained=hours", "count"],
        code: "list retained",
        note: "Keep this note",
      },
    },
  });
  await page.addInitScript((value) => {
    localStorage.setItem("stataverse:practice:v2", value);
    window.__holdPractice = true;
  }, original);
  await page.goto("/Learn/");
  await held(page);
  await expect(page.locator("#data-table")).toBeHidden();
  await page
    .getByRole("button", { name: "Stop restoration", exact: true })
    .click();
  await expect(page.locator("#run-status")).toContainText(
    "Your saved work is unchanged",
  );
  await expect(page.locator("#run")).toBeDisabled();
  await expect(page.locator("#student-notes")).toBeDisabled();
  expect(
    await page.evaluate(() => localStorage.getItem("stataverse:practice:v2")),
  ).toBe(original);
  await page.evaluate(() => {
    window.__holdPractice = false;
  });
  await page.locator("#retry-replay").click();
  await expect(page.locator("#dataset-count")).toContainText("6 variables");
  await releaseOld(page);
  await expect(page.locator("#history-count")).toHaveText("2");
  await expect(page.locator("#run")).toBeEnabled();
  await expect(page.locator("#student-notes")).toHaveValue("Keep this note");
  await page.locator("#undo").click();
  await page.locator("#undo").click();
  await expect(page.locator("#dataset-count")).toContainText("5 variables");
});

test("worker startup failure falls back locally with the existing data and undo", async ({
  page,
}) => {
  await delayedWorker(page);
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await replaceEditor(page, "generate double original=hours");
  await page.locator("#run").click();
  await expect(page.locator("#dataset-count")).toContainText("6 variables");
  await page.evaluate(() => {
    window.__failPractice = true;
  });
  await replaceEditor(page, "generate double recovered=original+1");
  await page.locator("#run").click();
  await expect(page.locator("#dataset-count")).toContainText(
    "24 observations · 7 variables",
  );
  await expect(page.locator("#run")).toBeEnabled();
  await page.locator("#undo").click();
  await expect(page.locator("#dataset-count")).toContainText("6 variables");
  await replaceEditor(page, "count");
  await page.locator("#run").click();
  await expect(page.locator("#results")).toContainText("24 of 24");
  await expect(page.locator("#run-status")).not.toContainText(
    "could not start",
  );
});

test("an unavailable worker asset recovers and saved commands replay without a worker", async ({
  page,
}) => {
  await page.route("**/practice-worker.js", (route) => route.abort());
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await replaceEditor(page, "generate double offline_copy=hours\ncount");
  await page.locator("#run").click();
  await expect(page.locator("#dataset-count")).toContainText("6 variables");
  await page.reload();
  await expect(page.locator("#dataset-count")).toContainText("6 variables");
  await expect(page.locator("#run")).toBeEnabled();
  await page.locator("#undo").click();
  await page.locator("#undo").click();
  await expect(page.locator("#dataset-count")).toContainText("5 variables");
});

for (const mode of ["worker", "fallback"])
  test(`the interface remains responsive during a real 5000-row regression loop and can stop it (${mode})`, async ({
    page,
  }) => {
    if (mode === "fallback")
      await page.addInitScript(() => {
        window.Worker = class {
          constructor() {
            throw new Error("Workers blocked for this test");
          }
        };
      });
    const id = "local_0123456789abcdef";
    const names = ["y", ...Array.from({ length: 9 }, (_, i) => "x" + (i + 1))];
    const csv = [
      names.join(","),
      ...Array.from({ length: 5000 }, (_, i) => {
        const x = Array.from(
          { length: 9 },
          (_, j) =>
            Math.sin((i + 1) * (j + 1) * 0.173) + Math.cos((i + 1) / (j + 2)),
        );
        return [2 + x[0] + 0.5 * x[1] + Math.sin(i * 0.053), ...x]
          .map((v) => v.toFixed(5))
          .join(",");
      }),
    ].join("\n");
    const record = createImportRecord(
      csv,
      "constructed-worker-test.csv",
      previewCSV(csv),
    );
    const state = {
      version: 3,
      mode: "free",
      activeDataset: id,
      current: "first-commands",
      imports: { [id]: record },
      lessons: {},
      free: {},
    };
    await page.addInitScript(
      (value) =>
        localStorage.setItem("stataverse:practice:v2", JSON.stringify(value)),
      state,
    );
    await page.goto("/Learn/");
    await expect(page.locator("#dataset-count")).toContainText(
      "5000 observations",
    );
    await replaceEditor(
      page,
      "generate double pending=1\nforvalues i=1/400 {\n regress y x1-x9\n}",
    );
    await page.evaluate(() => {
      window.__uiTicks = 0;
      window.__uiInterval = setInterval(() => window.__uiTicks++, 16);
    });
    await page.locator("#run").click();
    await expect(page.locator("#run-status")).toContainText(
      "commands completed",
    );
    await expect
      .poll(() => page.evaluate(() => window.__uiTicks))
      .toBeGreaterThan(3);
    await expect(page.locator("#dataset-count")).toContainText("10 variables");
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    await expect(page.locator("#run")).toBeEnabled();
    await expect(page.locator("#data-table thead")).not.toContainText(
      "pending",
    );
    await replaceEditor(page, "count");
    await page.locator("#run").click();
    await expect(page.locator("#results")).toContainText("5000 of 5000");
    await page.evaluate(() => clearInterval(window.__uiInterval));
  });

test("the calculation worker can be opened for the first time offline after the app is cached", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await replaceEditor(
    page,
    "forvalues i=1/2 {\n generate double offline`i'=hours*`i'\n}",
  );
  await page.locator("#run").click();
  await expect(page.locator("#dataset-count")).toContainText("7 variables");
  await page.reload();
  await expect(page.locator("#dataset-count")).toContainText("7 variables");
  await expect(page.locator("#run-status")).toContainText(
    "Restored 2 successful commands",
  );
});
