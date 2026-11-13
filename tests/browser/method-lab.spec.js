import { test, expect } from "@playwright/test";
import { screenshotPath } from "../../tools/receipts.mjs";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";

const query =
  "outcome=binary&structure=panel&design=unresolved&dependence=clustered";
async function select(page, changes = {}) {
  const choices = {
    outcome: "binary",
    structure: "panel",
    design: "unresolved",
    dependence: "clustered",
    ...changes,
  };
  for (const [name, value] of Object.entries(choices))
    await page.locator(`#method-${name}`).selectOption(value);
}

test("method comparison keeps unresolved design visible and preserves selected choices in its address", async ({
  page,
}) => {
  await page.goto("/MethodLab/");
  await expect(page.locator("#method-fields")).toBeEnabled();
  await expect(page.locator("#method-download")).toBeDisabled();
  await select(page);
  await expect(page.locator("#method-cards article")).toHaveCount(3);
  await expect(page.locator("#method-card-lpm")).toContainText(
    "A 0/1 outcome does not prohibit OLS",
  );
  await expect(page.locator("#method-notices")).toContainText(
    "The causal interpretation is unresolved",
  );
  await expect(page.locator("#method-card-iv, #method-card-did")).toHaveCount(
    0,
  );
  await expect(page).toHaveURL(new RegExp(query + "$"));
  await page.reload();
  await expect(page.locator("#method-design")).toHaveValue("unresolved");
  await page.locator("#method-jump").click();
  await expect(page.locator("#comparison-title")).toBeInViewport();
  await page.locator(".method-change").click();
  await expect(page.locator("#setup-title")).toBeInViewport();
  await page.locator("#method-design").selectOption("iv");
  await expect(page.locator("#method-card-iv")).toContainText(
    "credible exclusion/exogeneity",
  );
  await expect(page.locator("#method-notices")).toContainText(
    "not successive steps in one recipe",
  );
  await page.locator("#method-dependence").selectOption("survey");
  await page.locator("#method-card-iv summary").click();
  const code = await page.locator("#method-card-iv code").textContent();
  expect(code.split("\n").every((line) => line.startsWith("*"))).toBe(true);
  await page.locator("#method-reset").click();
  await expect(page.locator("#method-results")).toBeHidden();
  await expect(page.locator("#method-download")).toBeDisabled();
  await expect(page).toHaveURL(/\/MethodLab\/$/);
});

test("comparison download and blocked clipboard fallback retain assumptions and real newlines", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("blocked")) },
    }),
  );
  await page.goto("/MethodLab/?" + query);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#method-download").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("stataverse-method-comparison.txt");
  const text = await fs.readFile(await download.path(), "utf8");
  expect(text).toContain("The causal interpretation is unresolved");
  expect(text).toContain("Strict exogeneity");
  expect(text).toContain("Limit:");
  expect(text).toContain("Reopen this comparison:");
  expect(text.split("\n").length).toBeGreaterThan(50);
  expect(text).not.toContain("\\n");
  await page.locator("#method-copy").click();
  await expect(page.locator("#method-copy-fallback")).toHaveValue(text);
  await expect(page.locator("#method-copy-fallback")).toBeFocused();
  await page.locator("#method-design").selectOption("association");
  await expect(page.locator("#method-copy-fallback")).toBeHidden();
});

test("a delayed clipboard failure cannot resurrect an earlier comparison", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: () =>
          new Promise((resolve, reject) => {
            window.failCopy = reject;
          }),
      },
    }),
  );
  await page.goto("/MethodLab/?" + query);
  await page.locator("#method-copy").click();
  await page.locator("#method-design").selectOption("did");
  await page.evaluate(() => window.failCopy(new Error("blocked")));
  await expect(page.locator("#method-action-status")).toHaveText("");
  await expect(page.locator("#method-copy-fallback")).toBeHidden();
  await expect(page.locator("#method-card-did")).toBeVisible();
});

test("unknown query values cannot enter the comparison, and browser history restores valid choices", async ({
  page,
}) => {
  await page.goto(
    "/MethodLab/?outcome=%3Cimg%20onerror%3Dalert(1)%3E&design=bogus",
  );
  await expect(page.locator("#method-outcome")).toHaveValue("");
  await expect(page.locator("#method-download")).toBeDisabled();
  await expect(page.locator("#method-cards img")).toHaveCount(0);
  await select(page);
  await page.locator(".wordmark").click();
  await page.goBack();
  await expect(page.locator("#method-design")).toHaveValue("unresolved");
  await expect(page.locator("#method-cards article")).toHaveCount(3);
});

test("the method comparison remains accessible with expanded syntax on desktop and mobile", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    "/MethodLab/?outcome=count&structure=panel&design=iv&dependence=clustered",
  );
  await expect(page.locator("#method-card-panelCount")).toBeVisible();
  await page.locator("#method-card-panelCount summary").click();
  await expect(page.locator("#method-card-panelCount code")).toContainText(
    "poisson y x1 x2 i.id i.time, vce(cluster cluster_id)",
  );
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
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.locator("#method-card-panelCount pre").focus();
  await expect(page.locator("#method-card-panelCount pre")).toBeFocused();
  await page.locator("#method-jump").click();
  await page.screenshot({
    path: screenshotPath(`method-comparison-${testInfo.project.name}.png`),
    fullPage: false,
  });
  expect(errors).toEqual([]);
});

test("new comparison addresses reload offline without a prior request for that query", async ({
  page,
  context,
}) => {
  await page.goto("/MethodLab/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await select(page, { outcome: "fraction", design: "did" });
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#method-card-did")).toBeVisible();
  await expect(page.locator("#method-outcome")).toHaveValue("fraction");
  await page.goto("/MethodLab/index.html?" + query);
  await expect(page.locator("#method-card-lpm")).toBeVisible();
  await context.setOffline(false);
});

test("without JavaScript the reference download and reading links remain available", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4173/MethodLab/");
  await expect(
    page.getByText(/The comparison controls require JavaScript/),
  ).toBeVisible();
  await expect(page.locator("#method-loading")).toBeHidden();
  await expect(
    page.getByRole("link", { name: "Stata method reference (.do)" }),
  ).toBeVisible();
  await expect(page.locator("#method-copy")).toBeDisabled();
  await context.close();
});
