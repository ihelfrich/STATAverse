import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
const stage = async (page, n) => page.locator(`[data-stage="${n}"]`).click();
test("beginner path creates a do-file with Windows paths, ordered preparation and regression", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/ScriptLibrary/builder.html");
  await expect(page.locator("#download-do")).toBeDisabled();
  await page.locator("#os").selectOption("windows");
  await expect(page.locator("#windows-path")).toBeVisible();
  await page.locator("#project").fill('"C:\\Users\\Student\\Course project"');
  await page.locator("#next-stage").click();
  await page.locator("#file").fill("data/survey.csv");
  await stage(page, 2);
  await page.locator("#operation").selectOption("log");
  await page.locator("#add-operation").click();
  await page.locator("#step-0-variable").fill("income");
  await page.locator("#step-0-target").fill("ln_income");
  await stage(page, 3);
  await page.locator("#method").selectOption("ols");
  await page.locator("#outcome").fill("score");
  await page.locator("#predictors").fill("ln_income attendance");
  await stage(page, 4);
  await expect(page.locator("#download-do")).toBeEnabled();
  const text = await page.locator("#builder-code").inputValue();
  expect(text).toContain('cd "C:/Users/Student/Course project"');
  expect(text).toContain("assert income > 0 if !missing(income)");
  expect(text).toContain("regress score ln_income attendance, vce(robust)");
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    audit.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#download-do").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("analysis.do");
  expect(await fs.readFile(await download.path(), "utf8")).toBe(text);
  await page.reload();
  await expect(page.locator("#builder-code")).toHaveValue(text);
  await page.screenshot({
    path: `docs/verification/screenshots/builder-${testInfo.project.name}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("advanced choices, editable code and workspace backup preserve the plan", async ({
  page,
}) => {
  await page.goto("/ScriptLibrary/builder.html");
  await page.locator("#project").fill("/Users/student/project");
  await stage(page, 1);
  await page.locator("#file").fill("data.dta");
  await page.locator("#format").selectOption("dta");
  await page.locator("#level").selectOption("advanced");
  await stage(page, 3);
  await page.locator("#method").selectOption("iv");
  await page.locator("#outcome").fill("wage");
  await page.locator("#endogenous").fill("education");
  await page.locator("#instruments").fill("distance");
  await expect(page.locator("#download-do")).toBeEnabled();
  await page.locator("#level").selectOption("beginner");
  await expect(page.locator("#method")).toHaveValue("iv");
  await page.locator("#edit-code").click();
  await page.locator("#builder-code").fill("* My additions\ndescribe\n");
  await page.locator("#outcome").fill("earnings");
  await expect(page.locator("#builder-code")).toHaveValue(
    "* My additions\ndescribe\n",
  );
  await page.goto("/Workspace/");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("[data-export-notes]").click();
  const download = await downloadPromise;
  const backup = JSON.parse(await fs.readFile(await download.path(), "utf8"));
  expect(backup.builder.outcome).toBe("earnings");
  expect(backup.builder.edited).toBe("* My additions\ndescribe\n");
  await page.evaluate(() =>
    localStorage.removeItem("stataverse:do-builder:v1"),
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#workspace-import").setInputFiles({
    name: "workspace.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.locator("#workspace-status")).toContainText(
    "Backup imported",
  );
  await page.goto("/ScriptLibrary/builder.html");
  await expect(page.locator("#builder-code")).toHaveValue(
    backup.builder.edited,
  );
  await page.locator("#regenerate-code").click();
  await expect(page.locator("#builder-code")).toHaveValue(
    /ivregress 2sls earnings \(education = distance\)/,
  );
});
test("invalid paths and preparation values block generated export and cross-tab changes preserve stored plans", async ({
  page,
  context,
}) => {
  await page.goto("/ScriptLibrary/builder.html");
  await page.locator("#project").fill("/tmp/$data");
  await stage(page, 1);
  await page.locator("#file").fill("data.csv");
  await stage(page, 4);
  await expect(page.locator("#download-do")).toBeDisabled();
  await expect(page.locator("#plan-errors")).toContainText("macro delimiter");
  const second = await context.newPage();
  await second.goto("/ScriptLibrary/builder.html");
  await stage(second, 0);
  await second.locator("#project").fill("/tmp/updated");
  await expect(page.locator("#builder-storage")).toContainText(
    "Another tab changed",
  );
  await stage(page, 0);
  await page.locator("#project").fill("/tmp/stale");
  expect(
    JSON.parse(
      await page.evaluate(() =>
        localStorage.getItem("stataverse:do-builder:v1"),
      ),
    ).project,
  ).toBe("/tmp/updated");
  await second.close();
});
