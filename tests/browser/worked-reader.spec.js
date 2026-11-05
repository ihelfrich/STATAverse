import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import { WORKED_EXAMPLES } from "../../src/worked-examples.js";

test("all seven examples expose their real sections and return to the library", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/CodeLibrary/");
  await expect(page.locator(".example-list-row")).toHaveCount(7);
  for (const example of WORKED_EXAMPLES) {
    await page.locator(`#example-${example.id} h2 a`).click();
    await expect(page.locator("#example-title")).toHaveText(example.title);
    await expect(page.locator("#example-source")).toContainText("clear");
    await expect(page.locator("#example-sections a")).toHaveCount(
      example.sections.length,
    );
    await page.locator("#example-sections a").last().click();
    await expect(page.locator("#example-section-title")).toHaveText(
      example.sections.at(-1),
    );
    await expect(page.locator("#example-next")).toBeDisabled();
    await page.locator("#example-back").click();
    await expect(page.locator("#library-title")).toBeFocused();
  }
  expect(errors).toEqual([]);
});
test("all eight panel interpretations give specific feedback and retain choices while changing sections", async ({
  page,
}, testInfo) => {
  await page.goto("/CodeLibrary/?example=panel");
  const panel = WORKED_EXAMPLES.find((e) => e.id === "panel");
  for (let index = 1; index < panel.guides.length; index++) {
    const q = panel.guides[index].question;
    await page.locator(`#example-sections a[data-section="${index}"]`).click();
    await expect(page.locator("#example-check")).toBeDisabled();
    const wrong = (q.correct + 1) % q.options.length;
    await page.locator(`#example-options input[value="${wrong}"]`).check();
    await page.locator("#example-check").click();
    await expect(page.locator("#example-feedback")).toContainText(
      q.feedback[wrong],
    );
    await page.locator(`#example-options input[value="${q.correct}"]`).check();
    await expect(page.locator("#example-feedback")).toHaveText("");
    await page.locator("#example-check").click();
    await expect(page.locator("#example-feedback.correct")).toContainText(
      q.feedback[q.correct],
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await page.locator('#example-sections a[data-section="3"]').click();
  await expect(page.locator("#example-feedback.correct")).toBeVisible();
  await expect(page.locator("#example-native-table table")).toBeVisible();
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    audit.violations.map((v) => ({
      id: v.id,
      targets: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  await page.screenshot({
    path: `docs/verification/screenshots/worked-panel-${testInfo.project.name}.png`,
    fullPage: false,
  });
  await page.reload();
  await expect(page.locator("#example-section-title")).toHaveText(
    panel.sections[3],
  );
  await expect(page.locator("#example-check")).toBeDisabled();
});
test("source search opens the correct line and browser history restores the preceding section", async ({
  page,
}) => {
  await page.goto("/CodeLibrary/?example=panel&section=section-2");
  await page
    .locator("#example-search")
    .fill("experience_mean competition_mean");
  await page.locator("#example-search").press("Enter");
  await expect(page.locator("#example-matches button")).toHaveCount(1);
  await page.locator("#example-matches button").click();
  await expect(page.locator("#example-section-title")).toHaveText(
    "Within-between decomposition",
  );
  await expect(page.locator(".code-source-line.selected")).toContainText(
    "experience_mean competition_mean",
  );
  await expect(page).toHaveURL(/section=section-3#L\d+$/);
  await page.reload();
  await expect(page.locator(".code-source-line.selected")).toContainText(
    "experience_mean competition_mean",
  );
  await page.goBack();
  await expect(page.locator("#example-section-title")).toHaveText(
    "Pooled, fixed-effects and random-effects fits",
  );
  await page.locator("#example-search").fill(".*");
  await page.locator("#example-search").press("Enter");
  await expect(page.locator("#example-search-status")).toHaveText(
    "0 matching lines.",
  );
});
test("download and denied clipboard fallback preserve the complete source bytes", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("blocked")) },
    }),
  );
  await page.goto("/CodeLibrary/?example=panel&section=section-3");
  const expected = await fs.readFile(
    "CodeLibrary/scripts/06_panel_data_toolkit.do",
    "utf8",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#example-download").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("06_panel_data_toolkit.do");
  expect(await fs.readFile(await download.path(), "utf8")).toBe(expected);
  await page.locator("#example-copy").click();
  await expect(page.locator("#example-copy-text")).toHaveValue(expected);
  await expect(page.locator("#example-copy-text")).toBeFocused();
  await page.locator("#example-switch").selectOption("regression");
  await expect(page.locator("#example-copy-fallback")).toBeHidden();
});
test("visited source and a newly selected section reopen offline without caching that query", async ({
  page,
  context,
}) => {
  await page.goto("/CodeLibrary/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.locator("#example-panel h2 a").click();
  await expect(page.locator("#example-download")).toBeEnabled();
  await page.locator('#example-sections a[data-section="3"]').click();
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#example-source")).toContainText(
    "estimates store hybrid",
  );
  await expect(page.locator("#example-native-table table")).toBeVisible();
  await page.locator("#example-switch").selectOption("regression");
  await expect(page.locator("#example-load-status")).toContainText(
    "could not be loaded",
  );
  await expect(page.locator("#example-download")).toBeDisabled();
  await expect(page.locator("#example-source")).toBeHidden();
  await context.setOffline(false);
  await page.locator("#example-retry").click();
  await expect(page.locator("#example-source")).toContainText("set more off");
});
test.describe("untrusted or delayed file responses", () => {
  test.use({ serviceWorkers: "block" });
  test("a mismatched source cannot show stale reference output or become a download", async ({
    page,
  }) => {
    await page.route("**/scripts/06_panel_data_toolkit.do", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: 'display "<img src=x onerror=alert(1)>"',
      }),
    );
    await page.goto("/CodeLibrary/?example=panel&section=section-3");
    await expect(page.locator("#example-load-status")).toContainText(
      "different versions",
    );
    await expect(page.locator("#example-download")).toBeDisabled();
    await expect(page.locator("#example-native-output")).toBeHidden();
    await page.unroute("**/scripts/06_panel_data_toolkit.do");
    await page.locator("#example-retry").click();
    await expect(page.locator("#example-native-table table")).toBeVisible();
  });
  test("an old pending source cannot replace a later navigation", async ({
    page,
  }) => {
    let release, settled;
    const held = new Promise((resolve) => (release = resolve));
    const finished = new Promise((resolve) => (settled = resolve));
    await page.route("**/scripts/06_panel_data_toolkit.do", async (route) => {
      await held;
      await route.continue().catch(() => {});
      settled();
    });
    await page.goto("/CodeLibrary/?example=panel");
    await expect(page.locator("#example-load-status")).toHaveText(
      "Loading the do-file…",
    );
    await page.locator("#example-back").click();
    await page.locator("#example-regression h2 a").click();
    await expect(page.locator("#example-source")).toContainText(
      "Understanding Regression",
    );
    release();
    await finished;
    await expect(page.locator("#example-title")).toHaveText(
      "Reading a regression",
    );
    await expect(page.locator("#example-source")).toContainText(
      "Understanding Regression",
    );
  });
  test("unmatched reference estimates never appear beside the current source", async ({
    page,
  }) => {
    await page.route("**/assets/data/panel-output.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sourceSha256: "old-version", rows: [] }),
      }),
    );
    await page.goto("/CodeLibrary/?example=panel&section=section-3");
    await expect(page.locator("#example-native-table")).toContainText(
      "Reference estimates are unavailable",
    );
    await expect(page.locator("#example-native-table table")).toHaveCount(0);
    await expect(page.locator("#example-download")).toBeEnabled();
  });
  test("late clipboard failures cannot restore text from a previously selected example", async ({
    page,
  }) => {
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: () =>
            new Promise((resolve, reject) => {
              window.rejectOldCopy = reject;
            }),
        },
      }),
    );
    await page.goto("/CodeLibrary/?example=panel");
    await page.locator("#example-copy").click();
    await page.locator("#example-switch").selectOption("regression");
    await expect(page.locator("#example-download")).toBeEnabled();
    await page.evaluate(() => window.rejectOldCopy(new Error("blocked")));
    await expect(page.locator("#example-copy-fallback")).toBeHidden();
    await expect(page.locator("#example-action-status")).toHaveText("");
  });
});
test("unknown example URLs cannot request arbitrary paths, and no-script downloads remain accessible", async ({
  page,
  browser,
}) => {
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/CodeLibrary/?example=..%2Funknown.do");
  await expect(page.locator("#example-title")).toHaveText("Example not found");
  expect(requests.some((url) => url.endsWith("/unknown.do"))).toBe(false);
  const context = await browser.newContext({ javaScriptEnabled: false }),
    plain = await context.newPage();
  await plain.goto("http://127.0.0.1:4173/CodeLibrary/?example=panel");
  await expect(plain.locator("#example-panel a[download]")).toBeVisible();
  await expect(
    plain.getByText(
      /section reader and interpretation checks require JavaScript/,
    ),
  ).toBeVisible();
  await context.close();
});
