// What the Console adds under a command that failed: one plain sentence a
// beginner can act on, and the command whose help to open. Stata's own
// message and return code are printed as Stata prints them; the hint is
// shown beside them, never in their place, and is not part of the log.
// This file reads only the record of a run and the names in memory, so it
// is the same in the page, in the worker and in the unit tests.

// What a return code usually means, when nothing more particular is known.
export const RC_HINTS = {
  100: "Something the command needs is missing; the message above names it.",
  101: "The command does not take part of what was typed; the message above names that part.",
  102: "Too few variables were given for that command.",
  103: "Too many variables were given for that command.",
  106: "A variable is a number in one dataset and text in the other. Make the two the same type first, with destring or tostring.",
  107: "That works on string variables, and the variable named is numeric.",
  108: "That works on numeric variables, and the variable named is a string.",
  109: "A string was used where a number was needed, or the other way round.",
  110: "That name is already taken. Choose another name, or drop what has it first.",
  111: "No variable has that name. Check the spelling and the capitals against the Variables list.",
  119: "That command is out of place here; the message above says what it needs first.",
  132: "A bracket or a quote is opened and never closed.",
  198: "Stata could not read that line. Look for a missing comma, a stray bracket or a misspelt option.",
  199: "That is not a command here. Look it up in the Commands list.",
  301: "That needs a model first. Run regress, logit or another estimator, then try again.",
  321: "That needs a model first. Run an estimator, then try again.",
  459: "The data are not arranged as that command requires.",
  601: "No file or dataset has that name.",
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
};

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

/** A command line without its prefixes. */
function bare(text) {
  let line = String(text ?? "").trim(),
    before;
  do {
    before = line;
    line = line.replace(PREFIX, "").trim();
  } while (line !== before);
  return line;
}

