import { test, expect } from "@playwright/test";
import { screenshotPath } from "../../tools/receipts.mjs";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { IV_INVESTIGATIONS } from "../../src/labs/iv-investigations.js";
test.use({ serviceWorkers: "block" });
const key = "stataverse:labs:v1";

// Numeric expectations are rounded from the independent R/Stata fixture audit.
const numeric = {
  "projected-record": "0.810",
  "reduced-form-ratio": "1.001",
  "strong-first-stage": "299.824",
  "weaken-instrument": "1.148",
  "same-first-stage": "299.824",
  "wrong-limit": "1.800",
  "more-data": "1.800",
};
async function controls(page, advanced = false) {
  await page
    .locator("#iv-controls-disclosure")
    .evaluate((el) => (el.open = true));
  if (advanced)
    await page.locator(".iv-settings").evaluate((el) => (el.open = true));
}
async function configure(page, step) {
  if (step.target) await controls(page, true);
  for (const [name, value] of Object.entries(step.target || {})) {
    const input = page.locator(`#iv-${name}`);
    if ((await input.getAttribute("type")) === "range") {
      await input.evaluate((el, value) => {
        el.value = String(value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
    } else await input.fill(String(value));
  }
  if (step.required?.view)
    await page.locator(`#iv-tab-${step.required.view}`).click();
  if (step.required?.plot)
    await page.locator("#iv-view").selectOption(step.required.plot);
  if (step.required?.selected) {
    await page.locator("#iv-record").fill(String(step.required.selected));
    await page.locator("#iv-record").press("Tab");
  }
  if (step.required?.candidate)
    await page.locator("#iv-candidate").fill(step.required.candidate);
}
async function answer(page, step, correct = true) {
  if (step.question.type === "number")
    await page
      .locator("#iv-guide-number")
      .fill(correct ? numeric[step.id] : "-999");
  else
    await page
      .locator(
        `#iv-guide-inputs input[value="${correct ? step.question.answer : (step.question.answer + 1) % 3}"]`,
      )
      .check();
  await page.locator("#iv-guide-check").click();
}
async function saved(page) {
  await expect(page.locator("#iv-guide-save")).toHaveText(
    "Task, responses and settings saved on this device",
  );
}
const upload = (data) => ({
  name: "iv-backup.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(data)),
});

test("home and search provide direct entries to the advanced investigations", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("link", {
      name: /Predicted values, coefficients and standard errors/,
    })
    .click();
  await expect(page.locator("#iv-guide-title")).toHaveText(
    "An observation's predicted x",
  );
  await saved(page);
  await page.goto("/Search/");
  await page.locator("#site-search").fill("Exclusion, precision");
  await page
    .getByText(
      "Guided investigation: Exclusion, precision and the wrong target",
      { exact: true },
    )
    .click();
  await expect(page.locator("#iv-guide-title")).toHaveText(
    "Exclusion can fail without changing the first stage",
  );
});

test("all 16 IV tasks require the stated experiment and a correct interpretation, with accessible controls", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/Labs/IV/");
  for (const guide of IV_INVESTIGATIONS) {
    await page.locator("#iv-guide-select").selectOption(guide.id);
    for (let i = 0; i < guide.steps.length; i++) {
      const step = guide.steps[i];
      await expect(page.locator("#iv-guide-title")).toHaveText(step.title);
      await expect(page.locator("#iv-guide-next")).toBeDisabled();
      if (step.target || step.required?.selected || step.required?.candidate) {
        await answer(page, step);
        await expect(page.locator("#iv-guide-next")).toBeDisabled();
      }
      await configure(page, step);
      await answer(page, step, false);
      await expect(page.locator("#iv-guide-next")).toBeDisabled();
      await answer(page, step);
      await expect(page.locator("#iv-guide-next")).toBeEnabled();
      await expect(page.locator("#iv-guide-feedback")).toHaveText(
        step.explanation,
      );
      await page
        .locator("#iv-guide-note")
        .fill(`My reasoning for ${guide.title}`);
      await saved(page);
      await expect(page.locator("#iv-guide-next")).toBeEnabled();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      if (step.id === "accepted-tail") {
        await page.screenshot({
          path: screenshotPath(`iv-investigation-${testInfo.project.name}.png`),
          fullPage: true,
        });
        const audit = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze();
        expect(
          audit.violations.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => n.target),
          })),
        ).toEqual([]);
      }
      await page.locator("#iv-guide-next").click();
    }
    await expect(page.locator("#iv-guide-finished")).toContainText(
      `All ${guide.steps.length} tasks`,
    );
  }
  await page.goto("/Workspace/");
  await expect(page.locator("[data-tasks-count]")).toHaveText("16");
  await expect(page.locator("[data-notes-count]")).toHaveText("3");
  await expect(page.locator("#lab-resume-links a")).toHaveCount(3);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export workspace", exact: true })
    .click();
  const backup = JSON.parse(
    await fs.readFile(await (await download).path(), "utf8"),
  );
  expect(
    Object.values(backup.labs.drafts).flatMap((draft) =>
      Object.keys(draft.states),
    ),
  ).toHaveLength(16);
  expect(Object.values(backup.labs.completed).flat()).toHaveLength(16);
  expect(errors).toEqual([]);
});

