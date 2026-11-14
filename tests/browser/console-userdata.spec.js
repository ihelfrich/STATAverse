import { test, expect } from "@playwright/test";

// The Console with a student's own files: kept between visits, read in the
// worker, added during a run, and exported graphs as files.
async function drawer(page, id) {
  const box = page.locator(`#drawer-${id}`);
  if ((await box.getAttribute("open")) === null)
    await box.locator("> summary").click();
}
async function ready(page) {
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText(/^Ready\./);
}
const csv = (rows) =>
  Buffer.from(
    "id,x,g\n" +
      Array.from(
        { length: rows },
        (_, k) => `${k + 1},${(k * 37) % 1000},${k % 5}`,
      ).join("\n") +
      "\n",
  );

test("a file added during a run waits for it, and the run's results arrive", async ({
  page,
}) => {
  await ready(page);
  const status = page.locator("#console-status"),
    output = page.locator("#console-output");
  await page
    .locator("#console-source")
    .fill(
      'clear\nset obs 100000\ngenerate x = runiform()\nforvalues i = 1/25 {\n  quietly summarize x, detail\n}\ndisplay "loop finished"',
    );
  await page.locator("#console-run").click();
  await expect(status).toHaveAttribute("data-state", "running");
  await page.locator("#console-file").setInputFiles({
    name: "labels.csv",
    mimeType: "text/csv",
    buffer: csv(20),
  });
  await expect(status).toContainText("will be added when the run ends");
  // The run's own reply is not lost: its output arrives, then the file.
  await expect(output).toContainText("loop finished", { timeout: 60000 });
  await expect(status).toContainText("Added labels.csv.", { timeout: 20000 });
  await expect(output).toContainText(
    '. import delimited using "labels.csv", clear',
  );
  await expect(page.locator("#console-memory")).toContainText(
    "20 observations, 3 variables",
  );

  // While a run goes, the student's own Load and Remove buttons wait.
  await drawer(page, "data");
  await page
    .locator("#console-source")
    .fill(
      "clear\nset obs 100000\ngenerate x = runiform()\nforvalues i = 1/25 {\n  quietly summarize x, detail\n}",
    );
  await page.locator("#console-run").click();
  await expect(status).toHaveAttribute("data-state", "running");
  await expect(
    page.getByRole("button", { name: "Load labels.csv" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Remove labels.csv" }),
  ).toBeDisabled();
  await expect(status).toHaveText(/Ran \d+ commands?/, { timeout: 60000 });
  await expect(
    page.getByRole("button", { name: "Load labels.csv" }),
  ).toBeEnabled();
});

test("added files are kept between visits until removed", async ({ page }) => {
  await ready(page);
  const status = page.locator("#console-status");
  await page.locator("#console-file").setInputFiles({
    name: "kept.csv",
    mimeType: "text/csv",
    buffer: csv(3),
  });
  await expect(status).toContainText("Added kept.csv.");
  await drawer(page, "data");
  await expect(page.locator("#console-kept")).toContainText(
    "kept in this browser's storage",
  );
  await page.reload();
  await expect(status).toContainText(
    "Your file is here from this browser: kept.csv.",
  );
  await page
    .locator("#console-command")
    .fill("import delimited using kept.csv, clear");
  await page.locator("#console-command").press("Enter");
  await expect(page.locator("#console-output")).toContainText(
    "(3 vars, 3 obs)",
  );

  // Removed, it is gone after a reload too, and a do-file that uses it says
  // it must be added.
  await drawer(page, "data");
  await page.getByRole("button", { name: "Remove kept.csv" }).click();
  await expect(status).toHaveText("kept.csv was removed from this browser.");
  await page.reload();
  await expect(status).toHaveText("Ready.");
  await expect(page.locator("#console-own li")).toHaveCount(0);
  await page
    .locator("#console-command")
    .fill("import delimited using kept.csv, clear");
  await page.locator("#console-command").press("Enter");
  await expect(page.locator("#console-output")).toContainText(
    "file kept.csv not found",
  );
  await expect(status).toContainText(
    "kept.csv is not among your files: open Data and add it",
  );
});

test("a large file is read in the worker with its progress shown", async ({
  page,
}) => {
  await ready(page);
  const status = page.locator("#console-status"),
    big = csv(900000);
  expect(big.length).toBeGreaterThan(10_000_000);
  // Every status line shown while the file is read.
  await page.evaluate(() => {
    window.seen = [];
    new MutationObserver(() =>
      window.seen.push(document.getElementById("console-status").textContent),
    ).observe(document.getElementById("console-status"), {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await page.locator("#console-file").setInputFiles({
    name: "big.csv",
    mimeType: "text/csv",
    buffer: big,
  });
  await expect(status).toContainText("Added big.csv.", { timeout: 60000 });
  await expect(page.locator("#console-memory")).toContainText(
    "900,000 observations, 3 variables",
    { timeout: 60000 },
  );
  expect(
    (await page.evaluate(() => window.seen)).some((text) =>
      /^Reading big\.csv: \d+% of 11\.\d MB…$/.test(text),
    ),
  ).toBe(true);
  // Files nothing here reads are refused with what to do instead.
  await page.locator("#console-file").setInputFiles({
    name: "model.rds",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0x58, 0x0a, 0, 0]),
  });
  await expect(status).toContainText("haven::write_dta");
});

test("an Excel, SPSS or SAS file is added and loaded with its import command", async ({
  page,
}) => {
  await ready(page);
  await page.locator("#console-file").setInputFiles({
    name: "course.xlsm",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]),
  });
  await expect(page.locator("#console-status")).toContainText(
    "Added course.xlsm.",
  );
  await expect(page.locator("#console-output")).toContainText(
    '. import excel using "course.xlsm", firstrow clear',
  );
  await expect(page.locator("#console-files")).toContainText("course.xlsm");
  await page.locator("#console-file").setInputFiles({
    name: "DEMO_J.XPT",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("HEADER RECORD*******LIBRARY\0\0"),
  });
  await expect(page.locator("#console-output")).toContainText(
    '. import sasxport5 "DEMO_J.XPT", clear',
  );
});

test("the Variables pane shows Stata's columns with the value label", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#console-source")
    .fill(
      'clear\nset obs 2\ngenerate female = _n - 1\nlabel variable female "Is female"\nlabel define sexlbl 0 "male" 1 "female"\nlabel values female sexlbl',
    );
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toHaveText(/Ran 6 commands/);
  await drawer(page, "variables");
  await expect(page.locator("#console-variable-table th")).toHaveText([
    "Name",
    "Label",
    "Type",
    "Format",
    "Value label",
  ]);
  await expect(
    page.locator("#console-variable-table tbody tr").first().locator("td"),
  ).toHaveText(["female", "Is female", "float", "%9.0g", "sexlbl"]);
});

test("a loop is echoed once with numbered lines", async ({ page }) => {
  await ready(page);
  await page
    .locator("#console-source")
    .fill(
      "sysuse wages, clear\nforeach v in wage educ {\n    quietly summarize `v'\n    display \"`v': \" r(N)\n}",
    );
  await page.locator("#console-run").click();
  const output = page.locator("#console-output");
  await expect(output).toContainText(
    ". foreach v in wage educ {\n  2.     quietly summarize `v'\n  3.     display \"`v': \" r(N)\n  4. }",
  );
  await expect(output.locator(".console-command")).toHaveCount(2);
});

test("graph export writes files to download and to carry in the project", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#console-source")
    .fill(
      "sysuse wages, clear\nscatter wage educ\ngraph export fig1.svg\ngraph export fig1.png\ngraph export fig1.pdf",
    );
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toHaveText(/Ran 5 commands/);
  await expect(page.locator("#console-output")).toContainText(
    "file fig1.png written in PNG format",
  );
  await drawer(page, "data");
  await expect(page.locator("#console-own li")).toHaveCount(3);
  const signatures = {
    "fig1.png": [0x89, 0x50, 0x4e, 0x47],
    "fig1.pdf": [0x25, 0x50, 0x44, 0x46],
    "fig1.svg": [0x3c, 0x3f, 0x78, 0x6d],
  };
  for (const [name, signature] of Object.entries(signatures)) {
    const waiting = page.waitForEvent("download");
    await page.getByRole("button", { name: `Download ${name}` }).click();
    const download = await waiting,
      bytes = Buffer.concat(
        await (await download.createReadStream()).toArray(),
      );
    expect(download.suggestedFilename()).toBe(name);
    expect([...bytes.subarray(0, 4)]).toEqual(signature);
  }
  // The project zip carries them.
  const waiting = page.waitForEvent("download");
  await page.locator("#console-more summary").click();
  await page.locator("#console-download").click();
  const text = Buffer.concat(
    await (await (await waiting).createReadStream()).toArray(),
  ).toString("latin1");
  for (const name of Object.keys(signatures))
    expect(text).toContain(`stata-project/${name}`);
});

