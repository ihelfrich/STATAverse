// Measures how much of this repository's own Stata teaching code names a
// command the browser interpreter implements. This is a name-level upper
// bound: a supported command can still meet an unsupported option, function
// or prefix. It is not a statement of Stata compatibility.
import fs from "node:fs/promises";
import path from "node:path";
import { SUPPORTED_COMMANDS } from "../src/engine.js";

const ROOTS = [
  "ScriptLibrary/scripts",
  "CodeLibrary/scripts",
  "ZeroToHero/projects",
  "RealData",
];
// Minimum abbreviations for commands that appear in teaching code. Entries
// map a full name to the shortest accepted prefix.
const ABBREVIATIONS = {
  summarize: "su",
  regress: "reg",
  generate: "g",
  tabulate: "ta",
  histogram: "hist",
  correlate: "cor",
  describe: "d",
  display: "di",
  list: "l",
  quietly: "qui",
  noisily: "n",
  capture: "cap",
  label: "la",
  rename: "ren",
  predict: "predict",
  bysort: "bys",
  global: "gl",
  local: "loc",
  matrix: "mat",
  scalar: "sca",
  graph: "gr",
  twoway: "tw",
  scatter: "sc",
  tabstat: "tabstat",
  replace: "replace",
  merge: "mer",
  append: "app",
  program: "pr",
  estimates: "est",
  macro: "ma",
  version: "vers",
  browse: "br",
  format: "form",
  order: "order",
  constraint: "cons",
  return: "ret",
  ereturn: "eret",
  window: "win",
};
// Commands the interpreter runs under a by prefix.
const BY_COMMANDS = new Set([
  "generate",
  "replace",
  "egen",
  "summarize",
  "count",
]);
const PREFIXES = new Set([
  "capture",
  "quietly",
  "noisily",
  "by",
  "bysort",
  "xi",
  "sortpreserve",
  "version",
]);

export function resolveCommand(word) {
  const lower = word.toLowerCase();
  for (const [full, short] of Object.entries(ABBREVIATIONS))
    if (lower.length >= short.length && full.startsWith(lower)) return full;
  return lower;
}

// Splits Stata source into logical commands. Handles //, ///, * and /* */
// comments, and #delimit ; blocks. Brace bodies are flattened: each inner
// command is counted once, as written.
export function logicalCommands(source) {
  let text = source.replace(/\r\n?/g, "\n");
  text = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  const out = [];
  let delimiter = "\n",
    pending = "";
  const flush = (line) => {
    const command = line.replace(/\s+/g, " ").trim();
    if (command) out.push(command);
  };
  for (const raw of text.split("\n")) {
    let line = raw;
    if (/^\s*#d(e(l(i(m(it?)?)?)?)?)?\b/i.test(line)) {
      if (pending.trim()) flush(pending);
      pending = "";
      delimiter = /;/.test(line) ? ";" : "\n";
      continue;
    }
    if (/^\s*\*/.test(line) && !pending.trim()) continue;
    const continued = /(^|\s)\/\/\/.*$/.test(line);
    line = line.replace(/(^|\s)\/\/\/.*$/, " ").replace(/(^|\s)\/\/.*$/, " ");
    if (delimiter === ";") {
      pending += " " + line;
      const parts = pending.split(";");
      pending = parts.pop();
      parts.forEach(flush);
    } else if (continued) pending += " " + line;
    else {
      flush(pending + " " + line);
      pending = "";
    }
  }
  if (pending.trim()) flush(pending);
  return out;
}