test("earlier task responses and experiments survive navigation, reset, reload and workspace backup restoration", async ({
  page,
}) => {
  await page.goto("/Labs/IV/#investigation=iv-stages");
  await configure(page, IV_INVESTIGATIONS[0].steps[0]);
  await answer(page, IV_INVESTIGATIONS[0].steps[0]);
  await expect(page.locator("#iv-guide-next")).toBeEnabled();
  await page
    .locator("#iv-guide-note")
    .fill("Fitted x follows z; observed x also includes v.");
  await saved(page);
  await page.locator("#iv-guide-next").click();
  await page.locator("#iv-guide-number").fill("1.002");
  await saved(page);
  await page.locator("#iv-guide-previous").click();
  await expect(page.locator("#iv-record")).toHaveValue("42");
  await expect(page.locator("#iv-guide-number")).toHaveValue("0.810");
  await expect(page.locator("#iv-guide-next")).toBeEnabled();
  await page.locator("#iv-guide-steps").selectOption("1");
  await expect(page.locator("#iv-guide-number")).toHaveValue("1.002");
  await page.locator("#iv-guide-reset").click();
  await expect(page.locator("#iv-guide-number")).toHaveValue("");
  await expect(page.locator("#iv-guide-note")).toHaveValue(
    "Fitted x follows z; observed x also includes v.",
  );
  await page.locator("#iv-guide-number").fill("1.001");
  await saved(page);
  await page.reload();
  await expect(page.locator("#iv-guide-number")).toHaveValue("1.001");
  await saved(page);
  await page.goto("/Workspace/");
  await expect(page.locator("[data-tasks-count]")).toHaveText("1");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export workspace", exact: true })
    .click();
  const backup = JSON.parse(
    await fs.readFile(await (await download).path(), "utf8"),
  );
  expect(backup.labs.generation).toBeUndefined();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Clear local data" }).click();
  await expect(page.locator("#workspace-status")).toContainText("cleared");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#workspace-import").setInputFiles(upload(backup));
  await expect(page.locator("#workspace-status")).toContainText(
    "Backup imported",
  );
  await page.locator("#lab-resume-links a").click();
  await expect(page.locator("#iv-guide-number")).toHaveValue("1.001");
  await page.locator("#iv-guide-previous").click();
  await expect(page.locator("#iv-record")).toHaveValue("42");
  await expect(page.locator("#iv-guide-number")).toHaveValue("0.810");
  await expect(page.locator("#iv-guide-next")).toBeEnabled();
});

