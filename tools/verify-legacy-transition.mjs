import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

const oldBase = "/STATAverse/",
  newBase = "/learn/stata/";
const legacyWorker = execFileSync(
  "git",
  ["show", "c569c03:service-worker.js"],
  { encoding: "utf8" },
);
let previousRelease = false;
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};
const oldHtml =
  '<!doctype html><html><title>Previous STATAverse</title><body><h1>Previous STATAverse</h1><script>navigator.serviceWorker.register("/STATAverse/service-worker.js")</script></body></html>';
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const base = url.pathname.startsWith(oldBase) ? oldBase : newBase;
  try {
    if (!url.pathname.startsWith(base)) throw new Error("outside app");
    let relative = url.pathname.slice(base.length);
    if (relative === "" || relative.endsWith("/")) relative += "index.html";
    const file = path.resolve(relative);
    if (!file.startsWith(process.cwd() + path.sep))
      throw new Error("outside app");
    const data =
      previousRelease && base === oldBase && relative === "service-worker.js"
        ? legacyWorker
        : previousRelease && base === oldBase && relative.endsWith(".html")
          ? oldHtml
          : await fs.readFile(file);
    response
      .writeHead(200, {
        "Content-Type":
          mime[path.extname(relative)] || "application/octet-stream",
        "Cache-Control": "no-store",
      })
      .end(data);
  } catch {
    response.writeHead(404).end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "chrome" });
const checks = [];
try {
  const fresh = await browser.newContext();
  const page = await fresh.newPage();
  await page.goto(origin + oldBase + "Learn/?course=fall%202026#regression");
  await page.waitForURL(
    origin + newBase + "Learn/?course=fall%202026#regression",
  );
  await page.locator("#command-editor").waitFor();
  assert.equal(await page.locator("#lesson-title").innerText(), "Fit the line");
  await page.goto(
    origin +
      oldBase +
      "ScriptLibrary/script.html?id=regress&return=%2F#example",
  );
  await page.waitForURL(
    origin +
      newBase +
      "ScriptLibrary/script.html?id=regress&return=%2F#example",
  );
  checks.push(
    "fresh legacy links preserve the path, encoded query and lesson fragment",
  );
  await fresh.close();

  previousRelease = true;
  const returning = await browser.newContext();
  const student = await returning.newPage();
  await student.goto(origin + oldBase);
  await student.evaluate(() => navigator.serviceWorker.ready);
  await student.reload();
  assert.match(await student.locator("h1").innerText(), /Previous/);
  const saved = {
    checks: [true],
    notes: { "reflect-0": "Keep my explanation." },
  };
  const key =
    "stataverse:progress:/STATAverse/ZeroToHero/modules/01-stata-foundations.html";
  await student.evaluate(
    async ({ key, saved }) => {
      localStorage.setItem(key, JSON.stringify(saved));
      for (const name of [
        "unrelated-application",
        "stataverse:/learn/stata/:existing-release",
      ]) {
        const cache = await caches.open(name);
        await cache.put("/retained", new Response("keep"));
      }
    },
    { key, saved },
  );
  previousRelease = false;
  await student.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const changed = new Promise((resolve) =>
      navigator.serviceWorker.addEventListener("controllerchange", resolve, {
        once: true,
      }),
    );
    await registration.update();
    await changed;
    const worker = registration.active;
    if (worker.state !== "activated")
      await new Promise((resolve) => {
        worker.addEventListener("statechange", () => {
          if (worker.state === "activated") resolve();
        });
      });
  });
  assert.equal(
    await student.evaluate((key) => localStorage.getItem(key), key),
    JSON.stringify(saved),
  );
  const names = await student.evaluate(() => caches.keys());
  assert.ok(names.includes("unrelated-application"));
  assert.ok(names.includes("stataverse:/learn/stata/:existing-release"));
  assert.ok(!names.includes("stataverse-v7"));
  checks.push(
    "v7 worker upgrade retires its cache and preserves other app caches and saved notes",
  );
  await student.goto(origin + oldBase + "Learn/?course=returning#regression");
  await student.waitForURL(
    origin + newBase + "Learn/?course=returning#regression",
  );
  await student.locator("#command-editor").waitFor();
  await student.locator("#insert-example").click();
  await student.locator("#run").click();
  await student.evaluate(() => navigator.serviceWorker.ready);
  await student.reload();
  assert.equal(
    await student.evaluate(
      async () => (await navigator.serviceWorker.ready).scope,
    ),
    origin + newBase,
  );
  assert.equal(
    await student.evaluate((key) => localStorage.getItem(key), key),
    JSON.stringify(saved),
  );
  await returning.setOffline(true);
  await student.reload();
  await student.locator("#run").click();
  await student.locator("#command-editor").waitFor();
  checks.push(
    "returning navigation reaches the canonical lesson and runs under its own offline worker",
  );
  await returning.close();
  const receipt = {
    checkedAt: new Date().toISOString(),
    previousCommit: "c569c03aa41fafd633487906fe72dc78558d98fd",
    checks,
  };
  await fs.mkdir("docs/verification", { recursive: true });
  await fs.writeFile(
    "docs/verification/legacy-transition.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
