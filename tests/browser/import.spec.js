import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";

const source =
  "\uFEFFWorker ID,Study hours,Score\r\n001,1,4\r\n002,2,5\r\n003,3,7\r\n004,4,8\r\n005,5,NA\r\n";
const upload = (text = source, name = "own-data.csv") => ({
  name,
  mimeType: "text/csv",
  buffer: Buffer.from(text),
});
async function preview(page, text = source, name = "own-data.csv") {
  await page.locator("#import-open").click();
  await page.locator("#csv-file").setInputFiles(upload(text, name));
  await expect(page.locator("#csv-details")).toContainText(name);
}
async function importSource(page, text = source, name = "own-data.csv") {
  await preview(page, text, name);
  if (text.includes("NA")) {
    await page.locator("#csv-missing").fill("NA");
    await page.locator("#csv-missing").press("Tab");
  }
  await page.locator("#csv-confirm").click();
  await expect(page.locator("#import-dialog")).not.toBeVisible();
}

test("local import previews types, preserves leading zeros and resumes the imported session", async ({
  page,
}) => {
  const requests = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" ||
      !request.url().startsWith("http://127.0.0.1:4173/")
    )
      requests.push(request.url());
  });
  await page.goto("/Learn/");
  await importSource(page);
  await expect(page.locator("#dataset-origin")).toHaveText("Imported locally");
  await expect(page.locator("#dataset-count")).toHaveText(
    "5 observations · 3 variables",
  );
  await expect(page.locator("#data-table tbody tr").first()).toContainText(
    "001",
  );
  await page.locator("#command-editor").fill("regress Score Study_hours");
  await page.locator("#run").click();
  await expect(page.locator("#results")).toContainText("1.400");
  await page.reload();
  await expect(page.locator("#dataset-title")).toHaveText("own-data.csv");
  await expect(page.locator("#results")).toContainText("1.400");
  expect(requests).toEqual([]);
});

test("invalid conversion and names cannot replace the working dataset; preview stays accessible", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await preview(page);
  await page.locator('[data-csv-type="2"]').selectOption("numeric");
  await expect(page.locator("#csv-confirm")).toBeDisabled();
  await expect(page.locator("#csv-status")).toContainText("Resolve");
  await expect(page.locator("#csv-preview")).toContainText("Invalid: NA");
  await expect(page.locator("#dataset-count")).toContainText("24 observations");
  await page.locator("#csv-missing").fill("NA");
  await page.locator("#csv-missing").press("Tab");
  await expect(page.locator("#csv-confirm")).toBeEnabled();
  await page.locator('[data-csv-name="0"]').fill("__proto__");
  await page.locator('[data-csv-name="0"]').press("Tab");
  await expect(page.locator("#csv-confirm")).toBeDisabled();
  await page.locator('[data-csv-name="0"]').fill("worker_id");
  await page.locator('[data-csv-name="0"]').press("Tab");
  await expect(page.locator("#csv-confirm")).toBeEnabled();
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
  await page.locator("#import-dialog [data-close]").click();
  await expect(page.locator("#dataset-count")).toContainText("24 observations");
});

test("a larger import pages the data without changing the calculation sample", async ({
  page,
}) => {
  await page.goto("/Learn/");
  const text =
    "id,x,y\n" +
    Array.from({ length: 151 }, (_, i) => `${i + 1},${i},${2 * i + 3}`).join(
      "\n",
    );
  await importSource(page, text, "larger.csv");
  await expect(page.locator("#data-table tbody tr")).toHaveCount(50);
  await page.locator("#data-page").fill("3");
  await page.locator("#data-page").press("Tab");
  await expect(page.locator("#data-table tbody tr").first()).toContainText(
    "101",
  );
  await page.locator("#command-editor").fill("count if id > 140");
  await page.locator("#run").click();
  await expect(page.locator("#results")).toContainText("11 of 151");
  await page.locator("#tab-data").click();
  await expect(page.locator("#data-page")).toHaveValue("3");
  await expect(page.locator("#data-table tr.highlighted")).toHaveCount(10);
  await page.locator("#data-next").click();
  await expect(page.locator("#data-table tbody tr")).toHaveCount(1);
  await expect(page.locator("#data-table tr.highlighted")).toHaveCount(1);
});

