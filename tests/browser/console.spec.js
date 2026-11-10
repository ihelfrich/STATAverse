import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("the console runs a do-file on the new runtime and keeps the text", async ({
  page,
}) => {
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  const source = page.locator("#console-source");
  await expect(source).toHaveValue(/sysuse study, clear/);
  await page.locator("#console-run").click();
  const output = page.locator("#console-output");
  await expect(output).toContainText(". regress score hours attendance");
  await expect(output).toContainText("Number of obs   =");
  await expect(output).toContainText("F(  1,");
  await expect(page.locator("#console-memory")).toContainText(
    "24 observations, 6 variables",
  );
  await expect(
    page.locator("#console-variable-table tbody tr").last(),
  ).toContainText("passed");

  // An error stops the do-file, shows Stata's message and keeps the session.
  await source.fill("generate double z = hours / 2\ngenerate z = 1\ncount");
  await source.press("ControlOrMeta+Enter");
  await expect(output).toContainText("variable z already defined");
  await expect(output).toContainText("r(110);");
  await expect(page.locator("#console-status")).toContainText(
    "return code 110",
  );
  await expect(
    page.locator("#console-variable-table tbody tr").last(),
  ).toContainText("z");

  // Macros, loops and programs.
  await source.fill(
    "program define twice\n  args v\n  display \"`v' doubled is \" `v' * 2\nend\nforvalues i = 1/3 {\n  twice `i'\n}",
  );
  await page.locator("#console-run").click();
  await expect(output).toContainText("3 doubled is 6");

  // The text survives a reload; the session does not.
  await page.reload();
  await expect(page.locator("#console-status")).toHaveText("Ready.");
  await expect(source).toHaveValue(/program define twice/);
  await expect(page.locator("#console-memory")).toHaveText(
    "No data in memory.",
  );

  // Starting from a site dataset, and clearing the session.
  await page.locator("#console-dataset").selectOption("study");
  await expect(page.locator("#console-memory")).toContainText(
    "24 observations, 5 variables",
  );
  await source.fill("sysuse auto");
  await page.locator("#console-run").click();
  await expect(output).toContainText("This site's datasets are");
  await page.locator("#console-reset").click();
  await expect(output).toHaveText("");

  const scan = await new AxeBuilder({ page }).analyze();
  expect(scan.violations.map((v) => v.id)).toEqual([]);
});
