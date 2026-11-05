import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import {
  inferenceSample,
  inferenceCSV,
  inferenceDoFile,
  inferenceSimulationDoFile,
} from "../../src/labs/inference-model.js";

// Worker failure/delay interception must not be bypassed by the offline cache.
// Real service-worker behavior is covered separately by deployment verification.
test.use({ serviceWorkers: "block" });

test("inference compares one coefficient and three intervals, with reproducible sample navigation", async ({
  page,
}) => {
  await page.goto("/Labs/Inference/");
  const b = inferenceSample().b.toFixed(3);
  await expect(page.locator("#inference-comparison tbody tr")).toHaveCount(3);
  for (const row of await page.locator("#inference-comparison tbody tr").all())
    await expect(row).toContainText(b);
  await expect(page.locator("#inference-residuals .in-group")).toHaveCount(10);
  await page.locator("#inspect-group").fill("2");
  await page.locator("#inspect-group").press("Tab");
  await expect(
    page.locator('#inference-residuals [data-observation="11"]'),
  ).toHaveClass(/in-group/);
  await page.locator("#next-inference-sample").click();
  await expect(page.locator("#inference-comparison")).toContainText(
    inferenceSample({}, 1).b.toFixed(3),
  );
  await page.locator("#sample-number").fill("1");
  await page.locator("#sample-number").press("Tab");
  await expect(page.locator("#inference-comparison")).toContainText(b);
  await page.locator(".inference-advanced summary").click();
  await page.locator("#inference-nullValue").fill("");
  await page.locator("#inference-nullValue").press("Tab");
  await expect(page.locator("#parameter-status")).toContainText(
    "last valid settings",
  );
  await expect(page.locator("#run-simulation")).toBeDisabled();
  await expect(page.locator("#export-inference")).toBeDisabled();
  await page.locator("#reset-inference").click();
  await expect(page.locator("#run-simulation")).toBeEnabled();
});

test("simulation results connect coverage, interval selection and the exact selected sample", async ({
  page,
}) => {
  await page.goto("/Labs/Inference/");
  await page.locator("#inference-scenario").selectOption("clustered");
  await page.locator("#inference-repetitions").selectOption("200");
  await expect(page.locator("#inference-scenario")).toHaveValue("clustered");
  await page.locator("#run-simulation").click();
  await expect(page.locator("#simulation-status")).toContainText(
    "Completed 200",
  );
  await expect(page.locator("#coverage-comparison .coverage-row")).toHaveCount(
    3,
  );
  await expect(page.locator("#simulation-interpretation")).toContainText(
    "power",
  );
  const axisBefore = await page
    .locator("#repeated-intervals .target")
    .getAttribute("x1");
  await page.locator("#interval-method").selectOption("cluster");
  expect(
    await page.locator("#repeated-intervals .target").getAttribute("x1"),
  ).toBe(axisBefore);
  await page.locator("#repeated-intervals svg").press("ArrowRight");
  await expect(page.locator("#interval-window")).toContainText(
    "Selected sample 2",
  );
  await page.locator("#repeated-intervals svg").press("End");
  await expect(page.locator("#interval-window")).toContainText(
    "Selected sample 200",
  );
  await page.locator("#inspect-repetition").click();
  await expect(page.locator("#sample-number")).toHaveValue("200");
  const expected = inferenceSample({ errorICC: 0.6, xICC: 0.7 }, 199);
  await expect(page.locator("#inference-comparison")).toContainText(
    expected.b.toFixed(3),
  );
  await page.locator("#inference-scenario").selectOption("independent");
  await page.locator("#inference-tab-repeated").click();
  await expect(page.locator("#simulation-results")).not.toBeVisible();
  await expect(page.locator("#simulation-empty")).toBeVisible();
});

