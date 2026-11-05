import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { chromium, devices } from "@playwright/test";
const server = spawn(process.execPath, ["tools/serve.mjs"], {
  env: { ...process.env, PORT: "4174", BASE_PATH: "/STATAverse/" },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  await Promise.race([
    once(server.stdout, "data"),
    once(server, "exit").then(() => {
      throw new Error("Preview server exited before starting.");
    }),
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Preview server startup timed out.")),
        5000,
      );
      timer.unref();
    }),
  ]);
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || "chrome",
    headless: true,
  });
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    }),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const root = "http://127.0.0.1:4174/STATAverse/";
  await fs.mkdir("docs/verification/screenshots", { recursive: true });
  await page.goto(root);
  await page.locator('[data-preview="regress"]').click();
  await page.screenshot({
    path: "docs/verification/screenshots/home.png",
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "Start with your first command" })
    .click();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  const scope = await page.evaluate(
    async () => (await navigator.serviceWorker.ready).scope,
  );
  assert.equal(scope, root);
  await page.locator('[data-lesson="regression"]').click();
  await page.locator("#insert-example").click();
  await page.locator("#run").click();
  await page.locator("#tab-graph").click();
  await page.screenshot({
    path: "docs/verification/screenshots/practice-desktop.png",
    fullPage: true,
  });
  await page.goto(root + "Labs/");
  await page.locator("#coefficient-comparison tbody tr").first().waitFor();
  await page.screenshot({
    path: "docs/verification/screenshots/regression-lab-desktop.png",
    fullPage: true,
  });
  await page.locator("#lab-tab-partial").click();
  await page.screenshot({
    path: "docs/verification/screenshots/partial-regression-desktop.png",
    fullPage: true,
  });
  await page.goto(root + "Learn/");
  await page.evaluate(async () => {
    const cache = await caches.open("unrelated-application");
    await cache.put(
      location.origin + "/STATAverse/not-a-page",
      new Response("unrelated response"),
    );
  });
  await context.setOffline(true);
  await page.reload();
  assert.equal(await page.locator("#command-editor").count(), 1);
  const status = await page.evaluate(
    async () => (await fetch("../not-a-page")).status,
  );
  assert.equal(
    status,
    503,
    "Offline lookup must not reuse another application cache",
  );
  assert.ok(
    await page.evaluate(async () =>
      (await caches.keys()).includes("unrelated-application"),
    ),
  );
  await context.setOffline(false);
  await page.goto(root + "Search/");
  await page.locator("#site-search").fill("missing");
  await page
    .getByRole("link", { name: "Samples and missing values" })
    .waitFor();
  for (const url of ["Workspace/", "CodeLibrary/", "MethodLab/"])
    assert.equal((await page.goto(root + url)).status(), 200);
  const mobile = await browser.newContext({
    ...devices["iPhone 13"],
    defaultBrowserType: undefined,
  });
  const phone = await mobile.newPage();
  await phone.goto(root + "Learn/");
  await phone.locator("#run").click();
  assert.ok(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await phone.screenshot({
    path: "docs/verification/screenshots/practice-mobile.png",
    fullPage: true,
  });
  await phone.goto(root + "Labs/");
  await phone.locator('[data-lab-jump="plots"]').click();
  assert.ok(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await phone.screenshot({
    path: "docs/verification/screenshots/regression-lab-mobile.png",
    fullPage: false,
  });
  await phone.locator('[data-lab-jump="estimates"]').click();
  assert.equal(
    await phone.locator("#coefficient-comparison tbody tr").count(),
    2,
  );
  assert.deepEqual(errors, []);
  const receipt = {
    scope,
    projectPath: true,
    regressionLabProjectPath: true,
    regressionLabMobileNavigation: true,
    offlinePractice: true,
    foreignCachePreserved: true,
    foreignCacheNotRead: true,
    searchPracticeLinked: true,
    mobileNoOverflow: true,
    pageErrors: errors,
  };
  await fs.writeFile(
    "docs/verification/deployment.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
