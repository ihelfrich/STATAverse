import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { LESSONS } from "../../src/lessons.js";
import { unzipSync, strFromU8 } from "fflate";
import fs from "node:fs/promises";
test("command strings and variable labels remain text in the output", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await page
    .locator("#command-editor")
    .fill(
      'label variable hours "<img src=x onerror=alert(1)>"\ndescribe hours',
    );
  await page.locator("#run").click();
  await expect(page.locator("#results")).toContainText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(page.locator("#results img")).toHaveCount(0);
});
test("reference pages expose labeled controls and readable contrast", async ({
  page,
}) => {
  test.setTimeout(120000);
  for (const path of [
    "/Workspace/",
    "/CodeLibrary/",
    "/Search/",
    "/MethodLab/",
    "/ZeroToHero/",
    "/Glossary/concept.html?id=endogeneity",
    "/ZeroToHero/modules/02-ols-intuition.html",
  ]) {
    await page.goto(path);
    if (path.includes("id=") || path.includes("modules/"))
      await page.locator("[data-md] h2").first().waitFor();
    const audit = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      audit.violations.map((v) => ({
        id: v.id,
        targets: v.nodes.map((n) => n.target),
      })),
      path,
    ).toEqual([]);
  }
});
test("homepage preview computes results and leads to the workspace", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('[data-preview="regress"]').click();
  await expect(page.locator("#preview-result")).toContainText("5.277");
  await page.locator('[data-preview="summarize"]').click();
  await expect(page.locator("#preview-result")).toContainText("23");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(audit.violations.map((v) => v.id)).toEqual([]);
  await page
    .getByRole("link", { name: "Start with your first command" })
    .click();
  await expect(page.locator("#command-editor")).toBeVisible();
});
test("previously loaded practice remains usable offline", async ({
  page,
  context,
}) => {
  await page.goto("/Learn/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await context.setOffline(true);
  await page.reload();
  await page.locator("#run").click();
  await expect(page.locator("#exercise-check")).toContainText(
    "expected result",
  );
  await context.setOffline(false);
});
test("reference lessons and equations load without third-party scripts", async ({
  page,
}) => {
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
  await page.goto("/Glossary/concept.html?id=endogeneity");
  await expect(page.locator("[data-md]")).toContainText(
    "relationship to the error term",
  );
  await expect(page.locator(".katex").first()).toBeVisible();
  await expect(page.locator(".katex-error")).toHaveCount(0);
  await page.goto("/ZeroToHero/modules/02-ols-intuition.html");
  await expect(page.locator("[data-md]")).toContainText("59.407");
  await expect(page.locator(".katex").first()).toBeVisible();
  await expect(page.locator("canvas[data-chart]")).toHaveAttribute(
    "aria-label",
    "144 observations: sales against price",
  );
  expect(
    await page
      .locator("canvas[data-chart]")
      .evaluate(
        (canvas) => window.Chart.getChart(canvas).data.datasets[0].data.length,
      ),
  ).toBe(144);
});
test("complete the first lesson, retain progress, and prevent premature advancement", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/Learn/");
  await expect(page.locator("#next-step")).toBeDisabled();
  for (const [i, step] of LESSONS[0].steps.entries()) {
    await page.locator("#insert-example").click();
    await page.locator("#run").click();
    await expect(page.locator("#exercise-check")).toContainText(
      "expected result",
    );
    await expect(page.locator("#next-step")).toBeDisabled();
    await page
      .locator(`input[name="interpretation"][value="${step.correct}"]`)
      .check();
    await page.locator("#check-answer").click();
    await expect(page.locator("#next-step")).toBeEnabled();
    await page.locator("#next-step").click();
  }
  await expect(page.locator(".completed-panel")).toBeVisible();
  await expect(page.locator("#path-count")).toHaveText("1/8");
  await page.reload();
  await expect(page.locator("#path-count")).toHaveText("1/8");
  expect(errors).toEqual([]);
});
test("all lessons can be completed through actual controls", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/Learn/");
  for (const lesson of LESSONS.slice(1)) {
    if (await page.locator("#lesson-switch").isVisible())
      await page.locator("#lesson-switch").selectOption(lesson.id);
    else await page.locator(`[data-lesson="${lesson.id}"]`).click();
    for (const step of lesson.steps) {
      await page.locator("#insert-example").click();
      await page.locator("#run").click();
      await expect(page.locator("#exercise-check")).toContainText(
        "expected result",
      );
      await page
        .locator(`input[name="interpretation"][value="${step.correct}"]`)
        .check();
      await page.locator("#check-answer").click();
      await page.locator("#next-step").click();
    }
    await expect(page.locator(".completed-panel")).toBeVisible();
  }
});
test("an unsupported estimator cannot fabricate output or change data", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await page
    .locator("#command-editor")
    .fill("regress score hours, vce(cluster id)\nclear");
  await page.locator("#run").click();
  await expect(page.locator("#results")).toContainText("not supported");
  await expect(page.locator("#dataset-count")).toContainText("24 observations");
  await expect(page.locator(".result-table")).toHaveCount(0);
});
test("data mutation is visible and undo restores it", async ({ page }) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await page
    .locator("#command-editor")
    .fill("generate double minutes = hours * 60");
  await page.locator("#run").click();
  await expect(page.locator('[data-variable="minutes"]')).toBeVisible();
  await page.locator('[data-variable="minutes"]').click();
  await expect(page.locator("#variable-detail")).toContainText("1 missing");
  await page.locator("#undo").click();
  await expect(page.locator('[data-variable="minutes"]')).toHaveCount(0);
  await expect(page.locator("#dataset-count")).toContainText("5 variables");
});
test("regression, line controls and exported project contain actual work", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await page.locator("#free-mode").click();
  await page.locator("#command-editor").fill("regress score hours");
  await page.locator("#run").click();
  await page.locator('[data-coefficient="hours"]').click();
  await expect(page.locator(".result-annotation")).toContainText("5.277");
  await page.locator("#tab-graph").click();
  await expect(page.locator(".plot")).toBeVisible();
  const original = await page.locator(".sse-line").textContent();
  await page.locator("#slope").fill("3");
  await expect(page.locator(".sse-line")).not.toHaveText(original);
  await page.locator("#reset-line").click();
  await expect(page.locator(".sse-line")).toHaveText(original);
  await page.locator("#export-open").click();
  const waiting = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download complete Stata project (.zip)" })
    .click();
  const download = await waiting;
  const bytes = await fs.readFile(await download.path());
  const archive = unzipSync(bytes);
  expect(Object.keys(archive)).toEqual(
    expect.arrayContaining([
      "analysis.do",
      "study.csv",
      "wages.csv",
      "clinic.csv",
      "notes.txt",
    ]),
  );
  expect(strFromU8(archive["analysis.do"])).toContain("regress score hours");
  expect(strFromU8(archive["study.csv"])).toContain(
    "id,hours,attendance,score,group",
  );
});
test("storage failure is visible and does not prevent practice", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });
  await page.goto("/Learn/");
  await expect(page.locator("#storage-warning")).toBeVisible();
  await page.locator("#run").click();
  await expect(page.locator("#results")).toContainText("describe");
  await expect(page.locator("#exercise-check")).toContainText(
    "expected result",
  );
});
test("tabs support keyboard navigation and dialogs restore focus", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await page.locator("#tab-data").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#tab-results")).toBeFocused();
  await expect(page.locator("#panel-results")).toBeVisible();
  await page.locator("#help-open").click();
  await expect(page.locator("#help-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#help-open")).toBeFocused();
});
test("workspace has no document overflow or serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/Learn/");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    audit.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
});
