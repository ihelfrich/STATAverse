import { test, expect } from "@playwright/test";

// Problems found in the re-check after release 492e426.

async function ready(page) {
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
}
const commands = (page) =>
  page.locator("#console-output .console-record .console-command");

test("commands typed while one runs wait their turn and none is lost", async ({
  page,
}) => {
  await ready(page);
  const line = page.locator("#console-command");
  await line.fill("sysuse study, clear");
  await line.press("Enter");
  // Typed straight after Enter, as a quick typist does, while the first
  // command is still running.
  await line.pressSequentially("summarize nosuch");
  await line.press("Enter");
  await line.pressSequentially("count");
  await line.press("Enter");
  await expect(commands(page)).toHaveText([
    ". sysuse study, clear",
    ". summarize nosuch",
    ". count",
  ]);
  await expect(line).toBeFocused();
  await expect(line).toHaveValue("");
});

test("Stop drops the commands waiting behind the run", async ({ page }) => {
  await ready(page);
  const line = page.locator("#console-command");
  await page
    .locator("#console-source")
    .fill(
      "clear\nset obs 200000\ngenerate id = _n\nforvalues i = 1/3000 {\n  generate double v`i' = sqrt(_n) * `i'\n}",
    );
  await page.locator("#console-run").click();
  const stop = page.locator("#console-stop");
  await expect(stop).toBeVisible();
  await line.fill('display "after"');
  await line.press("Enter");
  await expect(page.locator("#console-status")).toContainText(
    "runs when this run ends",
  );
  await expect(page.locator("#console-progress-text")).toContainText(
    /line [45] of 6/,
    { timeout: 20000 },
  );
  await stop.click();
  await expect(page.locator("#console-status")).toContainText("Stopped on line", {
    timeout: 30000,
  });
  await page.locator("#console-source").fill("display 6 * 7");
  await page.locator("#console-run").click();
  await expect(page.locator("#console-output")).toContainText("42");
  await expect(page.locator("#console-output")).not.toContainText(
    '. display "after"',
  );
});