/** A command line without its prefixes: { word, rest }. */
export function commandParts(text) {
  const line = bare(text);
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

/** The variables in memory that the words of a command line name. */
function namedVariables(rest, variables) {
  const names = variables.map((v) => v.name),
    found = [];
  for (const word of rest.split(",")[0].split(/[^A-Za-z0-9_]+/)) {
    if (!word) continue;
    const starting = names.filter((name) => name.startsWith(word)),
      exact = names.includes(word)
        ? word
        : starting.length === 1
          ? starting[0]
          : "";
    if (exact && !found.includes(exact)) found.push(exact);
  }
  return found;
}

const plural = (names, one, many) => (names.length > 1 ? many : one);
const quoted = (texts) => texts.map((text) => `"${text}"`);

/**
 * What to say of string variables used where numbers are needed, from what
 * they hold (the session's record.strings). destring is offered only when
 * it would work: every entry a number, perhaps written with commas, or an
 * entry such as NA that means no value, which force makes missing. A
 * variable of words is to be compared with text in quotes, or encoded.
 */
function stringAdvice(strings, contents, command = "") {
  const numeric = strings.filter((name) => contents[name]?.others === 0),
    mixed = strings.filter(
      (name) => contents[name]?.others > 0 && contents[name].numbers > 0,
    ),
    words = strings.filter(
      (name) => contents[name]?.others > 0 && !contents[name].numbers,
    ),
    unknown = strings.filter((name) => !contents[name]),
    sentences = [];
  let fix = "";
  if (numeric.length) {
    const missing = [
        ...new Set(numeric.flatMap((name) => contents[name].missing)),
      ],
      ignore = [
        ...new Set(numeric.flatMap((name) => [...contents[name].ignore])),
      ].join(""),
      marks = {
        ",": "commas",
        $: "$ signs",
        "%": "% signs",
        " ": "spaces",
      },
      written = [
        missing.length ? `${either(quoted(missing))} for a missing value` : "",
        ignore
          ? `${both([...ignore].map((c) => marks[c]))} in the numbers`
          : "",
      ].filter(Boolean);
    fix = `destring ${numeric.join(" ")}, replace${ignore ? ` ignore("${ignore}")` : ""}${missing.length ? " force" : ""}`;
    sentences.push(
      `${both(numeric)} ${plural(numeric, "is", "are")} stored as text but ${plural(numeric, "holds", "hold")} numbers${written.length ? `, with ${both(written)}` : ""}. ${fix} makes ${plural(numeric, "it", "them")} numeric${missing.length ? `, with ${either(quoted(missing))} as missing (.)` : ""}.`,
    );
  }
  for (const name of mixed)
    sentences.push(
      `${name} is stored as text: most entries are numbers, but some, such as ${either(quoted(contents[name].words))}, are not. Correct those with replace, then destring ${name}, replace makes it numeric (force would make them missing instead).`,
    );
  let help = "";
  if (words.length) {
    const said = textUse(words, contents, command);
    sentences.push(said.text);
    if (said.fix && !fix) fix = said.fix;
    help = said.help;
  }
  if (unknown.length)
    sentences.push(
      `${both(unknown)} ${plural(unknown, "is", "are")} stored as text. If ${plural(unknown, "it holds", "they hold")} numbers, destring makes ${plural(unknown, "it", "them")} numeric; help destring shows its ignore() and force options.`,
    );
  const helped = help || (fix || !words.length ? "destring" : "encode");
  return {
    text: sentences.join(" "),
    help: helped,
    suggest: [helped],
    fix,
  };
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What to say of string variables of words used where a number is needed,
 * by how the command uses the first of them: given a number by replace or
 * generate, compared with . for missing, joined to a second string by | or
 * &, compared with a number, or used in arithmetic or a list of variables.
 */
function textUse(words, contents, command) {
  const [first] = words,
    shown = either(quoted(contents[first].words.slice(0, 2))),
    holds = `${both(words)} ${plural(words, "holds", "hold")} text, such as ${shown}, not numbers`,
    name = escape(first),
    encode = `encode ${first}, generate(${first}_code)`;
  // replace region = 5 or = educ: the new value must be text too; a
  // numbered copy of region would not take it.
  const given = new RegExp(
    `^(replace\\s+${name}\\s*=\\s*)(.+?)(?=\\s+(?:if|in)\\b|\\s*,|\\s*$)`,
  ).exec(bare(command));
  if (given && !given[2].includes('"')) {
    const value = given[2].trim(),
      literal = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value),
      // 1e3 is the text "1000".
      text = /e/i.test(value) ? String(Number(value)) : value;
    if (literal)
      return {
        text: `${first} holds text, so a value given to it goes in quotes: "${text}". To store numbers, make a numeric variable instead, or destring ${first} if all its entries are numbers.`,
        fix: command.replace(given[0], `${given[1]}"${text}"`),
        help: "replace",
      };
    const variable = /^[A-Za-z_]\w*$/.test(value);
    return {
      text: `${first} holds text, so the value given to it must be text too, and ${value} is a number. string(${value}) writes a number as text${variable ? `, as in replace ${first} = string(${value})` : ""}. To store numbers, make a numeric variable instead.`,
      fix: variable
        ? command.replace(given[0], `${given[1]}string(${value})`)
        : "",
      help: "replace",
    };
  }
  // g == . : a missing string is "", and missing() covers both.
  const dot = new RegExp(`\\b${name}\\s*(==|!=|~=)\\s*\\.(?![\\w.])`).exec(
    command,
  );
  if (dot)
    return {
      text: `${first} holds text, and a missing text value is empty (""), not a dot. Write ${dot[1] === "==" ? "" : "!"}missing(${first}), or ${first} ${dot[1]} "".`,
      fix: command.replace(
        dot[0],
        `${dot[1] === "==" ? "" : "!"}missing(${first})`,
      ),
      help: "missing",
    };
  // g == "a" | "b": each side of | is a condition of its own.
  const chain = new RegExp(
    `\\b${name}\\s*(==|!=)\\s*("[^"]*")((?:\\s*[|&]\\s*"[^"]*")+)`,
  ).exec(command);
  if (chain) {
    const rest = [...chain[3].matchAll(/\s*([|&])\s*("[^"]*")/g)];
    return {
      text: `Each side of ${rest[0][1]} is a condition of its own, and ${rest[0][2]} alone is text, not a condition. Name the variable each time, as ${first} ${chain[1]} ${chain[2]} ${rest[0][1]} ${first} ${chain[1]} ${rest[0][2]}${chain[1] === "==" && rest.every((m) => m[1] === "|") ? `, or write inlist(${first}, ${[chain[2], ...rest.map((m) => m[2])].join(", ")})` : ""}.`,
      fix: command.replace(
        chain[0],
        `${first} ${chain[1]} ${chain[2]}${rest.map((m) => ` ${m[1]} ${first} ${chain[1]} ${m[2]}`).join("")}`,
      ),
      help: "operators",
    };
  }
  // sex == 1: a value compared with text goes in quotes.
  const compared = new RegExp(
    `\\b${name}\\s*(?:==|!=|~=|<=|>=|<|>)\\s*[-+]?\\.?\\d|(?:^|[^\\w.])[-+]?(?:\\d+\\.?\\d*|\\.\\d+)\\s*(?:==|!=|~=|<=|>=|<|>)\\s*${name}\\b`,
  ).test(command);
  if (compared)
    return {
      text: `${holds}. Compare ${plural(words, "it", "them")} with text in quotes, as ${first} == "${contents[first].words[0]}", or make a numbered copy with ${encode}.`,
      fix: "",
      help: "encode",
    };
  return {
    text: `${both(words)} ${plural(words, "holds", "hold")} text, such as ${shown}, where a number is needed. ${encode} makes a numbered copy, its values labelled with the text, that can go in ${plural(words, "its", "their")} place.`,
    fix: "",
    help: "encode",
  };
}

/** What a command does not take, from "… not allowed", r(101). */
function notTaken(name, message, command) {
  const what = /^(.+?) not allowed/m.exec(message)?.[1] ?? "";
  // L.c.x, cL.x or iL.x: an operator of each kind on one variable.
  if (
    /factor[- ]variable and time-series/.test(message) &&
    /(?:^|[\s(#])(?:[LFDS]\d*\.[ci]\.|[ci]\.?[LFDS]\d*\.)\w/.test(command)
  )
    return "A time-series operator and a factor-variable operator on one variable, as in L.c.x, do not run together here yet. For a lag of a continuous variable, L.x is the same as L.c.x; otherwise make the variable with generate first.";
  if (/factor[- ]variable|time-series|operator/.test(message))
    return "That command does not take factor or time-series notation here. Make the variable with generate first.";
  if (what === "if")
    return `${name} does not take an if condition; it works on every observation. Take out the if part.`;
  if (what === "in range" || what === "in")
    return `${name} does not take in; it works on every observation. Take out the in part.`;
  if (/^[a-z]*weights?$/.test(what))
    return `${name} here does not take ${what === "weights" ? "weights" : what}. Take out the part in square brackets.`;
  if (what === "options")
    return `${name} takes no options. Take out the comma and what follows it.`;
  if (what === "varlist") return `${name} does not take variable names here.`;
  if (what === "using") return `${name} does not take using here.`;
  if (what === "=exp") return `${name} does not take = and an expression here.`;
  return RC_HINTS[101];
}

/** The close brackets a line lacks, when its last option is left open. */
function closing(command) {
  let depth = 0,
    open = -1;
  for (let i = 0; i < command.length; i++)
    if (command[i] === "(") {
      if (!depth) open = i;
      depth++;
    } else if (command[i] === ")") depth = Math.max(0, depth - 1);
  // Only one bracket open, and nothing bracketed after it: the close
  // belongs at the end.
  if (depth !== 1 || /[()]/.test(command.slice(open + 1))) return "";
  return `${command.trimEnd()})`;
}

/**
 * Where an if condition has a single =, outside quotes and brackets: its
 * index in the command, or -1.
 */
function loneIf(command) {
  const start = /(?:^|\s)if\s/.exec(command);
  if (!start) return -1;
  let quote = false,
    depth = 0;
  for (let i = start.index + start[0].length; i < command.length; i++) {
    const c = command[i];
    if (c === '"') quote = !quote;
    if (quote) continue;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === ",") break;
    else if (
      c === "=" &&
      !depth &&
      !/[=!~<>]/.test(command[i - 1] ?? "") &&
      command[i + 1] !== "="
    )
      return i;
  }
  return -1;
}

// Options students write before the comma. The function of egen and the
// at() of a time-series operator are not options, so only these are read.
const EARLY =
  /\b(by|dydx|eyex|dyex|eydx|at|over|vce|absorb|cluster|level|group|time|select|ar|ma|lags)\s*\(/;

/**
 * An option written before the comma, as in margins dydx(x): { option,
 * fix }, or null. `word` is the command as typed.
 */
function earlyOption(command, word) {
  if (
    !/^(margins?|egen|reg\w*|logit|probit|logistic|xt\w+|ivreg\w*|arima|didregress|heckman|mixed|areg|newey|poisson|nbreg)$/.test(
      word,
    )
  )
    return null;
  // The part before any comma, outside brackets and quotes.
  let quote = false,
    depth = 0,
    comma = command.length;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '"') quote = !quote;
    if (quote) continue;
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && !depth) {
      comma = i;
      break;
    }
  }
  const head = command.slice(0, comma),
    // egen's own function, as mean() in egen m = mean(x), is not one.
    after =
      word === "egen"
        ? head.replace(/=\s*\w+\([^)]*\)/, (all) => " ".repeat(all.length))
        : head,
    found = EARLY.exec(after);
  if (!found) return null;
  const at = found.index,
    rest = command.slice(comma + 1).trim();
  return {
    option: found[1],
    // by (region) is written by(region), as options are.
    fix: `${head.slice(0, at).trimEnd()}, ${head
      .slice(at)
      .trim()
      .replace(/^(\w+)\s+\(/, "$1(")}${rest ? ` ${rest}` : ""}`,
  };
}

/** What is missing, from "… required", r(100). */
function required(name, message) {
  const what = /^(.+?) required/m.exec(message)?.[1] ?? "";
  if (what === ")")
    return "A bracket opened with ( is not closed. Add ) where the option ends.";
  if (what === "varlist")
    return "A list of variables was needed and none was given.";
  if (what === "using") return `${name} needs using and the name of a file.`;
  if (what === "=exp")
    return `${name} needs = and an expression, as in generate y = x * 2.`;
  if (what) return `${name} needs ${what}, and none was given.`;
  return RC_HINTS[100];
}

// A macro as typed: `name', ${name} or $name.
const MACRO = /`(\w+)'|\$\{(\w+)\}|\$([A-Za-z_]\w*)/g;

/**
 * The first macro, as typed, of the line of `read` that expanded into
 * `expanded` (a loop's line, a program's), or "".
 */
function macroIn(read, expanded) {
  const target = expanded.trim();
  for (const line of read.split("\n")) {
    const refs = [...line.matchAll(MACRO)];
    if (!refs.length) continue;
    // The line with each macro as anything at all.
    const loose = (text) => escape(text.trim()).replace(/\s+/g, "\\s+");
    let pattern = "",
      at = 0;
    for (const ref of refs) {
      pattern += `${loose(line.slice(at, ref.index))}\\s*[\\s\\S]*?\\s*`;
      at = ref.index + ref[0].length;
    }
    pattern += loose(line.slice(at));
    if (new RegExp(`^${pattern}$`).test(target)) return refs[0][0];
  }
  return "";
}

/** The variable a name gives, whole or abbreviated as Stata allows. */
function abbreviated(name, variables) {
  if (!name) return undefined;
  const exact = variables.find((v) => v.name === name);
  if (exact) return exact;
  const starting = variables.filter((v) => v.name.startsWith(name));
  return starting.length === 1 ? starting[0] : undefined;
}

/** Whether a record is one line that could be run again by itself. */
const oneLine = (record) =>
  !record.echo?.length && !/[\n{}]/.test(record.command);

/**
 * What to tell a student about a record, or null: for a record that failed,
 * what went wrong and what to do; for one that ran, a note only when its
 * result often surprises (missing values generated, or a > that counted
 * missing values). `commands` is the runtime's COMMANDS; `variables` the
 * variables in memory as the Console has them ({ name, type, valueLabel }),
 * `labels` their value labels ({ name: { values } }), `files` the names of
 * the files added, and `observations` how many there are. Returns { text,
 * help, suggest, fix }: help is the command whose help to offer, suggest
 * the names offered in its place, fix a corrected command line. A record of
 * a loop or a block has no fix: the change belongs in the do-file; nor has
 * a line whose macros were expanded, as its fix would lose them.
 */
export function adviseRecord(record, context = {}) {
  if (!record) return null;
  // A command echoed as typed, its comments and continuation lines with
  // it, is advised on as it was read (record.text), and its macros as
  // they were expanded (record.expanded).
  const read = record.text ?? record.command,
    expanded =
      record.expanded && record.expanded !== read ? record.expanded : "";
  const advice = record.rc
    ? advise(
        {
          ...record,
          command: expanded || read,
          // The macro the line used, to show where quotes would go.
          macro: expanded ? macroIn(read, expanded) : "",
        },
        context,
      )
    : note({ ...record, command: expanded || read });
  if (advice?.fix && (!oneLine(record) || expanded)) delete advice.fix;
  return advice;
}

// The runtime's own word that a part of Stata does not run in the browser:
// "option X is not available in the browser yet", "egen mode() is not
// available yet", "svy: X is not available here; ...", "extended macro
// function "colnames" is not supported". Stata's own messages say "not
// allowed", "not valid" or "invalid" instead.
const REFUSAL =
    /\b(?:is|are) not (?:yet )?available\b|\bnot available\b[^\n;]*\b(?:yet|in the browser|here)\b|\bin the browser yet\b|^(?:extended macro function "\S+" is not supported|this macro list operation is not supported|set \S+ is not supported)$/m,
  // Stata's own messages in those words.
  STATA_OWN = /^\S+ \S+ is not available after command \S+$|^Java /m;

/** The hint for a refusal: that Stata runs it, and what to do here. */
function refused(record, message, help) {
  const first = message.split("\n")[0],
    option = /^option (\S+?)(\(\))? (?:of \S+ )?(?:is|are) not/.exec(first),
    // vce(hc2), seed(...), corr(...): an option named with what it holds.
    given = /^([a-z]\w*\([^;]*?\))(?: \S+)? (?:is|are) not/.exec(first),
    // The rest of the message after its semicolon says what runs here:
    // "; format() is", "; use vce(robust)", "; xtreg clusters on the
    // panel variable here: vce(cluster state)".
    instead = /;\s*\S/.test(first),
    said = record.hint?.trim();
  if (/^merge m:m\b/.test(first))
    return {
      text: "Stata runs merge m:m, but this browser version does not. It pairs observations by their order within each key, which is rarely what is wanted: merge 1:m or m:1 matches on a key that is unique on one side, and joinby forms every pair.",
      help: "merge",
      suggest: ["joinby"],
    };
  let text = "Stata runs this, but this browser version does not yet.";
  if (said) text += ` ${said}`;
  else if (option || given) {
    // nonotes is refused as option notes: the option as typed.
    const typed = option
      ? (new RegExp(`\\b(?:no)?${escape(option[1])}\\w*(?:\\([^()]*\\))?`).exec(
          record.command.slice(record.command.indexOf(",") + 1),
        )?.[0] ?? `${option[1]}${option[2] ?? ""}`)
      : given[1];
    text += ` Leave out ${typed}${instead ? ", or do as the rest of the message says" : ""}, or run the command in Stata itself.`;
  } else if (instead)
    text +=
      " The rest of the message says what runs here instead; use that, or run this step in Stata itself.";
  else
    text +=
      " Do this step another way, or run it in Stata itself; the Commands list shows what runs here.";
  return { text, help, suggest: [] };
}

// Stata's own subcommands of import, export and graph, and its kernels,
// each with the shortest abbreviation Stata 19 takes, and those that run
// here. A word that abbreviates none of them is a typo, which Stata itself
// refuses ("import: unknown subcommand", "invalid kernel function", r(4023)
// for graph), not a part of Stata the browser lacks.
const OWN_WORDS = {
  import: {
    stata: [
      ["excel", 3],
      ["delimited", 5],
      ["sas", 3],
      ["sasxport5", 9],
      ["sasxport8", 9],
      ["spss", 4],
      ["dbase", 5],
      ["fred", 4],
      ["haver", 3],
      ["shp", 3],
    ],
    here: ["excel", "delimited", "spss", "sasxport5", "sasxport8"],
  },
  export: {
    stata: [
      ["excel", 3],
      ["delimited", 5],
      ["sasxport5", 9],
      ["sasxport8", 9],
      ["spss", 4],
      ["dbase", 4],
    ],
    here: ["excel", "delimited", "sasxport5", "sasxport8"],
  },
  graph: {
    stata: [
      ["twoway", 2],
      ["bar", 3],
      ["hbar", 4],
      ["box", 3],
      ["hbox", 4],
      ["dot", 3],
      ["pie", 3],
      ["matrix", 3],
      ["combine", 7],
      ["export", 6],
      ["display", 2],
      ["save", 4],
      ["use", 3],
      ["dir", 3],
      ["describe", 2],
      ["drop", 4],
      ["rename", 6],
      ["copy", 4],
      ["close", 5],
      ["query", 1],
      ["set", 3],
      ["print", 5],
      ["replay", 6],
    ],
    here: [
      "twoway",
      "bar",
      "hbar",
      "box",
      "hbox",
      "pie",
      "matrix",
      "combine",
      "export",
      "display",
      "dir",
      "rename",
      "drop",
    ],
  },
  kernel: {
    stata: [
      ["epanechnikov", 2],
      ["epan2", 5],
      ["biweight", 2],
      ["cosine", 3],
      ["gaussian", 3],
      ["parzen", 3],
      ["rectangle", 3],
      ["triangle", 3],
    ],
    here: [
      "epanechnikov",
      "epan2",
      "biweight",
      "gaussian",
      "rectangle",
      "triangle",
    ],
  },
};

/** Whether a word is one of Stata's own, as Stata abbreviates it. */
const ownWord = (kind, word) =>
  OWN_WORDS[kind].stata.some(
    ([name, shortest]) => word.length >= shortest && name.startsWith(word),
  );

// Commands of their own that students write after graph, as in graph
// scatter y x: graph twoway takes the plot types, and histogram is a
// command of its own.
const PLOTS =
  /^(scatter|line|connected|area|lfit|qfit|lfitci|qfitci|function|histogram|hist|kdensity|rarea|rbar|rcap|rspike|spike|dropline|lowess)$/;

/**
 * A subcommand of import, export or graph, or a kernel, that is not one of
 * Stata's: Stata refuses it too, so the hint is about the typo, never that
 * Stata runs it. Read from Stata's own messages and from the runtime's.
 */
function ownTypo(record, message, name) {
  const first = message.split("\n")[0],
    unknown =
      /^(import|export): unknown subcommand "(\S+)"$/.exec(first) ??
      /^(import|export|graph) (\S+) is not available\b/.exec(first),
    // graph scatter: Stata's message is bogusgraph_g.new …: class member
    // function not found.
    graph = /^(\S+)graph_g\.new\b.*class member function not found$/.exec(
      first,
    ),
    kernel =
      /^kernel\((.*)\) is not available$/.exec(first) ??
      (/^invalid kernel function$/.test(first)
        ? /\bk(?:e(?:r(?:n(?:el?)?)?)?)?\(\s*([^)]*?)\s*\)/.exec(record.command)
        : null);
  if (kernel) {
    const typed = kernel[1].trim();
    if (ownWord("kernel", typed.toLowerCase())) return null;
    const close = nearest(
        typed,
        OWN_WORDS.kernel.here.filter((each) => each !== "epan2"),
        1,
      ),
      list = OWN_WORDS.kernel.stata.map(([each]) => each);
    return {
      text: `${name} has no kernel ${typed}. kernel() takes ${either(list)}; epanechnikov is used when kernel() is left out.${close.length ? ` Did you mean ${close[0]}?` : ""}`,
      help: name,
      suggest: [],
      fix: close.length
        ? record.command.replace(
            new RegExp(`(\\(\\s*)${escape(typed)}(\\s*\\))`),
            `$1${close[0]}$2`,
          )
        : "",
    };
  }
  const [kind, typed] = unknown
    ? [unknown[1], unknown[2]]
    : graph
      ? ["graph", graph[1]]
      : [];
  if (!kind || ownWord(kind, typed)) return null;
  const words = OWN_WORDS[kind],
    lower = typed.toLowerCase(),
    // A .csv is read by import delimited, a workbook by import excel.
    meant = /^(csv|txt|text|tab|tsv|delim\w*|delm\w*|deli\w*)$/.test(lower)
      ? "delimited"
      : /^(xlsx?|xl\w*|exc?el+)$/.test(lower)
        ? "excel"
        : nearest(
            typed,
            words.stata.map(([each]) => each),
            1,
          )[0],
    command = new RegExp(`^(\\s*\\S+\\s+)${escape(typed)}(?![\\w])`);
  if (kind === "graph" && PLOTS.test(lower)) {
    const twoway = !/^(hist\w*|kdensity)$/.test(lower);
    return {
      text: twoway
        ? `graph has no subcommand ${typed}: ${typed} is a twoway plot type, written ${typed} y x or graph twoway ${typed} y x.`
        : `graph has no subcommand ${typed}: ${typed} is a command of its own.`,
      help: twoway ? "twoway" : lower === "kdensity" ? "kdensity" : "histogram",
      suggest: [],
      fix: record.command.replace(/^(\s*)gr\w*\s+/, "$1"),
    };
  }
  const runs = meant && words.here.includes(meant);
  return {
    text: `${kind} has no subcommand ${typed}.${meant ? ` Did you mean ${kind} ${meant}?` : ""}${meant && !runs ? ` ${kind} ${meant} is part of Stata but does not run in this browser version yet.` : ""} The ${kind} subcommands that run here are ${both(words.here)}.`,
    help: kind,
    suggest: [],
    fix:
      runs && command.test(record.command)
        ? record.command.replace(command, `$1${meant}`)
        : "",
  };
}

// Stata's immediate commands, which take summary numbers typed on the
// line, and the command each is the immediate form of.
const IMMEDIATE = {
  bitesti: "bitest",
  cci: "cc",
  cii: "ci",
  csi: "cs",
  esizei: "esize",
  iri: "ir",
  mcci: "mcc",
  prtesti: "prtest",
  sdtesti: "sdtest",
  symmi: "symmetry",
  tabi: "tabulate",
  ttesti: "ttest",
  ztesti: "ztest",
};

// egen's functions that generate does not have: mean() in generate is
// unknown, r(133), and egen m = mean(x) is what is meant.
const EGEN_ONLY =
  /^(mean|sd|total|count|median|iqr|pctile|rank|std|tag|group|seq|mode|kurt|skew|mad|mdev|fill|diff|ends|concat|cut|anycount|anymatch|anyvalue|rowtotal|rowmean|rowmin|rowmax|rowmiss|rownonmiss|rowsd|rowfirst|rowlast|rowmedian|rowpctile)$/;

// Postestimation commands whose names are the last model's coefficients.
const COEFFICIENT_COMMANDS =
  /^(test|testparm|lincom|nlcom|testnl|contrast|pwcompare)$/;

const GENERATE = /^g(e(n(e(r(a(te?)?)?)?)?)?)?$/;

/** What to say of a file that is not among those added, r(601). */
function absentFile(record, files, command) {
  const typed =
    /^file (.+?) not found\b/m
      .exec(record.lines.join("\n"))?.[1]
      ?.replace(/^"(.*)"$/, "$1") ?? "";
  if (!typed) return null;
  const base = typed.replace(/^.*[\\/]/, ""),
    lower = base.toLowerCase(),
    have =
      files.find((file) => file.toLowerCase() === lower) ??
      // use people looks for people.dta.
      (base.includes(".")
        ? undefined
        : files.find((file) => file.toLowerCase() === `${lower}.dta`)),
    help = command || "";
  if (base !== typed)
    return have
      ? {
          text: `${have} is among your files, but files here are not in folders: name it without the folder, as ${have}.`,
          help,
          suggest: [],
          fix: record.command.includes(typed)
            ? record.command.replace(typed, have)
            : "",
        }
      : {
          text: `Files here are not in folders, and none is called ${base}. Open Data and add it, then name it without the folder, as ${base}.`,
          help,
          suggest: [],
        };
  if (have)
    return {
      text: `${have} is among your files; name it as it is written there.`,
      help,
      suggest: [],
      fix: record.command.includes(typed)
        ? record.command.replace(typed, have)
        : "",
    };
  const doFile = /^(do|run|include)$/.test(command);
  return {
    text: `${base} is not among your files. Open Data and add ${doFile ? "the do-file" : "it"}, then run the command again.${command === "use" && !/\.dta\b/i.test(record.command) ? " If it is one of this site's teaching datasets, sysuse opens it, and sysuse dir lists them." : ""}`,
    help,
    suggest: [],
  };
}

/**
 * The variables of a model, read from its coefficients' names (educ,
 * 1.female, 0b.female, c.educ#c.exper, L.x, eq:x): names, as a hint names
 * them (i.female for a factor variable); levels, the levels of each factor
 * variable that have a coefficient of their own (not the base, not one
 * omitted); within, the interactions each variable is in.
 */
function modelTerms(coefficients) {
  const names = new Set(),
    levels = {},
    within = {};
  for (const raw of coefficients) {
    const term = raw.replace(/^.*:/, "");
    if (term === "_cons") continue;
    const parts = term.split("#").map((part) => {
      const factor = /^(\d+)([a-z]*)\.([A-Za-z_]\w*)$/.exec(part);
      if (factor)
        return {
          name: factor[3],
          level: factor[1],
          // 0b. is the base and 1o. omitted; 1bn. (no base) has its own.
          kept: !/o|b(?!n)/.test(factor[2]),
        };
      const name = part.replace(/^(?:[A-Za-z]+\d*\.)+/, "");
      return /^[A-Za-z_]\w*$/.test(name) ? { name } : null;
    });
    // o._cons, an equation's omitted constant, is no variable either.
    if (parts.some((part) => !part || part.name === "_cons")) continue;
    if (parts.length === 1) {
      const [{ name, level, kept }] = parts;
      names.add(level === undefined ? name : `i.${name}`);
      if (level !== undefined && kept) {
        levels[name] ??= [];
        if (!levels[name].includes(level)) levels[name].push(level);
      }
    } else
      for (const { name } of parts) {
        within[name] ??= [];
        if (!within[name].includes(term)) within[name].push(term);
      }
  }
  return { names: [...names], levels, within };
}

/** What to say of a name in an expression or varlist that is not found. */
function notFound(record, typed, ctx) {
  const { message, command, name, help, variables, variableNames, labels } =
    ctx;
  // test, lincom and the like read the last model's coefficients, not the
  // data.
  if (COEFFICIENT_COMMANDS.test(command) && record.model) {
    const fitted = record.model.command,
      terms = modelTerms(record.model.coefficients ?? []),
      own = terms.names,
      // A factor variable is not offered: its coefficients are levels.
      close = (variableNames.includes(typed) ? [] : nearest(typed, own)).filter(
        (each) =>
          !each.startsWith("i.") &&
          distance(each.toLowerCase(), typed.toLowerCase()) <= 2,
      );
    // regress y i.female: female is in the model, as 1.female.
    const levels = terms.levels[typed];
    if (levels?.length) {
      const named = levels.map((level) => `${level}.${typed}`),
        one = named.length === 1;
      return {
        text: `${typed} is in the last model (${fitted}) as a factor variable, i.${typed}, and its coefficient${one ? " is" : "s are"} named by level: ${both(named)}. ${one || command === "test" ? `${command} ${named.join(" ")}` : `testparm i.${typed}`} ${command === "lincom" && one ? "gives its estimate" : `tests ${one ? "it" : "them together"}`}.`,
        help,
        suggest: [],
        fix:
          one || command === "test"
            ? swap(record.command, typed, named.join(" "))
            : "",
      };
    }
    // regress y c.x#c.z: x is in the model only in an interaction.
    const within = terms.within[typed];
    if (within?.length)
      return {
        text: `${typed} is in the last model (${fitted}) only in ${either(within.slice(0, 3))}, and ${name} names a coefficient as the table of results does, as ${name} ${within[0]}.`,
        help,
        suggest: [],
        fix: within.length === 1 ? swap(record.command, typed, within[0]) : "",
      };
    return {
      text: variableNames.includes(typed)
        ? `${typed} is in the data but not in the last model (${fitted}), and ${name} reads that model's coefficients. Fit a model that includes ${typed}${own.length ? `, or name one of the variables it has: ${either(own.slice(0, 6))}` : ""}.`
        : close.length
          ? `Did you mean ${either(close)}? ${name} names coefficients of the last model (${fitted}).`
          : `The last model (${fitted}) has no coefficient called ${typed}${own.length ? `; its variables are ${both(own.slice(0, 6))}${own.length > 6 ? " and others" : ""}` : ""}.`,
      help,
      suggest: close,
      fix: close.length ? swap(record.command, typed, close[0]) : "",
    };
  }
  // merge's key, in memory but not in the using file.
  if (
    /^(merge|joinby)$/.test(command) &&
    /^variable /m.test(message) &&
    variableNames.includes(typed)
  ) {
    const using = /\busing\s+("[^"]+"|[^\s,]+)/.exec(record.command)?.[1];
    return {
      text: `${typed} is in the data in memory, so it is the using file${using ? `, ${using},` : ""} that lacks it: ${command} needs the key variables in both. describe using ${using ?? "filename"} lists the names in that file.`,
      help: command,
      suggest: [],
    };
  }
  // display abc, where abc is text: text is shown in quotes; display
  // wagee, where wage is meant: the variable.
  if (command === "display") {
    const close = record.macro
      ? []
      : nearest(typed, variableNames, 1).filter(
          (each) => distance(each.toLowerCase(), typed.toLowerCase()) <= 2,
        );
    if (close.length)
      return {
        text: `Did you mean ${close[0]}? display shows the value of a variable in the first observation, or in the one named in brackets, as ${close[0]}[1].`,
        help: "display",
        suggest: close,
        fix: swap(record.command, typed, close[0]),
      };
    return {
      text: `display reads ${typed} as the name of a variable or scalar, and there is none. To show it as text, put it in quotes${record.macro ? `, around the macro as well, as display "${record.macro}"` : `, as display "${typed}"`}.`,
      help: "display",
      suggest: [],
    };
  }
  // A word compared with a variable is a value: if region == North means
  // if region == "North", or the number its value label gives North. The
  // variable may be abbreviated, as fem for female.
  const compared = new RegExp(
    `(?:^|[^\\w.])([A-Za-z_]\\w*)\\s*(==|!=|~=|<=|>=|<|>)\\s*${typed}(?![\\w"])|(?:^|[^\\w"])${typed}\\s*(==|!=|~=|<=|>=|<|>)\\s*([A-Za-z_]\\w*)(?![\\w(])`,
  ).exec(record.command);
  const against = compared ? (compared[1] ?? compared[4]) : "",
    // 1 < x is x > 1.
    operator = compared
      ? compared[1]
        ? compared[2]
        : ({ "<": ">", ">": "<", "<=": ">=", ">=": "<=" }[compared[3]] ??
          compared[3])
      : "==",
    other = abbreviated(against, variables),
    word = new RegExp(`(^|[^\\w"])${typed}(?![\\w"])`);
  if (other && /^str/.test(other.type ?? ""))
    return {
      text: `${other.name} holds text, so a value compared with it goes in quotes: "${typed}". Without them, ${typed} is read as the name of a variable.${record.macro ? ` When a macro holds the text, the quotes go around it, as "${record.macro}".` : ""}`,
      help,
      suggest: [],
      fix: record.command.replace(word, `$1"${typed}"`),
    };
  if (other?.valueLabel) {
    const code = (labels[other.valueLabel]?.values ?? []).find(
      ([, text]) => text === typed,
    )?.[0];
    return {
      text:
        code !== undefined
          ? `${other.name} is numeric, and ${typed} is the label of its value ${code}, not a variable. Compare it with the number: ${other.name} ${operator} ${code}.`
          : `${other.name} is numeric, with value label ${other.valueLabel}, and ${typed} is read as the name of a variable. Compare ${other.name} with one of its numbers; label list ${other.valueLabel} shows each label's number.`,
      help: "label",
      suggest: [],
      fix: code !== undefined ? record.command.replace(word, `$1${code}`) : "",
    };
  }
  // x5 in x1-x5, or in a loop up to 5, past the last of x1, x2, x3.
  const numbered = /^([A-Za-z_]\w*?)(\d+)$/.exec(typed);
  if (numbered) {
    const [, stem, digits] = numbered,
      members = variableNames
        .map((each) => new RegExp(`^${stem}(\\d+)$`).exec(each))
        .filter(Boolean)
        .map((m) => Number(m[1])),
      last = members.length ? Math.max(...members) : -1;
    if (members.length >= 2 && Number(digits) > last) {
      const end = `${stem}${last}`,
        range = new RegExp(`(\\b${stem}\\d+\\s*-\\s*)${typed}(?!\\w)`).exec(
          record.command,
        );
      return {
        text: `There is no ${typed}: the variables ${stem}1, ${stem}2, … here stop at ${end}.${range ? ` End the range at ${end}.` : ""}`,
        help,
        suggest: [end],
        fix: range ? record.command.replace(range[0], `${range[1]}${end}`) : "",
      };
    }
  }
  // A name already in a list of variables is not offered in its place, as
  // wage for wages in regress wage wages. In an expression it may be, as
  // income in replace income = incme + 1. A variable is never offered to
  // be compared with itself.
  // reshape's i() and j() name different variables, so its options count
  // as well.
  const inCommand = new Set(
      /^variable /m.test(message)
        ? (command === "reshape"
            ? record.command
            : record.command.split(",")[0]
          )
            .split(/[^A-Za-z0-9_]+/)
            .filter((word) => word && word !== typed)
        : [],
    ),
    close = nearest(typed, variableNames).filter(
      (name) =>
        !inCommand.has(name) && name !== against && name !== other?.name,
    ),
    sameButCase = close.find(
      (name) => name.toLowerCase() === typed.toLowerCase(),
    );
  return {
    text: sameButCase
      ? `Variable names are case-sensitive: the variable is called ${sameButCase}.`
      : close.length
        ? `Did you mean ${either(close)}? The Variables list shows every name.`
        : `${RC_HINTS[111]}${record.macro ? ` If a macro held text meant as a value, put quotes around it, as "${record.macro}".` : ""}`,
    help,
    suggest: close,
    // reshape's i() and j() depend on how the data stand, as the near
    // name does not show: reshape wide x, i(t) j(w1) fails r(9) where
    // j(w) was not found. Its names are suggested, not offered to run.
    fix:
      close.length && command !== "reshape"
        ? swap(record.command, typed, close[0])
        : "",
  };
}