test("failed lazy loading leaves exploration available and retry opens the requested task", async ({
  page,
}) => {
  let failed = false;
  await page.route("**/iv-investigation-ui.js*", async (route) => {
    if (!failed) {
      failed = true;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.goto("/Labs/IV/#investigation=iv-weak&step=whole-line");
  await expect(page.locator("#iv-guide-storage")).toContainText(
    "could not load",
  );
  await controls(page);
  await page.locator("#iv-scenario").selectOption("invalid");
  await expect(page.locator("#iv-assumptions")).toContainText("violated");
  await page.locator("#iv-guide-retry").click();
  await expect(page.locator("#iv-guide-title")).toHaveText(
    "No finite bound from this test",
  );
  await expect(page.locator("#iv-set")).toHaveText("All real values");
  await expect(page.locator("#iv-guide-storage")).toBeHidden();
  await answer(page, IV_INVESTIGATIONS[1].steps[2]);
  await expect(page.locator("#iv-guide-next")).toBeEnabled();
});

test("a delayed check cannot advance an edited answer or leave the next task disabled", async ({
  page,
}) => {
  await page.goto("/Labs/IV/#investigation=iv-stages&step=reduced-form-ratio");
  await page.locator("#iv-guide-number").fill("1.001");
  await saved(page);
  await page.evaluate(() => {
    navigator.locks.request(
      "stataverse:lab-progress",
      () =>
        new Promise((resolve) => {
          window.releaseLabLock = resolve;
          window.labLockHeld = true;
        }),
    );
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.labLockHeld)))
    .toBe(true);
  await page.locator("#iv-guide-check").click();
  await expect(page.locator("#iv-guide-check")).toBeDisabled();
  await page.locator("#iv-guide-number").fill("2");
  await page.evaluate(() => window.releaseLabLock());
  await saved(page);
  await expect(page.locator("#iv-guide-check")).toBeEnabled();
  await expect(page.locator("#iv-guide-next")).toBeDisabled();
  await page.locator("#iv-guide-steps").selectOption("2");
  await expect(page.locator("#iv-guide-check")).toBeEnabled();
  await answer(page, IV_INVESTIGATIONS[0].steps[2]);
  await expect(page.locator("#iv-guide-next")).toBeEnabled();
});

test("invalid settings retain the last valid draft and never claim that an unsaved edit is saved", async ({
  page,
}) => {
  await page.goto("/Labs/IV/#investigation=iv-weak");
  await page.locator("#iv-guide-note").fill("Before the invalid edit");
  await saved(page);
  const before = await page.evaluate((key) => localStorage.getItem(key), key);
  await controls(page, true);
  await page.locator("#iv-n").fill("");
  await page
    .locator("#iv-guide-note")
    .fill("A new explanation while n is incomplete");
  await expect(page.locator("#iv-guide-save")).toContainText(
    "last valid draft is retained",
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    before,
  );
  await page.locator("#iv-n").fill("300");
  await saved(page);
  expect(
    JSON.parse(await page.evaluate((key) => localStorage.getItem(key), key))
      .drafts["iv-weak"].note,
  ).toBe("A new explanation while n is incomplete");
});

for (const failure of ["corrupt", "quota"])
  test(`${failure} storage preserves a usable session and an honest exported record`, async ({
    page,
  }) => {
    await page.addInitScript(
      ({ key, failure }) => {
        if (failure === "corrupt")
          localStorage.setItem(key, "unreadable original");
        else {
          const set = Storage.prototype.setItem;
          Storage.prototype.setItem = function (name, value) {
            if (name === key)
              throw new DOMException("full", "QuotaExceededError");
            return set.call(this, name, value);
          };
        }
      },
      { key, failure },
    );
    await page.goto(
      "/Labs/IV/#investigation=iv-stages&step=reduced-form-ratio",
    );
    await expect(page.locator("#iv-guide-storage")).toBeVisible();
    await answer(page, IV_INVESTIGATIONS[0].steps[1]);
    await expect(page.locator("#iv-guide-next")).toBeEnabled();
    await page
      .locator("#iv-guide-note")
      .fill("Keep this reasoning in the export");
    const download = page.waitForEvent("download");
    await page.locator("#export-iv").click();
    const files = unzipSync(await fs.readFile(await (await download).path()));
    const record = JSON.parse(strFromU8(files["investigation.json"]));
    expect(record.savedOnDevice).toBe(false);
    expect(record.checkedCurrentState).toBe(true);
    expect(record.draft.note).toBe("Keep this reasoning in the export");
    if (failure === "corrupt")
      expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
        "unreadable original",
      );
  });

test("clearing an empty workspace invalidates an IV save already waiting behind that clear", async ({
  context,
}) => {
  const workspace = await context.newPage();
  await workspace.goto("/Workspace/");
  await workspace.evaluate(() => {
    navigator.locks.request(
      "stataverse:lab-progress",
      () =>
        new Promise((resolve) => {
          window.releaseLabLock = resolve;
          window.labLockHeld = true;
        }),
    );
  });
  await expect
    .poll(() => workspace.evaluate(() => Boolean(window.labLockHeld)))
    .toBe(true);
  workspace.once("dialog", (dialog) => dialog.accept());
  await workspace.getByRole("button", { name: "Clear local data" }).click();
  // Confirm the clear request is actually queued before creating a second
  // writer; accepting a dialog and queuing its callback are separate events.
  await expect
    .poll(() =>
      workspace.evaluate(
        async () =>
          (await navigator.locks.query()).pending.filter(
            (lock) => lock.name === "stataverse:lab-progress",
          ).length,
      ),
    )
    .toBeGreaterThan(0);
  const lab = await context.newPage();
  await lab.goto("/Labs/IV/#investigation=iv-stages");
  await expect(lab.locator("#iv-guide-title")).toHaveText(
    "An observation's predicted x",
  );
  await expect(lab.locator("#iv-guide-save")).toContainText("Saving");
  await workspace.evaluate(() => window.releaseLabLock());
  await expect(workspace.locator("#workspace-status")).toContainText("cleared");
  await expect(lab.locator("#iv-guide-storage")).toContainText(
    "changed in another tab",
  );
  const raw = await workspace.evaluate((key) => localStorage.getItem(key), key);
  expect(raw === null || !JSON.parse(raw).drafts?.["iv-stages"]).toBe(true);
  await expect(workspace.locator("[data-modules-count]")).toHaveText("0");
});
