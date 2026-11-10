// The share of command lines in this repository's do-files whose command the
// new runtime (src/runtime) implements. Like tools/corpus-coverage.mjs this
// is a name-level upper bound: options, functions and estimator variants are
// not checked here.
import fs from "node:fs/promises";
import path from "node:path";
import { logicalCommands } from "./corpus-coverage.mjs";
import { COMMANDS } from "../src/runtime/commands.js";

const ROOTS = [
  "ScriptLibrary/scripts",
  "CodeLibrary/scripts",
  "ZeroToHero/projects",
  "RealData",
];
// Handled by the session itself rather than by an entry in COMMANDS.
const CONTROL =
  /^(foreach|forv(a(l(u(es?)?)?)?)?|while|pr(o(g(r(am?)?)?)?)?|end|inp(ut?)?|#d\w*)$/;
const PREFIX =
  /^(cap(t(u(re?)?)?)?|qui(e(t(ly?)?)?)?|n(o(i(s(i(ly?)?)?)?)?)?|vers(i(on?)?)?\s+[\d.]+\s*:)\s+/;
const BY = /^(by|bys(o(rt?)?)?)\b[^:]*:\s*/;
const known = (word) =>
  CONTROL.test(word) ||
  COMMANDS.some((c) => word.length >= c.minimum && c.name.startsWith(word));

async function doFiles(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await doFiles(full)));
    else if (entry.name.endsWith(".do")) found.push(full);
  }
  return found.sort();
}

export async function measure(root = ".") {
  const missing = new Map();
  let total = 0,
    supported = 0,
    display = 0,
    files = 0;
  for (const directory of ROOTS)
    for (const file of await doFiles(path.join(root, directory))) {
      files++;
      for (const line of logicalCommands(await fs.readFile(file, "utf8"))) {
        let rest = line.replace(/^[{}\s]+/, "");
        for (let k = 0; k < 4; k++)
          rest = rest.replace(PREFIX, "").replace(BY, "");
        const word = /^[A-Za-z_#]\w*/.exec(rest)?.[0];
        if (!word) continue;
        total++;
        if (/^di(s(p(l(ay?)?)?)?)?$/.test(word)) display++;
        if (known(word)) supported++;
        else missing.set(word, (missing.get(word) ?? 0) + 1);
      }
    }
  return {
    basis:
      "Name-level upper bound over this repository's do-files for the new runtime in src/runtime. A line counts when its command is implemented; options, functions and semantics are not checked here.",
    files,
    commandLines: total,
    namedSupported: supported,
    share: Number((supported / total).toFixed(4)),
    shareExcludingDisplay: Number(
      ((supported - display) / (total - display)).toFixed(4),
    ),
    unsupported: [...missing]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([command, lines]) => ({ command, lines })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await measure(".");
  if (process.argv.includes("--write"))
    await fs.writeFile(
      "docs/verification/corpus-coverage-runtime.json",
      JSON.stringify(report, null, 2) + "\n",
    );
  const { unsupported, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  console.log(unsupported.map((c) => `${c.command} ${c.lines}`).join(", "));
}
