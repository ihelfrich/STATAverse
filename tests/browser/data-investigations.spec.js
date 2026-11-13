import { test, expect } from "@playwright/test";
import { screenshotPath } from "../../tools/receipts.mjs";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { DATA_INVESTIGATIONS } from "../../src/labs/data-investigations.js";
const key = "stataverse:labs:v1";

async function configure(page, step) {
  for (const [name, value] of Object.entries(step.target || {})) {
    if (name === "keys" || name === "stubs") {
      const prefix =
        name === "keys" ? "#merge-keys input" : 'input[name="reshape-stub"]';
      for (const input of await page.locator(prefix).all())
        await input.setChecked(
          value.includes(await input.getAttribute("value")),
        );
    } else
      await page.locator(`#${step.setup.mode}-${name}`).selectOption(value);
  }
}
async function trace(page, step) {
  if (!step.trace) return;
  let row = page.locator("#output-table tbody tr");
  for (const [name, value] of Object.entries(step.trace.row))
    row = row.filter({
      has: page
        .locator(`td[data-column="${name}"]`)
        .filter({ hasText: new RegExp(`^${value === null ? "\\." : value}$`) }),
    });
  await expect(row).toHaveCount(1);
  await (
    step.trace.column
      ? row.locator(`td[data-column="${step.trace.column}"] button`)
      : row.locator("th button")
  ).click();
}
async function answer(page, step, value = String(step.question.answer)) {
  if (step.question.type === "number")
    await page.locator("#investigation-number").fill(value);
  else
    await page.locator(`#investigation-inputs input[value="${value}"]`).check();
  await page.locator("#investigation-check").click();
}

test("all investigation tasks require actual settings, source inspection and interpretation and persist their progress", async ({
  page,
}, testInfo) => {
  await page.goto("/Labs/Data/");
  for (const guide of DATA_INVESTIGATIONS) {
    await page.locator("#investigation-select").selectOption(guide.id);
    for (let i = 0; i < guide.steps.length; i++) {
      const step = guide.steps[i];
      await expect(page.locator("#investigation-title")).toHaveText(step.title);
      await expect(page.locator("#investigation-next")).toBeDisabled();
      if (step.target || step.trace) {
        await answer(page, step);
        await expect(page.locator("#investigation-next")).toBeDisabled();
      }
      await configure(page, step);
      await trace(page, step);
      await answer(page, step);
      await expect(page.locator("#investigation-feedback")).toHaveText(
        step.explanation,
      );
      await expect(page.locator("#investigation-next")).toBeEnabled();
      await expect
        .poll(
          async () =>
            JSON.parse(
              await page.evaluate((key) => localStorage.getItem(key), key),
            ).completed[guide.id]?.length,
        )
        .toBe(i + 1);
      if (step.id === "conflict-precedence")
        await page.screenshot({
          path: screenshotPath(
            `data-investigation-${testInfo.project.name}.png`,
          ),
          fullPage: true,
        });
      await page.locator("#investigation-next").click();
    }
    await expect(page.locator("#investigation-finished")).toContainText(
      `All ${guide.steps.length} tasks`,
    );
  }
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    audit.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  await page.goto("/Workspace/");
  await expect(page.locator("[data-tasks-count]")).toHaveText("17");
  await expect(page.locator("#lab-resume-links a")).toHaveCount(3);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export workspace", exact: true })
    .click();
  const backup = JSON.parse(
    await fs.readFile(await (await downloaded).path(), "utf8"),
  );
  expect(backup.version).toBe(3);
  expect(Object.values(backup.labs.completed).flat()).toHaveLength(17);
});

test("homepage and search lead directly to the appropriate guided investigation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: /Merge and reshape records/ }).click();
  await expect(page.locator("#investigation-title")).toHaveText(
    "The unique side of a merge",
  );
  await page.goto("/Search/");
  await page.locator("#site-search").fill("Conflicting values");
  await page
    .getByText(
      "Guided investigation: Conflicting values and sample decisions",
      { exact: true },
    )
    .click();
  await expect(page.locator("#investigation-title")).toHaveText(
    "A matched record can contain a conflict",
  );
});