test("experiment export contains the displayed sample and all completed repetitions", async ({
  page,
}) => {
  await page.goto("/Labs/Inference/");
  await page.locator("#inference-repetitions").selectOption("50");
  await page.locator("#run-simulation").click();
  await expect(page.locator("#simulation-status")).toContainText(
    "Completed 50",
  );
  await page.locator("#inference-tab-sample").click();
  await page.locator("#sample-number").fill("7");
  await page.locator("#sample-number").press("Tab");
  const pending = page.waitForEvent("download");
  await page.locator("#export-inference").click();
  const files = unzipSync(await fs.readFile(await (await pending).path()));
  const sample = inferenceSample({ repetitions: 50 }, 6);
  const actualRows = strFromU8(files["inference-sample.csv"])
    .trim()
    .split(/\r?\n/);
  const expectedRows = inferenceCSV(sample).trim().split(/\r?\n/);
  expect(actualRows.length).toBe(expectedRows.length);
  expect(actualRows[0]).toBe(expectedRows[0]);
  // Browser and Node libm implementations can differ in the last binary digit.
  actualRows
    .slice(1)
    .forEach((row, i) =>
      row
        .split(",")
        .forEach((value, j) =>
          expect(Number(value)).toBeCloseTo(
            Number(expectedRows[i + 1].split(",")[j]),
            12,
          ),
        ),
    );
  expect(strFromU8(files["analysis.do"])).toBe(inferenceDoFile(sample));
  expect(strFromU8(files["simulation.do"])).toBe(
    inferenceSimulationDoFile({ repetitions: 50 }),
  );
  const metadata = JSON.parse(strFromU8(files["experiment.json"]));
  expect(metadata.sampleNumber).toBe(7);
  expect(metadata.completedRepetitions).toBe(50);
  expect(strFromU8(files["repetitions.csv"]).trim().split("\n")).toHaveLength(
    51,
  );
  expect(metadata.summary.methods.conventional.coverage.total).toBe(50);
});

test("canceling a delayed worker excludes the unfinished run and permits a clean restart", async ({
  page,
}) => {
  // Hold only the test's worker response, so cancellation is deterministic on fast hardware.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/inference-worker.js", async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  await page.goto("/Labs/Inference/");
  await page.locator("#run-simulation").click();
  await page.locator("#cancel-simulation").click();
  release();
  await expect(page.locator("#simulation-status")).toContainText("canceled");
  await expect(page.locator("#simulation-results")).not.toBeVisible();
  await page.unroute("**/inference-worker.js");
  await page.locator("#inference-repetitions").selectOption("50");
  await page.locator("#run-simulation").click();
  await expect(page.locator("#simulation-status")).toContainText(
    "Completed 50",
  );
  await expect(page.locator("#parameter-fields")).toBeEnabled();
});

test("all inference views support keyboard tabs, accessible controls and narrow layouts", async ({
  page,
}) => {
  await page.goto("/Labs/Inference/");
  await page.locator("#inference-repetitions").selectOption("50");
  await page.locator("#run-simulation").click();
  await expect(page.locator("#simulation-results")).toBeVisible();
  for (const view of ["sample", "repeated", "method"]) {
    await page.locator(`#inference-tab-${view}`).click();
    const audit = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      audit.violations.map((v) => ({
        id: v.id,
        targets: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.locator("#inference-tab-method").press("Home");
  await expect(page.locator("#inference-tab-sample")).toBeFocused();
  await page.locator("#inference-tab-sample").press("ArrowRight");
  await expect(page.locator("#inference-tab-repeated")).toBeFocused();
  await page.locator("#inference-tab-method").click();
  await page.locator("#inference-code-kind").selectOption("simulation");
  await expect(page.locator("#inference-code")).toContainText(
    "program define stataverse_inference_draw",
  );
  await expect(page.locator("#inference-code")).toContainText("reps(50)");
});

test("a failed worker leaves the single sample and export available", async ({
  page,
}) => {
  await page.route("**/inference-worker.js", (route) => route.abort());
  await page.goto("/Labs/Inference/");
  await page.locator("#run-simulation").click();
  await expect(page.locator("#simulation-status")).toContainText(
    "could not finish",
  );
  await expect(page.locator("#export-inference")).toBeEnabled();
  await page.locator("#inference-tab-sample").click();
  await expect(page.locator("#inference-comparison tbody tr")).toHaveCount(3);
});

test("the largest supported experiment completes without truncating its samples", async ({
  page,
}) => {
  await page.goto("/Labs/Inference/");
  await page.locator("#inference-groups").fill("100");
  await page.locator("#inference-groups").press("Tab");
  await page.locator("#inference-perGroup").fill("50");
  await page.locator("#inference-perGroup").press("Tab");
  await expect(
    page.locator("#inference-residuals [data-observation]"),
  ).toHaveCount(5000);
  await page.locator("#inference-repetitions").selectOption("2000");
  await page.locator("#run-simulation").click();
  await expect(page.locator("#simulation-status")).toContainText(
    "Completed 2,000",
    { timeout: 20000 },
  );
  await expect(page.locator("#simulation-count")).toContainText(
    "2,000 completed",
  );
  await page.locator("#repeated-intervals svg").press("End");
  await expect(page.locator("#interval-window")).toContainText(
    "Selected sample 2000",
  );
});