// Returns the command a logical line executes, after its prefixes.
export function commandOf(line) {
  let rest = line.replace(/^[{}\s]+/, "").replace(/^\.\s+/, "");
  const prefixes = [];
  for (let guard = 0; guard < 6; guard++) {
    const word = rest.match(/^[A-Za-z_#][A-Za-z_0-9]*/)?.[0];
    if (!word) return { command: "", prefixes };
    const full = resolveCommand(word);
    if (!PREFIXES.has(full)) return { command: full, prefixes };
    prefixes.push(full);
    if (full === "by" || full === "bysort" || full === "xi") {
      const colon = rest.indexOf(":");
      if (colon < 0) return { command: full, prefixes: prefixes.slice(0, -1) };
      rest = rest.slice(colon + 1).trim();
    } else if (full === "version") {
      const m = rest.match(/^\S+\s+[\d.]+\s*:\s*(.*)$/);
      if (!m) return { command: "version", prefixes: prefixes.slice(0, -1) };
      rest = m[1];
    } else rest = rest.slice(word.length).replace(/^\s*:?\s*/, "");
    rest = rest.replace(/^[{\s]+/, "");
  }
  return { command: "", prefixes };
}

async function doFiles(dir) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await doFiles(full)));
    else if (entry.name.endsWith(".do")) found.push(full);
  }
  return found.sort();
}

export async function measure(root = ".") {
  const supported = new Set(SUPPORTED_COMMANDS.map(resolveCommand));
  const supportedPrefixes = new Set(["capture", "quietly", "noisily"]);
  const commands = new Map();
  const files = [];
  for (const dir of ROOTS)
    for (const file of await doFiles(path.join(root, dir))) {
      const lines = logicalCommands(await fs.readFile(file, "utf8"));
      let ok = 0,
        counted = 0;
      for (const line of lines) {
        const { command, prefixes } = commandOf(line);
        if (!command) continue;
        counted++;
        const runs =
          supported.has(command) &&
          prefixes.every(
            (p) =>
              supportedPrefixes.has(p) ||
              ((p === "by" || p === "bysort") && BY_COMMANDS.has(command)),
          );
        const key = supported.has(command) ? command : command;
        const row = commands.get(key) ?? {
          command: key,
          lines: 0,
          named: supported.has(command),
          blockedByPrefix: 0,
        };
        row.lines++;
        if (supported.has(command) && !runs) row.blockedByPrefix++;
        commands.set(key, row);
        if (runs) ok++;
      }
      files.push({
        file: path.relative(root, file),
        commandLines: counted,
        namedSupported: ok,
      });
    }
  const total = files.reduce((n, f) => n + f.commandLines, 0),
    ok = files.reduce((n, f) => n + f.namedSupported, 0);
  return {
    basis:
      "Name-level upper bound over this repository's do-files. A line counts when its command and every prefix are implemented by the browser interpreter; options, functions and semantics are not checked here.",
    files: files.length,
    commandLines: total,
    namedSupported: ok,
    share: total ? Number((ok / total).toFixed(4)) : 0,
    // display is two thirds of the corpus, so the share without it is the
    // more informative number.
    shareExcludingDisplay: (() => {
      const shown = commands.get("display")?.lines ?? 0;
      return total - shown
        ? Number(((ok - shown) / (total - shown)).toFixed(4))
        : 0;
    })(),
    filesFullyNamed: files.filter((f) => f.namedSupported === f.commandLines)
      .length,
    unsupported: [...commands.values()]
      .filter((c) => !c.named)
      .sort((a, b) => b.lines - a.lines || a.command.localeCompare(b.command))
      .map(({ command, lines }) => ({ command, lines })),
    supported: [...commands.values()]
      .filter((c) => c.named)
      .sort((a, b) => b.lines - a.lines || a.command.localeCompare(b.command))
      .map(({ command, lines, blockedByPrefix }) => ({
        command,
        lines,
        blockedByPrefix,
      })),
    perFile: files,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await measure(".");
  if (process.argv.includes("--write"))
    await fs.writeFile(
      "docs/verification/corpus-coverage.json",
      JSON.stringify(report, null, 2) + "\n",
    );
  const { perFile, supported, unsupported, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    "Most frequent unsupported:",
    unsupported
      .slice(0, 40)
      .map((c) => `${c.command} ${c.lines}`)
      .join(", "),
  );
  console.log(
    "Supported in corpus:",
    supported
      .map(
        (c) =>
          `${c.command} ${c.lines}${c.blockedByPrefix ? ` (${c.blockedByPrefix} behind by/xi)` : ""}`,
      )
      .join(", "),
  );
}