/** What r(110) means, by what took the name. */
function nameTaken(record, message, command, word, help, variableNames) {
  const label = /^label (\S+) already defined/m.exec(message);
  if (label)
    return {
      text: `A value label called ${label[1]} exists already. Add , modify to add to it or change it, or , replace to define it afresh.`,
      help: "label",
      suggest: [],
      fix: /,/.test(record.command)
        ? ""
        : `${record.command.trimEnd()}, replace`,
    };
  const taken = /^variable (\S+) already (?:defined|exists)/m.exec(message);
  if (!taken) return null;
  const it = taken[1];
  if (command === "rename")
    return {
      text: `${it} is the name of a variable already. Give the variable another new name, or drop ${it} first if it is not needed.`,
      help: "rename",
      suggest: [],
    };
  if (command === "merge" && it === "_merge")
    return {
      text: "merge makes a variable called _merge, and one is left from an earlier merge. Drop it first (drop _merge), or name the new one with the generate() option, or leave it out with nogenerate.",
      help: "merge",
      suggest: [],
    };
  if (command === "reshape") {
    // Stata says "Data are already long" whenever j() names a variable
    // that exists. The data are wide still if the stubs' variables, as
    // inc2000 for the stub inc, are there.
    const already = /already (long|wide)/m.exec(message)?.[1],
      stubs =
        /^\s*reshape\s+long\s+([^,]*)/
          .exec(bare(record.command))?.[1]
          .trim()
          .split(/\s+/)
          .filter(Boolean) ?? [],
      wide = stubs.flatMap((stub) => {
        const [before, after = ""] = stub.split("@");
        return variableNames.filter(
          (name) =>
            name.length > before.length + after.length &&
            name.startsWith(before) &&
            name.endsWith(after),
        );
      });
    return {
      text:
        already === "long" && wide.length
          ? `${it} is a variable already, and reshape long makes the variable that j() names. The data are still wide (${both(wide.slice(0, 3))}${wide.length > 3 ? " and others" : ""} are there), whatever Stata's message says: name another variable in j(), or drop or rename ${it} first.`
          : already
            ? `The data are already ${already}: the reshape has been done. reshape alone shows how the data stand.`
            : `${it} is a variable already, and reshape makes the variable that j() names. Name another in j(), or drop or rename ${it} first.`,
      help: "reshape",
      suggest: [],
    };
  }
  if (GENERATE.test(word))
    return {
      text: `${it} already exists. To change it, write replace ${it} = …; to start again, drop ${it} first.`,
      help: "replace",
      suggest: ["replace"],
    };
  return {
    text: `${it} already exists. Choose another name for the new variable, or drop ${it} first.`,
    help,
    suggest: [],
  };
}

