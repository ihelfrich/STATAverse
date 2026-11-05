import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
const server = spawn(process.execPath, ["tools/serve.mjs"], {
  env: { ...process.env, PORT: "4178" },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  await once(server.stdout, "data");
  browser = await chromium.launch({ channel: "chrome" });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 1050 },
    });
    const page = await context.newPage();
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/assets/js/learn.js", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("http://127.0.0.1:4178/Learn/#first-commands", {
      waitUntil: "commit",
    });
    await page.locator("#run").waitFor();
    try {
      for (const id of ["run", "run-line", "insert-example"])
        assert.equal(
          await page.locator("#" + id).isEnabled(),
          false,
          `${id} must not accept a click before its handler exists`,
        );
      assert.equal(
        await page.locator("#main").getAttribute("aria-busy"),
        "true",
      );
      await expect(page.locator("#practice-loading")).toBeVisible();
    } finally {
      release();
    }
    await expect(page.locator("#run")).toBeEnabled();
    await expect(page.locator("#practice-loading")).toBeHidden();
    assert.equal(await page.locator("#main").getAttribute("inert"), null);
    await page.locator("#insert-example").click();
    await page.locator("#run").click();
    await expect(page.locator("#exercise-check")).toHaveClass(/success/);
    await page
      .getByRole("radio", { name: "One fictional student", exact: true })
      .check();
    await page.locator("#check-answer").click();
    await expect(page.locator("#next-step")).toBeEnabled();
    await context.close();
  }
  console.log(
    "Passed: delayed module loading protects controls and preserves the first exercise on desktop and phone.",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
