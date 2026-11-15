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
function stringAdvice(strings, contents) {
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
  if (words.length) {
    const [first] = words,
      example = contents[first].words[0];
    sentences.push(
      `${both(words)} ${plural(words, "holds", "hold")} text, such as ${either(quoted(contents[first].words.slice(0, 2)))}, not numbers. Compare ${plural(words, "it", "them")} with text in quotes, as ${first} == "${example}", or make a numbered copy with encode ${first}, generate(${first}_code).`,
    );
  }
  if (unknown.length)
    sentences.push(
      `${both(unknown)} ${plural(unknown, "is", "are")} stored as text. If ${plural(unknown, "it holds", "they hold")} numbers, destring makes ${plural(unknown, "it", "them")} numeric; help destring shows its ignore() and force options.`,
    );
  return {
    text: sentences.join(" "),
    help: fix || !words.length ? "destring" : "encode",
    suggest: [fix || !words.length ? "destring" : "encode"],
    fix,
  };
}

/** What a command does not take, from "… not allowed", r(101). */
function notTaken(name, message) {
  const what = /^(.+?) not allowed/m.exec(message)?.[1] ?? "";
  if (/factor[- ]variable|time-series|operator/.test(message))
    return "That command does not take factor or time-series notation here. Make the variable with generate first.";
  if (what === "if")
    return `${name} does not take an if condition; it works on every observation. Take out the if part.`;
  if (what === "in range" || what === "in")
    return `${name} does not take in; it works on every observation. Take out the in part.`;
  if (/^[a-z]*weights?$/.test(what))
    return `${name} does not take ${what === "weights" ? "weights" : what}. Take out the part in square brackets.`;
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

/** Whether a record is one line that could be run again by itself. */
const oneLine = (record) =>
  !record.echo?.length && !/[\n{}]/.test(record.command);

/**
 * What to tell a student about a record that failed, or null.
 * `commands` is the runtime's COMMANDS; `variables` the variables in
 * memory as the Console has them ({ name, type }). Returns { text, help,
 * suggest, fix }: help is the command whose help to offer, suggest the
 * names offered in its place, fix a corrected command line. A record of a
 * loop or a block has no fix: the change belongs in the do-file.
 */
export function adviseRecord(record, context = {}) {
  const advice = advise(record, context);
  if (advice?.fix && !oneLine(record)) delete advice.fix;
  return advice;
}

function advise(record, { commands = [], variables = [] }) {
  if (!record?.rc) return null;
  const rc = record.rc,
    message = record.lines.join("\n"),
    { word, rest } = commandParts(record.command),
    command = resolveCommand(word, commands),
    help = command || "",
    name = command || word || "That command",
    names = [...new Set(commands.map((c) => c.name))];
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
      text: `${lacking[1]} is part of Stata but not of this browser version yet. The Commands list shows what runs here.`,
      help: "",
      suggest: [],
    };
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
  // A name that is not in memory. Stata says "variable x not found" in a
  // varlist and "x not found" in an expression.
  if (rc === 111 && !variables.length)
    return {
      text: "There is no data in memory. Load a dataset first, with use, sysuse or import delimited.",
      help: "use",
      suggest: [],
    };
  const missing = /^(?:variable )?([A-Za-z_]\w*) not found$/m.exec(message);
  if (rc === 111 && missing) {
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
  const ambiguous = /^(\S+) ambiguous abbreviation$/m.exec(message);
  if (rc === 111 && ambiguous) {
    const starting = variables
      .map((v) => v.name)
      .filter((name) => name.startsWith(ambiguous[1]));
    return {
      text: `More than one variable begins with ${ambiguous[1]}${starting.length ? `: ${both(starting.slice(0, 4))}${starting.length > 4 ? " and others" : ""}` : ""}. Write more of the name.`,
      help,
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
    if (strings.length) return stringAdvice(strings, record.strings ?? {});
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
  if (rc === 101) return { text: notTaken(name, message), help, suggest: [] };
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
        : `${name} has no option ${option[1]}. Check the spelling and the options ${name} takes in its help.`,
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
