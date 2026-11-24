import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const LABS = [
  ["Regression", "01 Regression & adjustment", "Regression and adjustment"],
  [
    "Inference",
    "02 Uncertainty & repeated samples",
    "Uncertainty and repeated samples",
  ],
  ["Data", "03 Merge & reshape", "Merge and reshape"],
  ["IV", "04 Instrumental variables", "Instrumental variables"],
  [
    "Project",
    "05 Panel project",
    "A firm-year panel, from merged file to results table",
  ],
];
const overflow = (page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
const settled = async (page, dir) => {
  if (dir === "Project")
    await page.locator("body[data-project-ready]").waitFor({ timeout: 20000 });
  else await page.waitForLoadState("networkidle");
};

test("the hub lists the five labs and each link opens its lab", async ({
  page,
}) => {
  await page.goto("/Labs/");
  await expect(page.locator("h1")).toHaveText("Analysis labs");
  await expect(page.locator(".lab-card")).toHaveCount(5);
  await expect(
    page.locator('.app-header nav a[aria-current="page"]'),
  ).toHaveText("Analysis labs");
  for (const [index, [dir, label, title]] of LABS.entries()) {
    await page.goto("/Labs/");
    const card = page.locator(".lab-card").nth(index);
    await expect(card.locator("h2 a")).toHaveText(title);
    await expect(card.locator("dt")).toHaveText([
      "You work with",
      "Time",
      "Before you start",
      "In Stata",
    ]);
    await card.locator("h2 a").click();
    await expect(page).toHaveURL(new RegExp(`/Labs/${dir}/$`));
    await expect(
      page.locator('.lab-switcher a[aria-current="page"]'),
    ).toHaveText(label);
    await expect(page.locator(".lab-heading h1")).toHaveText(title);
    await page.locator(".lab-switcher a", { hasText: "All labs" }).click();
    await expect(page).toHaveURL(/\/Labs\/$/);
  }
});

test("the hub fits a phone and a desktop and passes the accessibility scan", async ({
  page,
}) => {
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/Labs/");
    await expect(page.locator(".lab-card")).toHaveCount(5);
    expect(await overflow(page)).toBe(0);
    const audit = await new AxeBuilder({ page }).analyze();
    expect(audit.violations).toEqual([]);
  }
});

test("every lab shows the same chrome on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  for (const [index, [dir, label]] of LABS.entries()) {
    await page.goto(`/Labs/${dir}/`);
    await settled(page, dir);
    expect(await overflow(page), dir).toBe(0);
    // One row, with the current lab scrolled into view.
    const switcher = page.locator(".lab-switcher");
    await expect(switcher.locator("a")).toHaveCount(6);
    const frame = await switcher.boundingBox();
    expect(frame.height, dir).toBeLessThan(48);
    const current = await switcher
      .locator('a[aria-current="page"]')
      .boundingBox();
    expect(current.x, dir).toBeGreaterThanOrEqual(frame.x - 1);
    expect(current.x + current.width, dir).toBeLessThanOrEqual(
      frame.x + frame.width + 1,
    );
    await expect(switcher.locator('a[aria-current="page"]'), dir).toHaveText(
      label,
    );
    // Main navigation labels stay on one line.
    const heights = await page
      .locator(".app-header nav a")
      .evaluateAll((links) =>
        links.map((link) => link.getBoundingClientRect().height),
      );
    expect(Math.max(...heights), dir).toBeLessThanOrEqual(44);
    await expect(page.locator(".lab-mobile-nav"), dir).toBeVisible();
    const footer = page.locator(".lab-footer");
    await expect(
      footer.locator("a", { hasText: "All analysis labs" }),
    ).toHaveAttribute("href", "../");
    await expect(footer.locator('a[rel="prev"]')).toHaveCount(index ? 1 : 0);
    await expect(footer.locator('a[rel="next"]')).toHaveCount(
      index < LABS.length - 1 ? 1 : 0,
    );
  }
});

test("the instrumental-variables shortcut bar reaches controls, estimates and plots", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/Labs/IV/");
  await page.locator("#iv-stages").waitFor();
  for (const [name, target] of [
    ["Plots", "#iv-views"],
    ["Estimates", "#iv-results"],
    ["Controls", "#iv-controls"],
  ]) {
    await page.locator(".lab-mobile-nav button", { hasText: name }).click();
    const top = await page
      .locator(target)
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(Math.abs(top), name).toBeLessThan(120);
  }
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations).toEqual([]);
});

test("tab bars share one style across the labs", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const seen = [];
  for (const [dir] of LABS) {
    await page.goto(`/Labs/${dir}/`);
    await settled(page, dir);
    seen.push(
      await page
        .locator(".lab-tabs")
        .first()
        .evaluate((bar) => {
          const active = bar.querySelector(
            '[aria-selected="true"], [aria-pressed="true"]',
          );
          const style = getComputedStyle(active);
          return [
            style.fontSize,
            style.fontWeight,
            style.borderBottomWidth,
            style.borderBottomColor,
            style.color,
            getComputedStyle(bar).borderBottomColor,
          ].join(" ");
        }),
    );
  }
  expect(new Set(seen).size, seen.join(" | ")).toBe(1);
});
