// `npm run check` must leave a clean tree. The browser specs and the
// deployment check write screenshots and receipts, so they must write them
// through tools/receipts.mjs, which defaults to an ignored directory.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const writers = [
  ...fs
    .readdirSync(path.join(root, "tests/browser"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join("tests/browser", name)),
  "tools/verify-deployment.mjs",
  "tools/verify-site-integration.mjs",
];

test("checks run by npm run check write no tracked receipt paths", () => {
  for (const file of writers) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(
      text,
      /["'`]docs\/verification\//,
      `${file} writes into docs/verification; use tools/receipts.mjs`,
    );
  }
});

test("the student probe writes its receipt only when asked", () => {
  const text = fs.readFileSync(
    path.join(root, "tools/student-probe.mjs"),
    "utf8",
  );
  assert.match(text, /process\.argv\.includes\("--write"\)/);
});