function advise(record, context) {
  const {
    commands = [],
    variables = [],
    labels = {},
    files = [],
    observations,
  } = context;
  const rc = record.rc,
    message = record.lines.join("\n"),
    { word, rest } = commandParts(record.command),
    command = resolveCommand(word, commands),
    help = command || "",
    name = command || word || "That command",
    names = [...new Set(commands.map((c) => c.name))],
    variableNames = variables.map((v) => v.name);
  // A real Stata command or function the browser lacks: no typo to hunt.
  const lacking =
    /^(\S+) is a Stata command that the browser does not run yet/m.exec(
      message,
    ) ??
    /^(\S+)\(\) is a Stata function that is not available in the browser yet/m.exec(
      message,
    );
  if (lacking)
    return {
      text: `${lacking[1]} is part of Stata but not of this browser version yet.${record.hint ? ` ${record.hint}` : " The Commands list shows what runs here."}`,
      help: "",
      suggest: [],
    };
  // A part of Stata that the runtime says it does not run: never a typo.
  // Stata's own "estat heterogeneity is not available after command
  // mixed" is not one: it is advised on with estat's r(321) below.
  // A typo for one of Stata's subcommands or kernels is not one, though
  // the runtime words it as a refusal.
  const typo = ownTypo(record, message, name);
  if (typo) return typo;
  if (REFUSAL.test(message) && !STATA_OWN.test(message))
    return refused(record, message, help);
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
    // sdtesti, the immediate form of sdtest: it takes numbers, not
    // variables, so sdtest with its numbers is no fix. Stata's immediate
    // commands are these; counti is a typo.
    const stem = IMMEDIATE[typed];
    if (stem)
      return {
        text: `${typed} is the immediate form of ${stem}, which takes the summary numbers typed on the line. It does not run in this browser version yet;${names.includes(stem) ? ` ${stem} does the same from variables in memory.` : ` nor does ${stem}.`}`,
        help: names.includes(stem) ? stem : "",
        suggest: names.includes(stem) ? [stem] : [],
      };
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
  // The cap on a run that is not in the background worker, where Stop
  // could not end it.
  if (/than the browser allows$/m.test(message))
    return {
      text: "This browser is running the do-file on the page itself, not in the background, so a run is stopped after 200,000 commands to keep the page from freezing. Run the loop in shorter parts; where the page runs in the background, a long loop runs to its end and Stop ends it.",
      help: "forvalues",
      suggest: [],
    };
  // A time-series command or operator before the data are declared.
  if (rc === 111 && /^(time|panel) variable not set/m.test(message)) {
    const panel = /^panel/m.test(message);
    return {
      text: panel
        ? "The data have not been declared a panel. Declare them first with xtset, naming the panel and the time variable: xtset id year."
        : "The data have no time variable yet. Declare it first with tsset, naming the variable that counts the periods: tsset year (or xtset id year for panel data).",
      help: panel ? "xtset" : "tsset",
      suggest: [panel ? "xtset" : "tsset"],
    };
  }
  // An option written before its comma, as in margins dydx(x) or egen m =
  // mean(x) by(g): what follows the command is read as variables.
  const early = earlyOption(record.command, word);
  if (early && [101, 111, 132, 198].includes(rc))
    return {
      text: `${early.option}() is an option of ${name}, and options come after a comma: ${early.fix}.`,
      help,
      suggest: [],
      fix: early.fix,
    };
  // A loop's commands written on the line of its {.
  if (/^(foreach|forv\w*|while)\b[^{]*\{\s*\S/.test(record.command))
    return {
      text: "A loop's { ends its line: put each command of the loop on a line of its own, and the closing } on a line of its own.",
      help: /^foreach/.test(record.command)
        ? "foreach"
        : /^while/.test(record.command)
          ? "while"
          : "forvalues",
      suggest: [],
    };
  // A } that closes nothing, and a block that is never closed: a program
  // is closed by end, a loop or an if by }.
  if (record.command.trim() === "}")
    return {
      text: "This } closes no loop or block that is open. Take it out, or open the block first with foreach, forvalues, while or program.",
      help: "foreach",
      suggest: [],
    };
  if (
    rc === 612 ||
    /^(\{ without a matching \}|unexpected end of file|program \S+ has no end)/m.test(
      message,
    )
  ) {
    // input is not among the commands the hints are given (the session
    // runs it), so the word typed is read: inp, inpu or input.
    if (/^inp(?:ut?)?$/.test(word))
      return {
        // Lines of values were read, as   1. 1 2, before the end of file.
        text: record.lines.some((line) => /^\s+\d+\.\s+\S/.test(line))
          ? "input reads the values on the lines after it, up to a line that says end, and these values have none after them. Put end on a line of its own after the last line of values."
          : "input reads the values on the lines after it, up to a line that says end. Write input, its values and end in the do-file, then run the do-file.",
        help: "input",
        suggest: [],
      };
    const program =
      /^program /m.test(message) ||
      (/^pr(o(g(r(am?)?)?)?)?\s/.test(bare(record.command)) &&
        !/^pr\w*\s+(drop|dir|list)\b/.test(bare(record.command)));
    return {
      text: program
        ? "The program is never ended: put end on a line of its own after its last command."
        : "The block opened with { is never closed: put } on a line of its own after its last command.",
      help: program ? "program" : "foreach",
      suggest: [],
    };
  }
  // Names that are not variables: a program, a matrix, a coefficient.
  if (rc === 111) {
    const thing = /^(program|matrix) (\S+) not found$/m.exec(message);
    if (thing)
      return {
        text:
          thing[1] === "program"
            ? `No program called ${thing[2]} is defined in this session. program dir lists those that are.`
            : `No matrix called ${thing[2]} exists in this session. matrix dir lists those that do.`,
        help: thing[1],
        suggest: [],
      };
    if (/^_(b|se) not allowed when e\((b|V)\) is not present/m.test(message))
      return {
        text: "_b[] and _se[] read the results of the last model, and there are none: fit a model first, as with regress y x.",
        help: "regress",
        suggest: [],
      };
    const coefficient = /^\[(\S+)\] not found$/m.exec(message);
    if (coefficient)
      return {
        text: `The last model has no coefficient called ${coefficient[1]}. Its coefficients are named as the table of results names them, as _b[x] or _b[1.group]; matrix list e(b) shows them all.`,
        help: "matrix",
        suggest: [],
      };
    if (/^no such variables;/m.test(message))
      return {
        text: `None of those variables is in the last model${record.model ? ` (${record.model.command})` : ""}, and ${name} tests only its coefficients. Name variables the model includes.`,
        help,
        suggest: [],
      };
  }
  // A name that is not in memory. Stata says "variable x not found" in a
  // varlist and "x not found" in an expression.
  const missing = /^(?:variable |regressor )?([A-Za-z_]\w*) not found$/m.exec(
    message,
  );
  if (
    rc === 111 &&
    !variables.length &&
    (missing || /^no variables defined/m.test(message))
  )
    return {
      text: "There is no data in memory. Load a dataset first, with use, sysuse or import delimited.",
      help: "use",
      suggest: [],
    };
  if (rc === 111 && missing)
    return notFound(record, missing[1], {
      message,
      command,
      name,
      help,
      variables,
      variableNames,
      labels,
    });
  const ambiguous = /^(\S+) ambiguous abbreviation$/m.exec(message);
  if (rc === 111 && ambiguous) {
    const starting = variableNames.filter((name) =>
      name.startsWith(ambiguous[1]),
    );
    return {
      text: `More than one variable begins with ${ambiguous[1]}${starting.length ? `: ${both(starting.slice(0, 4))}${starting.length > 4 ? " and others" : ""}` : ""}. Write more of the name.`,
      help,
      suggest: [],
    };
  }
  // if x = 1 in place of if x == 1. Stata says =exp not allowed, or type
  // mismatch when a string follows the =, or invalid syntax. A word
  // compared with a string variable goes in quotes as well.
  const single = [101, 109, 198].includes(rc) ? loneIf(record.command) : -1;
  if (single >= 0) {
    const before = record.command.slice(0, single),
      after = record.command.slice(single + 1).trimStart(),
      left = /([A-Za-z_]\w*)\s*$/.exec(before)?.[1],
      right = /^([A-Za-z_]\w*)(?![\w(.:"])/.exec(after)?.[1],
      leftVariable = abbreviated(left, variables),
      rightVariable = abbreviated(right, variables),
      kind = (variable) =>
        variable ? (/^str/.test(variable.type ?? "") ? "text" : "number") : "",
      textual = kind(leftVariable) === "text",
      number = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?![\w.])/i.exec(
        after,
      )?.[0],
      // A word that is no variable: text to quote, or a value label's.
      word = right && !rightVariable ? right : "",
      labelled = !textual && word ? leftVariable?.valueLabel : "",
      code = labelled
        ? (labels[labelled]?.values ?? []).find(
            ([, text]) => text === word,
          )?.[0]
        : undefined,
      // city = region or city = 5, text and a number: == does not mend
      // that, nor a word that is no variable compared with a number.
      clash =
        (kind(leftVariable) &&
          kind(rightVariable) &&
          kind(leftVariable) !== kind(rightVariable)) ||
        (textual && number !== undefined) ||
        (word && !textual && code === undefined),
      shown = record.strings?.[leftVariable?.name]?.words?.[0];
    let more = "";
    if (textual && word)
      more = ` ${left} holds text, so the value goes in quotes too: ${left} == "${word}".`;
    else if (textual && number !== undefined)
      more = ` ${left} holds text, so it is compared with text in quotes, as ${left} == "${shown ?? number}", not with a number.`;
    else if (code !== undefined)
      more = ` ${word} is the label of ${leftVariable.name}'s value ${code}, and a comparison takes the number: ${left} == ${code}.`;
    else if (labelled)
      more = ` ${word} is not a variable, and ${leftVariable.name} is numeric: compare it with one of its numbers; label list ${labelled} shows each label's number.`;
    else if (word && kind(leftVariable) === "number")
      more = ` ${word} is not a variable, and ${left} is compared with a number or another variable.`;
    // The example is the student's own comparison, written as it runs.
    const value = number ?? right,
      example = !left
        ? "group == 1"
        : textual && (number !== undefined || (word && !rightVariable))
          ? `${left} == "${number !== undefined ? (shown ?? number) : word}"`
          : code !== undefined
            ? `${left} == ${code}`
            : value !== undefined && !clash
              ? `${left} == ${value}`
              : "group == 1";
    return {
      text: `A single = assigns. To compare two values, write ==, as in ${example}.${more}`,
      help,
      fix: clash
        ? ""
        : `${before.trimEnd()} == ${
            textual && word
              ? `"${word}"${after.slice(word.length)}`
              : code !== undefined
                ? `${code}${after.slice(word.length)}`
                : after
          }`,
      suggest: [],
    };
  }
  // logit, probit and the like with an outcome that is not 0 and 1.
  if (rc === 2000 && /^outcome does not vary/m.test(message)) {
    const outcome = namedVariables(
      rest.split(/\bif\b|\bin\b|,/)[0],
      variables,
    )[0];
    return {
      text: `${name} needs an outcome that is 0 for some observations and not 0 for others; it counts every value other than 0 as 1${outcome ? `, so ${outcome} is the same outcome in every observation used` : ""}. Use a variable that is 0 or 1, made for instance with generate high = ${outcome ?? "y"} > c if !missing(${outcome ?? "y"}), for a cutoff c.`,
      help: help || "logit",
      suggest: [],
    };
  }
  // A string variable where a number is needed: usually a CSV column that
  // has text in it, such as NA, or numbers written with commas. regress,
  // logit and most models count a string variable as missing, and so
  // find "no observations", r(2000); poisson, glm and others refuse it in
  // their varlist, and an expression says "type mismatch", r(109).
  if (
    (rc === 109 &&
      /string variables? (may not|not allowed)|type mismatch/.test(message)) ||
    (rc === 2000 && /^no observations$/m.test(message))
  ) {
    // An empty sample has other causes, such as an if that matches
    // nothing, so only the variables of the model are looked at.
    const strings = namedVariables(
      rc === 2000 ? rest.split(/\bif\b|\bin\b/)[0] : rest,
      variables,
    ).filter((name) =>
      /^str/.test(variables.find((v) => v.name === name)?.type ?? ""),
    );
    if (strings.length)
      return stringAdvice(strings, record.strings ?? {}, record.command);
  }
  // The runtime's own hint, written where the error is raised, comes
  // before the general ones below.
  if (record.hint) return { text: record.hint, help, suggest: [] };
  if (rc === 101)
    return {
      text: notTaken(name, message, record.command),
      help,
      suggest: [],
    };
  if (rc === 100)
    return {
      text: required(name, message),
      help,
      suggest: [],
      fix: /^\) required/m.test(message) ? closing(record.command) : "",
    };
  // A misspelt option: the nearest of the options this command takes, as
  // the runtime lists them; none is guessed for a command that does not.
  const option = /^option (\S+?)(?:\(\))? not allowed$/m.exec(message);
  if (rc === 198 && option) {
    const close = record.allowed?.length
      ? nearest(option[1], record.allowed, 1)
      : [];
    return {
      text: close.length
        ? `${name} has no option ${option[1]}. Did you mean ${close[0]}?`
        : `${name} here takes no option ${option[1]}. Check its spelling; if Stata's help for ${name} lists it, this browser version does not have it yet.`,
      help,
      suggest: close,
      fix: close.length ? swap(record.command, option[1], close[0]) : "",
    };
  }
  // vce(robsut): the types of standard error, as option names are.
  const vcetype = /^vcetype (\S+) not allowed$/m.exec(message);
  if (rc === 198 && vcetype) {
    const close = nearest(
      vcetype[1],
      ["robust", "cluster", "bootstrap", "jackknife", "ols", "hc2", "hc3"],
      1,
    ).filter((each) => distance(each, vcetype[1].toLowerCase()) <= 2);
    return {
      text: close.length
        ? `${name} has no vce(${vcetype[1]}). Did you mean vce(${close[0]}${close[0] === "cluster" ? " clustvar" : ""})?`
        : `vce() names a type of standard error, as vce(robust) or vce(cluster clustvar); help ${name} lists those ${name} takes.`,
      help,
      suggest: [],
      fix:
        close.length && close[0] !== "cluster"
          ? swap(record.command, vcetype[1], close[0])
          : "",
    };
  }
  if (rc === 198 && /^observation numbers out of range/m.test(message))
    return {
      text: `in asks for observations that are not there${typeof observations === "number" ? `: there ${observations === 1 ? "is 1 observation" : `are ${observations} observations`}` : ""}. Keep the range within the data; l stands for the last observation, as in in 1/l.`,
      help: "in",
      suggest: [],
    };
  // 1x or _n as the name of a new variable. A local's name may begin with
  // a digit, so a local is not told so.
  const badName = /^(\S+) invalid (?:var)?name$/m.exec(message);
  if (
    rc === 198 &&
    badName &&
    !/^(local|global|tempvar|tempname|tempfile|scalar|matrix)$/.test(command)
  )
    return {
      text: `${badName[1]} cannot be a variable name. A name begins with a letter or _, has only letters, digits and _, at most 32 of them, and is not one that Stata keeps for itself, such as _n, _N, in, if or using.`,
      help: "generate",
      suggest: [],
    };
  // if x > 1 and x < 3: Stata's and is &, its or |.
  const logical = /^invalid '(and|or)'/m.exec(message);
  if (rc === 198 && logical) {
    const symbol = logical[1] === "and" ? "&" : "|";
    return {
      text: `Stata writes ${logical[1]} as ${symbol}, as in if x > 1 ${symbol} x < 3.`,
      help: "operators",
      suggest: [],
      fix: /"/.test(record.command)
        ? ""
        : record.command.replace(
            new RegExp(`\\s+${logical[1]}\\s+`, "g"),
            ` ${symbol} `,
          ),
    };
  }
  if (
    rc === 198 &&
    /^force option required with duplicates drop/m.test(message)
  )
    return {
      text: "duplicates drop with variables named drops observations that agree on those variables even where others differ, so Stata asks for force to show that is meant. duplicates report and duplicates list show what would go; add , force only if that is what you want.",
      help: "duplicates",
      suggest: [],
    };
  if (rc === 110) {
    const taken = nameTaken(
      record,
      message,
      command,
      word,
      help,
      variableNames,
    );
    if (taken) return taken;
  }
  if (rc === 4)
    return {
      text: "The data in memory have changed and would be lost. Add , clear to the command if that is what you want.",
      help,
      suggest: [],
    };
  if (rc === 601 && command === "sysuse")
    return {
      text: "Stata's own example datasets, such as auto, belong to StataCorp and are not here. sysuse dir lists this site's datasets.",
      help: "sysuse",
      suggest: [],
    };
  // graph export with no graph drawn: no file is missing.
  if (rc === 601 && /^no Graph window open/m.test(message))
    return {
      text: "graph export saves the graph drawn last, and none has been drawn in this session. Draw it first, as with scatter y x or histogram x, then export it.",
      help,
      suggest: [],
    };
  // import excel's sheet(): the file is there, the sheet is not.
  const sheet = /^worksheet (.+) not found$/m.exec(message);
  if (rc === 601 && sheet) {
    const book = /\busing\s+("[^"]+"|[^\s,]+)/.exec(record.command)?.[1];
    return {
      text: `The workbook has no worksheet called ${sheet[1]}. sheet() names a sheet as the workbook writes it, capitals and spaces included; import excel using ${book ?? "filename"}, describe lists its sheets.`,
      help,
      suggest: [],
    };
  }
  if (rc === 601) {
    const file = absentFile(record, files, command);
    if (file) return file;
  }
  if (rc === 602 && /^file .* already exists/m.test(message))
    return {
      text: `A file of that name exists already, and ${name} does not write over a file unless told to. Add replace to its options to write over it, or give another name.`,
      help,
      suggest: [],
      fix: /^(save|saveold)$/.test(command)
        ? /,/.test(record.command)
          ? `${record.command.trimEnd()} replace`
          : `${record.command.trimEnd()}, replace`
        : "",
    };
  // reshape's own r(9): i() does not name one row per unit, or a variable
  // outside the stubs changes within it.
  if (rc === 9 && command === "reshape") {
    const varying = [
      ...message.matchAll(/^variable (\S+) not constant within (\S+)/gm),
    ];
    if (varying.length) {
      const list = varying.map((m) => m[1]),
        within = varying[0][2],
        stubs = /^(\s*reshape\s+wide\s+)([^,]*?)(\s*,)/.exec(record.command);
      return {
        text: `${both(list)} ${plural(list, "changes", "change")} within ${within}, and a variable outside the list of stubs must have one value for each ${within}. If ${plural(list, "it changes", "they change")} with j(), add ${plural(list, "it", "them")} to the stubs; if not, reshape error lists the observations to correct, or drop ${plural(list, "it", "them")}.`,
        help,
        suggest: [],
        fix: stubs
          ? record.command.replace(
              stubs[0],
              `${stubs[1]}${stubs[2]} ${list.join(" ")}${stubs[3]}`,
            )
          : "",
      };
    }
    if (/not unique within|uniquely identify/m.test(message))
      return {
        text: "i() must name variables that take a different value in each observation of the data as they are now (one row per unit in wide data). duplicates report lists the repeated values; reshape error lists the problem observations.",
        help,
        suggest: [],
      };
    return null;
  }
  // r(119) is Stata's code for a command out of its context: continue or
  // break outside a loop, st commands before stset, svy before svyset.
  if (rc === 119 && /^statement out of context/m.test(message))
    return {
      text: "continue and break belong inside a loop: foreach, forvalues or while. Outside one there is nothing to continue.",
      help: "continue",
      suggest: [],
    };
  if (rc === 119 && /^data not st/m.test(message))
    return {
      text: "Declare the survival data first with stset, as stset time, failure(died); the st commands read that declaration.",
      help: "stset",
      suggest: [],
    };
  if (rc === 119 && /^data not set up for svy/m.test(message))
    return {
      text: "Declare the survey design first with svyset, as svyset psu [pweight=w], strata(stratum).",
      help: "svyset",
      suggest: [],
    };
  // A function: one of egen's in generate, or one that does not run.
  const fn = /^unknown function (\S+?)\(\)$/m.exec(message);
  if (rc === 133 && fn) {
    if (EGEN_ONLY.test(fn[1])) {
      // egen takes the function alone after =: egen m = mean(x), perhaps
      // with if, in or options. In an expression, the egen variable is
      // made first and the expression uses it.
      const call = new RegExp(`\\b${fn[1]}\\(\\s*([^()]*?)\\s*\\)`).exec(
          record.command,
        ),
        alone = new RegExp(
          `=\\s*${fn[1]}\\([^()]*\\)\\s*(?:$|if\\b|in\\b|,)`,
        ).test(record.command),
        argument = /^[A-Za-z_]\w*$/.test(call?.[1] ?? "") ? call[1] : "",
        made = `${fn[1]}_${argument || "x"}`,
        by = /^\s*((?:by|bys\w*)\s[^:]*:\s*)/.exec(record.command)?.[1] ?? "";
      return {
        text: alone
          ? `${fn[1]}() is a function of egen, not of generate: egen makes a variable of ${fn[1]}() over the observations, as egen m = ${fn[1]}(x).`
          : `${fn[1]}() is a function of egen, not of generate, and egen takes the function alone after =. Make it a variable first, as ${by}egen ${made} = ${fn[1]}(${argument || "x"}), then use ${made} in the expression.`,
        help: "egen",
        suggest: ["egen"],
        fix:
          alone && GENERATE.test(word)
            ? swap(record.command, word, "egen")
            : "",
      };
    }
    return {
      text: `No function called ${fn[1]}() runs here. Check its spelling; if it is one of Stata's functions (help functions lists them), this browser version does not have it yet.`,
      help: "functions",
      suggest: [],
    };
  }
  if (rc === 132 && /^too many '\)' or/m.test(message))
    return {
      text: "There is a ) or ] with nothing open to close. Take out the extra one.",
      help,
      suggest: [],
    };
  if (rc === 132 && /^too few '\)' or/m.test(message))
    return {
      text: "A ( or [ is opened and never closed. Add the ) or ] that closes it.",
      help,
      suggest: [],
    };
  // estat bogus: not one of the estat commands for the last model.
  const estat =
    /^estat (\S+) (?:not valid|is not available after command (\S+))$/m.exec(
      message,
    );
  if (estat) {
    const fitted = estat[2] ?? record.model?.command;
    return {
      text: `estat ${estat[1]} does not run after the last model${fitted ? ` (${fitted})` : ""}${estat[2] ? "" : " here"}. Stata's help for ${fitted ?? "the estimation command"} postestimation lists the estat commands that go with it.`,
      help: "estat",
      suggest: [],
    };
  }
  // Return codes students often meet, by what their message says.
  if (
    rc === 452 &&
    /factor variables may not contain negative values/m.test(message)
  ) {
    const it = /^(\S+):\s/m.exec(message)?.[1];
    return {
      text: `A factor variable's categories are numbered from 0 up, and ${it ?? "this variable"} has negative values. Make a copy that starts at 0, as generate ${it ?? "x"}2 = ${it ?? "x"} - (its minimum), or recode its negative codes.`,
      help: "recode",
      suggest: [],
    };
  }
  if (rc === 451 && /^repeated time values/m.test(message)) {
    const named = namedVariables(rest.split(",")[0], variables);
    return {
      text: `Two observations of one ${/panel/.test(message) ? "panel" : "series"} have the same time. duplicates report ${named.join(" ") || "panelvar timevar"} counts the repeats: check that the right variables are named, then correct or drop the repeats.`,
      help: "duplicates",
      suggest: [],
    };
  }
  if (rc === 459) {
    const keys =
      /^variables? (.+?) do(?:es)? not uniquely identify (?:the )?observations(?: in the (master|using) data)?/m.exec(
        message,
      );
    if (keys?.[2]) {
      // The match typed, and the one that would take the repeats: m:1
      // for repeats in the master data, 1:m for repeats in the using.
      const [, key, side] = keys,
        typed = /\bmerge\s+([1m]:[1m])/.exec(record.command)?.[1] ?? "1:1",
        other = side === "master" ? "using" : "master",
        where =
          side === "master"
            ? "the data in memory (the master)"
            : "the using data",
        fits = side === "master" ? "m:1" : "1:m",
        joinby = `joinby ${key} using ${/\busing\s+("[^"]+"|[^\s,]+)/.exec(record.command)?.[1] ?? "filename"}`;
      return {
        text:
          typed === "1:1"
            ? `${key} repeats in ${where}, so a 1:1 match is not possible. If the ${other} data have one observation for each ${key}, the match is ${fits}; if ${key} repeats in both, merge cannot pair them, and ${joinby} forms every pair. duplicates report ${key} counts the repeats.`
            : `${typed} needs one observation for each ${key} in ${where}, and ${key} repeats there. If the ${other} data have one observation for each ${key}, the match is ${fits}; if ${key} repeats in both, merge cannot pair them, and ${joinby} forms every pair. duplicates report ${key} counts the repeats.`,
        help: "merge",
        suggest: [],
      };
    }
    if (keys)
      return {
        text: `Some values of ${keys[1]} repeat. duplicates report ${keys[1]} counts them, and duplicates list ${keys[1]} shows them.`,
        help: "duplicates",
        suggest: [],
      };
    if (/^must specify panelvar/m.test(message))
      return {
        text: "Declare the panel first with xtset, naming the panel and the time variable, as xtset id year.",
        help: "xtset",
        suggest: ["xtset"],
      };
  }
  if (
    rc === 107 &&
    command === "encode" &&
    /^not possible with numeric/m.test(message)
  ) {
    const it = namedVariables(rest.split(",")[0], variables)[0] ?? "it";
    return {
      text: `encode makes a numbered copy of a string variable, and ${it} is numeric already, so it needs no encoding. label values attaches value labels to a numeric variable.`,
      help: "encode",
      suggest: [],
    };
  }
  if (rc === 106 && /\bin (?:master|one dataset)\b/m.test(message)) {
    const it = /^(?:key )?variable (\S+) is/m.exec(message)?.[1] ?? "it";
    return {
      text: `${it === "it" ? "A variable" : it} is a number in one dataset and text in the other. Make it the same in both first: destring ${it}, replace in the dataset where it is text, or tostring ${it}, replace in the other.`,
      help: "destring",
      suggest: [],
    };
  }
  // The general hints apply only to the messages they describe: 601 to a
  // missing file, 9 to a false assert, 111 to a variable, 321 to no model,
  // 133 to a function and 198 to a line Stata could not read. Any other
  // message under those codes gets no hint, rather than one that sends the
  // student looking for the wrong thing.
  if (rc === 601 && !/^(file|worksheet) .* not found/m.test(message))
    return null;
  if (rc === 9 && !/^assertion is false/m.test(message)) return null;
  if (rc === 111 && !/\bvariables?\b/.test(message)) return null;
  if (
    rc === 321 &&
    !/^(last estimates not found|no estimation results)/m.test(message)
  )
    return null;
  if (
    rc === 198 &&
    !/^(invalid syntax|.* found where .* expected|unmatched quote|invalid '.*'|unexpected .*)\s*$/m.test(
      message,
    )
  )
    return null;
  const general = RC_HINTS[rc];
  return general ? { text: general, help, suggest: [] } : null;
}

/**
 * A note under a command that ran, or null: missing values generated
 * where no if or . asked for them, and a > or >= that also counted
 * missing values (record.overMissing, from the session).
 */
function note(record) {
  if (!record.lines?.length && !record.overMissing) return null;
  const made = /^\(([\d,]+) missing values? generated\)$/m.exec(
      record.lines.join("\n"),
    ),
    { word } = commandParts(record.command),
    line = bare(record.command);
  if (
    made &&
    (GENERATE.test(word) || word === "replace") &&
    !/\b(if|in)\b/.test(line) &&
    !/=\s*\.[a-z]?\s*$/.test(line)
  ) {
    const target = /^\w+\s+(?:[a-z]+\d*\s+)?([A-Za-z_]\w*)\s*=/.exec(line)?.[1];
    return {
      text: `${made[1]} ${made[1] === "1" ? "observation was" : "observations were"} given a missing value (.): that happens where an input is missing, or where the result has no value, as for a division by 0 or the log of 0 or of a negative number.${target ? ` count if missing(${target}) counts them.` : ""}`,
      help: "missing",
      suggest: [],
    };
  }
  const over = record.overMissing;
  if (over) {
    const them = over.count === 1 ? "it" : "them";
    return {
      text: `${over.name} has ${over.count} missing ${over.count === 1 ? "value" : "values"}, and Stata takes a missing value to be larger than any number, so ${over.condition} is true of ${them} too. Add & !missing(${over.name}) to the condition to leave ${them} out.`,
      help: "missing",
      suggest: [],
    };
  }
  return null;
}
