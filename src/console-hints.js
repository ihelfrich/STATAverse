// What the Console adds under a command that failed: one plain sentence a
// beginner can act on, and the command whose help to open. Stata's own
// message and return code are printed as Stata prints them; the hint is
// shown beside them, never in their place, and is not part of the log.
// This file reads only the record of a run and the names in memory, so it
// is the same in the page, in the worker and in the unit tests.

// What a return code usually means, when nothing more particular is known.
export const RC_HINTS = {
  100: "A list of variables was needed and none was given.",
  101: "That command does not take factor or time-series notation here. Make the variable with generate first.",
  102: "Too few variables were given for that command.",
  103: "Too many variables were given for that command.",
  109: "A string was used where a number was needed, or the other way round.",
  110: "That name is already taken. Use replace to change a variable, or drop it first.",
  111: "No variable has that name. Check the spelling and the capitals against the Variables list.",
  119: "That statistic belongs after a different kind of model.",
  132: "A bracket or a quote is opened and never closed.",
  133: "That function does not exist here. Check its spelling.",
  198: "Stata could not read that line. Look for a missing comma, a stray bracket or a misspelt option.",
  199: "That is not a command here. Look it up in the Commands list.",
  301: "That needs a model first. Run regress, logit or another estimator, then try again.",
  321: "That needs a model first. Run an estimator, then try again.",
  459: "The data are not arranged as that command requires.",
  601: "No file or dataset has that name. sysuse dir lists the datasets.",
  2000: "No observations were left to use. An if condition or missing values may have removed them all.",
  2001: "There are too few observations to estimate that.",
  4: "The data in memory would be lost. Add the clear option if that is what you want.",
  9: "An assert was false: the data are not what the do-file expected.",
  5: "The data are not sorted as needed. Use sort, or bysort in place of by.",
};

// Commands students meet in other people's do-files that do not run here:
// community packages, which cannot be installed in a browser, and a few
// official commands with a usual replacement. Each names what to use.
const ELSEWHERE = {
  esttab: ["a community package", ["estimates", "etable", "table"]],
  estout: ["a community package", ["estimates", "etable", "table"]],
  eststo: ["a community package", ["estimates"]],
  estpost: ["a community package", ["tabstat", "summarize"]],
  outreg2: ["a community package", ["estimates", "etable", "putexcel"]],
  outreg: ["a community package", ["estimates", "etable"]],
  asdoc: ["a community package", ["estimates", "putexcel"]],
  reghdfe: ["a community package", ["areg", "xtreg"]],
  ivreg2: ["a community package", ["ivregress"]],
  xtivreg2: ["a community package", ["ivregress", "xtivreg"]],
  ivreghdfe: ["a community package", ["ivregress"]],
  winsor2: ["a community package", ["_pctile", "replace"]],
  winsor: ["a community package", ["_pctile", "replace"]],
  coefplot: ["a community package", ["marginsplot"]],
  binscatter: ["a community package", ["scatter", "lowess"]],
  tabout: ["a community package", ["tabulate", "table"]],
  fre: ["a community package", ["tabulate"]],
  mdesc: ["a community package", ["misstable"]],
  unique: ["a community package", ["duplicates", "levelsof"]],
  distinct: ["a community package", ["duplicates", "levelsof"]],
  ftools: ["a community package", []],
  gtools: ["a community package", []],
  sum2docx: ["a community package", ["tabstat"]],
  xi: [
    "an older official command",
    [],
    "Factor variables do its work: regress y i.group runs without xi:.",
  ],
};

// Options students use most, for a misspelt one.
const OPTIONS = [
  "robust",
  "cluster",
  "detail",
  "clear",
  "replace",
  "noconstant",
  "level",
  "missing",
  "nolabel",
  "row",
  "column",
  "cell",
  "generate",
  "absorb",
  "beta",
  "noheader",
  "separator",
  "abbreviate",
  "noobs",
  "statistics",
  "format",
  "title",
  "xtitle",
  "ytitle",
  "legend",
  "frequency",
  "percent",
  "normal",
  "nolog",
  "force",
  "ignore",
  "chi2",
  "exact",
  "nofreq",
  "means",
  "vce",
];