test("a kept file that cannot be read back is reported once and taken off the shelf", async ({
  page,
}) => {
  await ready(page);
  // Stands in for any kept file that later fails to load.
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("stataverse-console-files", 1);
        open.onsuccess = () => {
          const put = open.result
            .transaction("files", "readwrite")
            .objectStore("files")
            .put({
              name: "broken.dta",
              blob: new Blob(["<stata_dta><h"]),
              made: false,
              at: Date.now(),
            });
          put.onsuccess = resolve;
          put.onerror = reject;
        };
        open.onerror = reject;
      }),
  );
  const status = page.locator("#console-status");
  await page.reload();
  await expect(status).toHaveText(
    "Ready. broken.dta could not be read back and was removed from this browser; add it again.",
  );
  await page.reload();
  await expect(status).toHaveText("Ready.");
});

test("the missing-file note is right about files of another case or in a folder", async ({
  page,
}) => {
  await ready(page);
  const status = page.locator("#console-status");
  await page.locator("#console-file").setInputFiles({
    name: "Left.csv",
    mimeType: "text/csv",
    buffer: csv(3),
  });
  await expect(status).toContainText("Added Left.csv.");
  const run = async (command) => {
    await page.locator("#console-command").fill(command);
    await page.locator("#console-command").press("Enter");
  };
  // Found whatever the case, as Stata finds it on macOS and Windows.
  await run("import delimited using left.csv, clear");
  await expect(status).toHaveText(/^Ran 1 command/);
  await run('import delimited using "data/left.csv", clear');
  await expect(status).toContainText(
    "Left.csv is among your files, but files here are not in folders: name it without the folder, as Left.csv.",
  );
  await run("import delimited using gone.csv, clear");
  await expect(status).toContainText(
    "gone.csv is not among your files: open Data and add it.",
  );
});

test("a PNG graph export wrote is read by a later run as Stata reads it", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#console-source")
    .fill("sysuse wages, clear\nscatter wage educ\ngraph export pic.png");
  await page.locator("#console-run").click();
  await expect(page.locator("#console-status")).toHaveText(/Ran 3 commands/);
  await page
    .locator("#console-command")
    .fill("capture noisily import delimited using pic.png, clear");
  await page.locator("#console-command").press("Enter");
  await expect(page.locator("#console-output")).toContainText(
    "(encoding automatically selected:",
  );
  await expect(page.locator("#console-output")).not.toContainText(
    "is a Stata dataset",
  );
});