test("project export preserves raw source and import decisions without unrelated imports", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await importSource(page, "id,x\nA,1\nB,2", "unrelated.csv");
  await importSource(page);
  await page.locator("#export-open").click();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download complete Stata project (.zip)" })
    .click();
  const archive = unzipSync(await fs.readFile(await (await pending).path()));
  const sources = Object.keys(archive).filter((name) =>
    name.endsWith("-source.txt"),
  );
  expect(sources).toHaveLength(1);
  expect(Buffer.from(archive[sources[0]])).toEqual(Buffer.from(source, "utf8"));
  const metadata = JSON.parse(
    strFromU8(archive[sources[0].replace("-source.txt", "-import.json")]),
  );
  expect(metadata.filename).toBe("own-data.csv");
  expect(metadata.missingValues).toEqual(["NA"]);
  expect(metadata.columns.map((c) => c.type)).toEqual([
    "string",
    "numeric",
    "numeric",
  ]);
  const code = strFromU8(archive["analysis.do"]);
  expect(code).toContain("stringcols(1)");
  expect(code).toContain("numericcols(2 3)");
  expect(code).not.toContain("unrelated");
});

test("workspace backup restores the imported source, commands and selected dataset", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await importSource(page);
  await page.locator("#command-editor").fill("summarize Score");
  await page.locator("#run").click();
  await page.goto("/Workspace/");
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export workspace" }).click();
  const bytes = await fs.readFile(await (await pending).path());
  const backup = JSON.parse(bytes);
  expect(backup.practice.version).toBe(3);
  expect(Object.values(backup.practice.imports)[0].source).toBe(source);
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("[data-clear-notes]").click();
  await page.locator("#workspace-import").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: bytes,
  });
  await expect(page.locator("#workspace-status")).toContainText(
    "Backup imported",
  );
  await page.goto("/Learn/");
  await expect(page.locator("#dataset-title")).toHaveText("own-data.csv");
  await expect(page.locator("#results")).toContainText("summarize Score");
});

test("malformed or non-UTF-8 files leave current work intact", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await page.locator("#command-editor").fill("describe hours");
  await page.locator("#import-open").click();
  await page.locator("#csv-file").setInputFiles(upload('a,b\n1,"unfinished'));
  await expect(page.locator("#csv-status")).toContainText("not closed");
  await expect(page.locator("#csv-confirm")).toBeDisabled();
  await page.locator("#csv-file").setInputFiles({
    name: "invalid.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([0xff, 0xfe, 0x61, 0]),
  });
  await expect(page.locator("#csv-status")).toContainText("not valid UTF-8");
  await page.locator("#import-dialog [data-close]").click();
  await expect(page.locator("#command-editor")).toHaveText("describe hours");
  await expect(page.locator("#dataset-count")).toContainText("24 observations");
});

test("column decisions preserve keyboard focus and Tab order", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await preview(page, "id,x\n001,1\n002,2");
  const name = page.locator('[data-csv-name="0"]');
  const type = page.locator('[data-csv-type="0"]');
  await name.fill("student_id");
  await name.press("Tab");
  await expect(type).toBeFocused();
  await type.selectOption("string");
  await expect(type).toBeFocused();
  await type.press("Tab");
  await expect(page.locator('[data-csv-name="1"]')).toBeFocused();
  await expect(page.locator("#csv-preview")).toContainText("student_id");
});

test("the library limit leaves existing data intact and removal can be canceled", async ({
  page,
}) => {
  await page.goto("/Learn/");
  for (const i of [1, 2, 3])
    await importSource(page, "id,x\n1,2", `source${i}.csv`);
  await preview(page, "id,x\n1,3", "fourth.csv");
  await page.locator("#csv-confirm").click();
  await expect(page.locator("#csv-status")).toContainText("at most three");
  await page.locator("#import-dialog [data-close]").click();
  await expect(page.locator("#dataset-title")).toHaveText("source3.csv");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#remove-import").click();
  await expect(page.locator("#dataset-title")).toHaveText("source3.csv");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#remove-import").click();
  await expect(page.locator("#dataset-select option")).toHaveCount(5);
  await page.reload();
  await expect(page.locator("#dataset-select option")).toHaveCount(5);
  await importSource(page, "id,x\n1,3", "fourth.csv");
  await expect(page.locator("#dataset-title")).toHaveText("fourth.csv");
});

test("an imported source used in another saved session cannot be removed", async ({
  page,
}) => {
  await page.goto("/Learn/");
  await importSource(page, "id,x\n1,2", "source.csv");
  const id = await page.locator("#dataset-select").inputValue();
  await page.locator("#dataset-select").selectOption("study");
  await page
    .locator("#command-editor")
    .fill(`import delimited using "${id}.csv", clear`);
  await page.locator("#run").click();
  await page.locator("#dataset-select").selectOption(id);
  await page.locator("#remove-import").click();
  await expect(page.locator("#remove-import")).toContainText(
    "Used by other sessions",
  );
  await expect(page.locator("#dataset-title")).toHaveText("source.csv");
  await page.reload();
  await expect(page.locator("#dataset-title")).toHaveText("source.csv");
});