/** The edit distance between two words, adjacent swaps counting once. */
export function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/**
 * The candidates nearest a word: the same name in other capitals first,
 * then those within a small edit distance, then those that contain it or
 * that it begins. At most `count`, nearest first.
 */
export function nearest(word, candidates, count = 3) {
  const lower = word.toLowerCase(),
    room = Math.max(1, Math.min(3, Math.floor(word.length / 3))),
    scored = [];
  for (const name of new Set(candidates)) {
    if (name === word) continue;
    const other = name.toLowerCase();
    let score;
    if (other === lower) score = 0;
    else {
      const d = distance(lower, other);
      if (d <= room) score = d;
      else if (lower.length >= 2 && other.includes(lower))
        score = 3 + (other.length - lower.length) / 100;
      else if (other.length >= 3 && lower.startsWith(other))
        score = 3.5 + (lower.length - other.length) / 100;
      else continue;
    }
    scored.push([score, name]);
  }
  return scored
    .sort((x, y) => x[0] - y[0] || x[1].localeCompare(y[1]))
    .slice(0, count)
    .map(([, name]) => name);
}

/** A command with one word, whole, put in place of another. */
export function swap(command, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return command.replace(
    new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`),
    (_all, before) => before + to,
  );
}

/** "a", "a or b", "a, b or c". */
const either = (names) =>
  names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
const both = (names) =>
  names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

// Prefixes that come before a command, as the session reads them.
const PREFIX =
  /^(?:(?:cap(?:t(?:u(?:re?)?)?)?|qui(?:e(?:t(?:ly?)?)?)?|n(?:o(?:i(?:s(?:i(?:ly?)?)?)?)?)?)\s+|(?:by|bys(?:o(?:rt?)?)?)\s[^:]*:\s*|version\s+[\d.]+\s*:\s*)/;

/** A command line without its prefixes: { word, rest }. */
export function commandParts(text) {
  let line = String(text ?? "").trim(),
    before;
  do {
    before = line;
    line = line.replace(PREFIX, "").trim();
  } while (line !== before);
  const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(line)?.[0] ?? "";
  return { word, rest: line.slice(word.length) };
}

/** The registered command a typed word names, abbreviations included. */
export function resolveCommand(word, commands) {
  if (!word) return "";
  return (
    commands.find((c) => word.length >= c.minimum && c.name.startsWith(word))
      ?.name ?? ""
  );
}

/** The words of a command line that name variables in memory. */
function namedVariables(rest, variables) {
  const names = variables.map((v) => v.name),
    found = [];
  for (const word of rest
    .split(/(?:,|\bif\b|\bin\b)/)[0]
    .split(/[^A-Za-z0-9_]+/)) {
    if (!word) continue;
    const exact = names.includes(word)
      ? word
      : names.filter((name) => name.startsWith(word)).length === 1
        ? names.find((name) => name.startsWith(word))
        : "";
    if (exact && !found.includes(exact)) found.push(exact);
  }
  return found;
}

/**
 * What to tell a student about a record that failed, or null.
 * `commands` is the runtime's COMMANDS; `variables` the variables in
 * memory as the Console has them ({ name, type }). Returns { text, help,
 * suggest }: help is the command whose help to offer, suggest the names
 * offered in its place.
 */
export function adviseRecord(record, { commands = [], variables = [] } = {}) {
  if (!record?.rc) return null;
  const rc = record.rc,
    message = record.lines.join("\n"),
    { word, rest } = commandParts(record.command),
    command = resolveCommand(word, commands),
    help = command || "",
    names = [...new Set(commands.map((c) => c.name))];
  // A command that does not run here: what does, nearest first.
  const unknown = /command (\S+) is unrecognized/.exec(message);
  if (rc === 199 && unknown) {
    const typed = unknown[1],
      known = ELSEWHERE[typed.toLowerCase()];
    if (known) {
      const [what, instead, note] = known,
        here = instead.filter((name) => names.includes(name));
      const text =
        what === "a community package"
          ? `${typed} is a community-contributed package; packages cannot be installed in the browser.${here.length ? ` Use ${either(here)} here.` : ""}`
          : `${typed} is ${what} that does not run here. ${note}`;
      return { text, help: here[0] ?? "", suggest: here };
    }
    const close = nearest(typed, names);
    return {
      text: close.length
        ? `Did you mean ${either(close)}? The Commands list shows what runs here.`
        : "No command here is called that. The Commands list shows what runs here.",
      help: close[0] ?? "",
      suggest: close,
      fix: close.length ? swap(record.command, typed, close[0]) : "",
    };
  }
  // A variable name that is not in memory: the names nearest it.
  const missing = /^variable (\S+) not found/m.exec(message);
  if (rc === 111 && missing) {
    if (!variables.length)
      return {
        text: "There is no data in memory. Load a dataset first, with use, sysuse or import delimited.",
        help: "use",
        suggest: [],
      };
    const close = nearest(
      missing[1],
      variables.map((v) => v.name),
    );
    const sameButCase = close.find(
      (name) => name.toLowerCase() === missing[1].toLowerCase(),
    );
    return {
      text: sameButCase
        ? `Variable names are case-sensitive: the variable is called ${sameButCase}.`
        : close.length
          ? `Did you mean ${either(close)}? The Variables list shows every name.`
          : RC_HINTS[111],
      help,
      suggest: close,
      fix: close.length ? swap(record.command, missing[1], close[0]) : "",
    };
  }
  // A string variable where a number is needed: usually a CSV column that
  // has text in it, such as NA, or numbers written with commas.
  if (
    rc === 109 &&
    /string variables? (may not|not allowed)|type mismatch/.test(message)
  ) {
    const strings = namedVariables(rest, variables).filter((name) =>
      /^str/.test(variables.find((v) => v.name === name)?.type ?? ""),
    );
    if (strings.length)
      return {
        text: `${both(strings)} ${strings.length > 1 ? "are" : "is"} stored as text. If ${strings.length > 1 ? "they hold" : "it holds"} numbers, destring ${strings.join(" ")}, replace makes ${strings.length > 1 ? "them" : "it"} numeric; add ignore(",") for thousands separators, or force to make entries such as NA missing.`,
        help: "destring",
        suggest: ["destring"],
        fix: `destring ${strings.join(" ")}, replace`,
      };
  }
  // if x = 1 in place of if x == 1.
  if (
    (rc === 198 || (rc === 101 && /=exp not allowed/.test(message))) &&
    /\bif\b[^=]*[^=<>!~]=(?!=)/.test(record.command)
  )
    return {
      text: "A single = assigns. To compare two values, write ==, as in if group == 1.",
      help,
      fix: record.command.replace(
        /(\bif\b[^=]*[^=<>!~\s])\s*=(?!=)\s*/,
        "$1 == ",
      ),
      suggest: [],
    };
  const option = /^option (\S+?)\(?\)? not allowed/m.exec(message);
  if (rc === 198 && option) {
    const close = nearest(option[1], OPTIONS, 1);
    return {
      text: `${command || word} has no option ${option[1]} here.${close.length ? ` Did you mean ${close[0]}?` : " Check its spelling."} Options come after the comma.`,
      help,
      suggest: close,
      fix: close.length ? swap(record.command, option[1], close[0]) : "",
    };
  }
  const taken = /^variable (\S+) already defined/m.exec(message);
  if (rc === 110 && taken)
    return {
      text: `${taken[1]} already exists. To change it, write replace ${taken[1]} = …; to start again, drop ${taken[1]} first.`,
      help: "replace",
      suggest: ["replace"],
    };
  if (rc === 4)
    return {
      text: "The data in memory have changed and would be lost. Add , clear to the command if that is what you want.",
      help,
      suggest: [],
    };
  if (rc === 601 && /^\s*sysuse\b/.test(record.command))
    return {
      text: "Stata's own example datasets, such as auto, belong to StataCorp and are not here. sysuse dir lists this site's datasets.",
      help: "sysuse",
      suggest: [],
    };
  const general = RC_HINTS[rc];
  return general ? { text: general, help, suggest: [] } : null;
}