test("task links resume an unchecked step and editing a checked state requires a fresh check", async ({
  page,
}) => {
  await page.goto("/Labs/Data/#investigation=matching-records");
  await answer(page, DATA_INVESTIGATIONS[0].steps[0]);
  await expect(page.locator("#investigation-next")).toBeEnabled();
  await page.goto("/Workspace/");
  await page.locator("#lab-resume-links a").click();
  await expect(page.locator("#investigation-title")).toHaveText(
    "Two orders, one customer",
  );
  await trace(page, DATA_INVESTIGATIONS[0].steps[1]);
  await answer(page, DATA_INVESTIGATIONS[0].steps[1]);
  await page.locator("#investigation-number").fill("3");
  await expect(page.locator("#investigation-next")).toBeDisabled();
  const downloaded = page.waitForEvent("download");
  await page.locator("#export-data").click();
  const files = unzipSync(await fs.readFile(await (await downloaded).path()));
  const record = JSON.parse(strFromU8(files["investigation.json"]));
  expect(record.completed["matching-records"]).toHaveLength(2);
  expect(record.checkedCurrentState).toBe(false);
  expect(record.response).toBe("3");
  expect(record.question).toBe(DATA_INVESTIGATIONS[0].steps[1].question.prompt);
  await page.locator('[data-jump="investigation-answer"]').click();
  await expect(page.locator("#investigation-answer")).toBeFocused();
  await expect(page.locator("#investigation-task")).toBeVisible();
  await page.locator("#investigation-select").selectOption("");
  await expect(page.locator("#investigation-task")).toBeHidden();
  await page.goto(
    "/Labs/Data/#investigation=repeated-measurements&step=changing-group",
  );
  await expect(page.locator("#investigation-title")).toHaveText(
    "Preserve a changing attribute",
  );
  await expect(page.locator("#operation-error")).toBeVisible();
});

test("workspace restores lab progress and stale lab tabs cannot overwrite an imported or cleared copy", async ({
  page,
  context,
}) => {
  await page.goto("/Labs/Data/#investigation=matching-records");
  const workspace = await context.newPage();
  await workspace.goto("/Workspace/");
  const labs = {
    version: 1,
    completed: { "merge-decisions": ["default-overlap"] },
  };
  await workspace.locator("#workspace-import").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ version: 3, labs })),
  });
  await expect(workspace.locator("#workspace-status")).toContainText(
    "Backup imported",
  );
  await expect(page.locator("#investigation-storage")).toContainText(
    "changed in another tab",
  );
  const imported = await page.evaluate((key) => localStorage.getItem(key), key);
  expect(JSON.parse(imported)).toMatchObject(labs);
  await answer(page, DATA_INVESTIGATIONS[0].steps[0]);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    imported,
  );
  await page.reload();
  await answer(page, DATA_INVESTIGATIONS[0].steps[0]);
  await expect(workspace.locator("[data-tasks-count]")).toHaveText("2");
  workspace.once("dialog", (dialog) => dialog.accept());
  await workspace
    .getByRole("button", { name: "Clear local data", exact: true })
    .click();
  await expect(workspace.locator("#workspace-status")).toContainText("cleared");
  const cleared = await page.evaluate((key) => localStorage.getItem(key), key);
  expect(JSON.parse(cleared).completed).toEqual({});
  await page.locator("#investigation-next").click();
  await trace(page, DATA_INVESTIGATIONS[0].steps[1]);
  await answer(page, DATA_INVESTIGATIONS[0].steps[1]);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    cleared,
  );
  await workspace.close();
});

test("blocked storage preserves a usable investigation and project export", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = function () {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
  });
  await page.goto("/Labs/Data/#investigation=matching-records");
  await answer(page, DATA_INVESTIGATIONS[0].steps[0]);
  await expect(page.locator("#investigation-storage")).toContainText(
    "could not save lab progress",
  );
  await expect(page.locator("#investigation-next")).toBeEnabled();
  await expect(page.locator("#export-data")).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("malformed lab backups leave the existing completion record intact", async ({
  page,
}) => {
  await page.goto("/Labs/Data/#investigation=matching-records");
  await answer(page, DATA_INVESTIGATIONS[0].steps[0]);
  await expect(page.locator("#investigation-next")).toBeEnabled();
  const original = await page.evaluate((key) => localStorage.getItem(key), key);
  await page.goto("/Workspace/");
  await page.locator("#workspace-import").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        version: 3,
        labs: {
          version: 1,
          completed: { "matching-records": ["unknown-step"] },
        },
      }),
    ),
  });
  await expect(page.locator("#workspace-status")).toContainText(
    "Import failed",
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    original,
  );
});

test("changing a result while its progress write is waiting does not leave the check control stuck", async ({
  page,
  context,
}) => {
  await page.goto("/Labs/Data/#investigation=matching-records");
  const holder = await context.newPage();
  await holder.goto("/Labs/Data/");
  await holder.evaluate(() => {
    window.lockReady = false;
    navigator.locks.request("stataverse:lab-progress", async () => {
      window.lockReady = true;
      await new Promise((resolve) => (window.releaseLabLock = resolve));
    });
  });
  await expect.poll(() => holder.evaluate(() => window.lockReady)).toBe(true);
  await answer(page, DATA_INVESTIGATIONS[0].steps[0]);
  await expect(page.locator("#investigation-check")).toBeDisabled();
  await page.locator("#merge-keep").selectOption("matched");
  await holder.evaluate(() => window.releaseLabLock());
  await expect(page.locator("#investigation-check")).toBeEnabled();
  await expect(page.locator("#investigation-next")).toBeDisabled();
  await page.locator("#investigation-reset").click();
  await answer(page, DATA_INVESTIGATIONS[0].steps[0]);
  await expect(page.locator("#investigation-next")).toBeEnabled();
  await holder.close();
});
