// Which of the runtime's registered commands have been compared with
// installed Stata, and how often. It reads every command line out of the
// recorded fixtures (tests/fixtures/stata-runtime-*.json and the other
// fixtures the runtime is tested against), resolves each to the registered
// command it names, abbreviations included, and lists the registered
// commands that no recording has run. That list is the backlog for
// recording: a command not in any fixture is checked only by reading.
//
//   node tools/coverage-matrix.mjs           print the summary
//   node tools/coverage-matrix.mjs --write   also rewrite
//                                            docs/verification/coverage-matrix.json
import fs from "node:fs";
import { COMMANDS } from "../src/runtime/commands.js";

const FIXTURES = [
  "stata-runtime.json",
  "stata-runtime-sessions.json",
  "stata-runtime-output.json",
  "stata-runtime-cluster.json",
  "stata-postestimation-rc.json",
  "stata-nbreg-boundary.json",
];
const fixtureUrl = (name) =>
  new URL(`../tests/fixtures/${name}`, import.meta.url);

/** The registered command a typed word names, as the session finds it. */
export function resolve(word) {
  return COMMANDS.find(
    (c) => word.length >= c.minimum && c.name.startsWith(word),
  )?.name;
}

// The session's own language, which is not in COMMANDS.
const LANGUAGE = new Set([
  "input",
  "end",
  "forvalues",
  "foreach",
  "while",
  "if",
  "else",
  "program",
]);
// Prefixes that come before the command they modify.
const PREFIX =
  /^(?:(?:cap(?:t(?:u(?:re?)?)?)?|qui(?:e(?:t(?:ly?)?)?)?|n(?:o(?:i(?:s(?:i(?:ly?)?)?)?)?)?)\s+|(?:by|bys(?:o(?:rt?)?)?)\s[^:]*:\s*|xi:\s*|version\s+[\d.]+\s*:\s*)/;

/** The command words of a do-file's text, skipping data typed after input. */
export function commandWords(source) {
  const words = [];
  let entering = false;
  for (const raw of source.split("\n")) {
    let line = raw.replace(/\/\/.*$/, "").trim();
    if (entering) {
      if (/^end$/.test(line)) entering = false;
      continue;
    }
    if (!line || line.startsWith("*")) continue;
    let previous;
    do {
      previous = line;
      line = line.replace(PREFIX, "");
    } while (line !== previous);
    const word = /^[A-Za-z_]\w*/.exec(line)?.[0];
    if (!word) continue;
    words.push(word);
    if (/^input$/.test(word) && !/,\s*$/.test(line)) entering = true;
  }
  return words;
}

/** Every "source" and "command" string anywhere in a fixture. */
function texts(value, out = []) {
  if (Array.isArray(value)) for (const item of value) texts(item, out);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      if ((key === "source" || key === "command") && typeof item === "string")
        out.push(item);
      else texts(item, out);
  return out;
}

export function coverage() {
  const counts = new Map(COMMANDS.map((c) => [c.name, {}])),
    unregistered = new Map();
  for (const name of FIXTURES) {
    if (!fs.existsSync(fixtureUrl(name))) continue;
    const fixture = JSON.parse(fs.readFileSync(fixtureUrl(name), "utf8"));
    // A fixture's own description (a top-level source) is not a do-file;
    // the post-estimation record lists its commands as plain strings.
    const { source, estimators = [], follow = [], ...body } = fixture,
      lines = [
        ...(typeof source === "string" ? [] : texts(source)),
        ...texts(body),
        ...estimators.filter((e) => typeof e === "string"),
        ...follow.filter((f) => typeof f === "string"),
      ];
    for (const text of lines)
      for (const word of commandWords(text)) {
        const command = resolve(word);
        if (command) {
          const row = counts.get(command);
          row[name] = (row[name] ?? 0) + 1;
        } else if (!LANGUAGE.has(word))
          unregistered.set(word, (unregistered.get(word) ?? 0) + 1);
      }
  }
  const commands = [...counts].map(([name, fixtures]) => ({
    name,
    recorded: Object.values(fixtures).reduce((a, b) => a + b, 0),
    fixtures,
  }));
  return {
    registered: commands.length,
    recorded: commands.filter((c) => c.recorded).length,
    unrecorded: commands.filter((c) => !c.recorded).map((c) => c.name),
    commands,
    // Words in the fixtures that name no registered command: refusals the
    // recordings check, and Stata commands the runtime does not have.
    unregistered: Object.fromEntries(
      [...unregistered].sort((a, b) => b[1] - a[1]),
    ),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = coverage();
  console.log(
    `${result.recorded} of ${result.registered} registered commands appear in a recorded fixture.`,
  );
  console.log(`Never recorded (${result.unrecorded.length}):`);
  console.log(`  ${result.unrecorded.join(" ")}`);
  if (process.argv.includes("--write"))
    fs.writeFileSync(
      new URL("../docs/verification/coverage-matrix.json", import.meta.url),
      JSON.stringify(
        {
          basis:
            "Each command line in the recorded fixtures named in tools/coverage-matrix.mjs, resolved to the registered command it names. A command counts as recorded when at least one line ran it in installed Stata and in the runtime. Recorded is not the same as covered: a command can appear with only some of its options.",
          ...result,
        },
        null,
        2,
      ) + "\n",
    );
}
