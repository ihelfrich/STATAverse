import { replaceEditor } from "./editor-helpers.js";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import { LESSONS } from "../../src/lessons.js";
import { PRACTICE_KEY } from "../../src/persistence.js";

test("lesson links within an open workspace change the lesson and preserve the draft", async ({
  page,
}) => {
  let loads = 0;
  page.on("load", () => loads++);
  await page.goto("/Learn/#first-commands");
  await replaceEditor(page, "* draft to retain\ndescribe");
  await page.goto("/Learn/#interactions");
  await expect(page.locator("#lesson-title")).toHaveText(
    "Choose the reference group",
  );
  await expect(page.locator("#track-select")).toHaveValue("models");
  await page.goto("/Learn/#first-commands");
  await expect(page.locator("#command-editor")).toHaveText(
    "* draft to retain\ndescribe",
    { useInnerText: true },
  );
  expect(loads).toBe(1);
});

test("hints reveal progressively without executing commands and numeric answers require the right result", async ({
  page,
}) => {
  await page.goto("/Learn/#do-files");
  await expect(page.locator("#task-hints li")).toHaveCount(0);
  await page.locator("#show-hint").click();
  await expect(page.locator("#task-hints li")).toHaveCount(1);
  await page.locator("#show-hint").click();
  await expect(page.locator("#task-hints li")).toHaveCount(2);
  await expect(page.locator("#show-hint")).toBeDisabled();
  await expect(page.locator("#history-count")).toHaveText("");
  await page.locator("#numeric-answer").fill("22");
  await page.locator("#check-answer").click();
  await expect(page.locator("#next-step")).toBeDisabled();
  await page.locator("#insert-example").click();
  await page.locator("#run").click();
  await expect(page.locator("#next-step")).toBeEnabled();
  await page.locator("#numeric-answer").fill("22 students");
  await page.locator("#check-answer").click();
  await expect(page.locator("#next-step")).toBeDisabled();
  await expect(page.locator("#answer-feedback")).toContainText("without units");
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(audit.violations.map((v) => v.id)).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  if (await page.locator('[data-workspace-jump="check"]').isVisible()) {
    await page.locator('[data-workspace-jump="check"]').click();
    await expect(page.locator("#interpretation")).toBeFocused();
    await page.locator("#free-mode").click();
    await expect(page.locator('[data-workspace-jump="check"]')).toBeHidden();
  }
});

test("repair help adapts after students execute flawed drafts", async ({
  page,
}) => {
  const lesson = LESSONS.find((l) => l.id === "debugging");
  await page.goto("/Learn/#debugging");
  for (const [i, step] of lesson.steps.entries()) {
    if (step.starter) {
      await expect(page.locator("#command-editor")).toHaveText(step.starter, {
        useInnerText: true,
      });
      await page.locator("#run").click();
      await expect(page.locator("#exercise-check")).not.toContainText(
        "expected result",
      );
    }
    await page.locator("#insert-example").click();
    if (step.repairWhen)
      await expect(page.locator("#command-editor")).toContainText("replace");
    await page.locator("#run").click();
    await expect(page.locator("#exercise-check")).toContainText(
      "expected result",
    );
    if (step.response)
      await page
        .locator("#numeric-answer")
        .fill(String(step.response.expected));
    else
      await page
        .locator(`input[name="interpretation"][value="${step.correct}"]`)
        .check();
    await page.locator("#check-answer").click();
    await expect(page.locator("#next-step")).toBeEnabled();
    await page.locator("#next-step").click();
  }
  await expect(page.locator(".completed-panel")).toBeVisible();
  await page.locator("#check-answer").click();
  await expect(page.locator("#next-step")).toBeDisabled();
  await expect(page.locator(".completed-panel")).toHaveCount(1);
});

test("a preserved copy survives replay and exports explicitly retain the current working data", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await replaceEditor(page, 'preserve\nkeep if group == "A"');
  await page.locator("#run").click();
  await expect(page.locator("#dataset-count")).toContainText("12 observations");
  await expect(page.locator("#preserve-status")).toContainText(
    "24 observations",
  );
  await page.reload();
  await page.locator("#free-mode").click();
  await expect(page.locator("#preserve-status")).toContainText(
    "24 observations",
  );
  await page.locator("#export-open").click();
  const pending = page.waitForEvent("download");
  await page.locator("#download-do").click();
  const file = await pending;
  const content = await fs.readFile(await file.path(), "utf8");
  expect(content.trim()).toMatch(/restore, not$/);
  await page.locator("#export-dialog [data-close]").click();
  await replaceEditor(page, "restore");
  await page.locator("#run").click();
  await expect(page.locator("#dataset-count")).toContainText("24 observations");
  await expect(page.locator("#preserve-status")).toBeHidden();
});

test("existing lesson progress remains attached to its original lesson after curriculum expansion", async ({
  page,
}) => {
  await page.addInitScript(
    ({ key }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 2,
          current: "data-quality",
          free: {},
          lessons: {
            "first-commands": {
              step: 3,
              history: [],
              code: "",
              note: "original first lesson note",
              completed: [0, 1, 2, 3],
            },
            "data-quality": {
              step: 1,
              history: ["codebook age wait"],
              code: "duplicates report id",
              note: "Original audit note",
              completed: [0],
            },
          },
        }),
      );
    },
    { key: PRACTICE_KEY },
  );
  await page.goto("/Learn/");
  await expect(page.locator("#track-select")).toHaveValue("data");
  await expect(page.locator("#path-count")).toHaveText(`1/${LESSONS.length}`);
  await expect(page.locator("#lesson-title")).toHaveText(
    "Find duplicate identifiers",
  );
  await expect(page.locator("#student-notes")).toHaveValue(
    "Original audit note",
  );
  await page.locator("#track-select").selectOption("models");
  await expect(page.locator("#lesson-title")).toHaveText(
    "Find duplicate identifiers",
  );
  await page.locator("#track-select").selectOption("beginner");
  if (await page.locator("#lesson-switch").isVisible())
    await page.locator("#lesson-switch").selectOption("first-commands");
  else await page.locator('[data-lesson="first-commands"]').click();
  await expect(page.locator("#student-notes")).toHaveValue(
    "original first lesson note",
  );
});
