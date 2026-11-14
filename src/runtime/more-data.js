// do, run and include on do-files held in the session, and the commands
// that combine or rearrange datasets: cross, joinby and stack.
import { greatest } from "./extremes.js";
import { Signal, StataError } from "./errors.js";
import { fileName, load, strLKey } from "./data-commands.js";
import { INSPECT_COMMANDS } from "./data-inspect.js";
import { parseBlocks, splitCommands } from "./dofile.js";
import { findFile } from "./files.js";
import { MISSING, isStringType } from "./values.js";

const RANK = ["byte", "int", "long", "float", "double"];
const empty = (variable) => (isStringType(variable.type) ? "" : MISSING);
/** Replaces every variable's values by those at the listed rows. */
function arrange(data, variables, index) {
  for (const v of variables)
    v.data = isStringType(v.type)
      ? index.map((i) => (i === null ? "" : v.data[i]))
      : Float64Array.from(index, (i) => (i === null ? MISSING : v.data[i]));
}
/** Copies a variable of another dataset in, with values at the rows given. */
function bring(data, source, index) {
  const text = isStringType(source.type);
  data.generate(
    source.name,
    index.map((i) => (i === null ? empty(source) : source.data[i])),
    { type: source.type, string: text },
  );
  Object.assign(data.get(source.name), {
    format: source.format,
    label: source.label,
    valueLabel: source.valueLabel,
  });
}

function doFile(mode) {
  return (session, text, ctx) => {
    const m = /^\s*("[^"]*"|\S+)\s*([\s\S]*)$/.exec(text);
    if (!m) throw new StataError("invalid syntax", 198);
    const typed = m[1].replace(/^"|"$/g, ""),
      files = session.files ?? new Map(),
      name = findFile(files, typed)
        ? typed
        : /\.\w+$/.test(typed)
          ? typed
          : `${typed}.do`,
      stored = files.get(findFile(files, name));
    if (!stored) throw new StataError(`file ${name} not found`, 601);
    if (typeof stored.text !== "string")
      throw new StataError(`${name} is a dataset, not a do-file`, 610);
    session.doDepth = (session.doDepth ?? 0) + 1;
    if (session.doDepth > 64) {
      session.doDepth = 0;
      throw new StataError("do-files nested too deep", 197);
    }
    // include runs in the caller's frame, so its local macros stay; do
    // and run get their own, with any arguments as `1', `2' and so on.
    const frame = mode === "include" ? ctx.frame : session.frame();
    if (mode !== "include") {
      const words = m[2].match(/"[^"]*"|\S+/g) ?? [];
      words.forEach((word, k) =>
        frame.locals.set(String(k + 1), word.replace(/^"|"$/g, "")),
      );
      frame.locals.set("0", m[2].trim());
    }
    // run shows nothing, and neither does do under quietly or capture.
    const silent =
        mode === "run" ||
        ctx.flags?.quiet ||
        (ctx.flags?.capture && !ctx.flags?.noisy),
      output = silent ? [] : ctx.output,
      // Shown as Stata's log shows it (the Console): the do command first,
      // then the file's commands, then "end of do-file".
      leads = session.foldLoops && !silent && !!ctx.flags,
      start = output.length,
      { sourceLines, loopDepth } = session;
    session.sourceLines = stored.text.replace(/\r\n?/g, "\n").split("\n");
    session.loopDepth = 0;
    let failure = null,
      exited = false;
    try {
      session.runNodes(parseBlocks(splitCommands(stored.text)), frame, output);
    } catch (error) {
      // exit ends this do-file and returns to the one that ran it.
      if (error instanceof Signal && error.kind === "exit") {
        exited = true;
        if (error.code) failure = new StataError("", error.code);
      } else failure = error;
    } finally {
      session.doDepth -= 1;
      session.sourceLines = sourceLines;
      session.loopDepth = loopDepth;
    }
    if (leads) {
      ctx.flags.leadAt = start;
      const last = output.length > start ? output.at(-1) : null;
      if (failure instanceof StataError) {
        if (last && !failure.recorded) {
          if (failure.message) last.lines.push(failure.message);
          last.lines.push(`r(${failure.code});`);
          last.rc = failure.code;
        }
        if (last) failure.recorded = true;
        if (last && mode === "do")
          last.lines.push("", "end of do-file", `r(${failure.code});`);
      } else if (!failure && mode === "do") {
        if (exited && last) last.lines.push("", "end of do-file");
        else
          output.push({
            command: "",
            lines: ["end of do-file"],
            rc: 0,
            line: session.line,
          });
      }
    }
    if (failure) throw failure;
  };
}

function cross(session, text) {
  const parsed = session.parse("using/", text),
    other = load(session, fileName(parsed.using)),
    data = session.data,
    n = data.n,
    m = other.n;
  if (!n || !m) throw new StataError("no observations", 2000);
  // Each observation first meets the first using observation; its
  // pairings with the rest follow, observation by observation.
  const master = Array.from({ length: n }, (_, i) => i),
    using = master.map(() => 0);
  for (let i = 0; i < n; i++)
    for (let j = 1; j < m; j++) {
      master.push(i);
      using.push(j);
    }
  arrange(data, data.variables, master);
  data.n = master.length;
  data.sortedBy = [];
  for (const variable of other.variables)
    if (!data.has(variable.name)) bring(data, variable, using);
}

function joinby(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] using/ [, UNMatched(string) _merge(name) | UPDATE REPLACE noLabel]",
      text,
    ),
    // varlist(default=none): no names before using means the common ones.
    named = !/^\s*using\b/.test(text),
    data = session.data,
    typed = (parsed.options.unmatched ?? "").trim(),
    unmatched = typed
      ? ["both", "master", "using", "none"].find((word) =>
          word.startsWith(typed.toLowerCase()),
        )
      : "none";
  if (!unmatched)
    throw new StataError(`${typed} is invalid value for unmatch()`, 198);
  let keys = parsed.varlist;
  const other = load(session, fileName(parsed.using));
  if (!named) {
    keys = data.names.filter((name) => other.has(name));
    if (!keys.length)
      throw new StataError(
        "no variables in common to master and using data\nthus a join is not possible",
        198,
      );
    ctx.out(`join on common variables: ${keys.join(" ")}`);
  }
  for (const key of keys)
    if (!other.has(key)) throw new StataError(`variable ${key} not found`, 111);
  // A key may be str# but not strL, as in merge.
  for (const key of keys) {
    const mine = data.get(key).type === "strL",
      theirs = other.get(key).type === "strL";
    if (mine || theirs)
      throw strLKey(
        session,
        key,
        mine && theirs ? "" : mine ? " in master data." : " in using data.",
      );
  }
  // joinby is sortpreserve: the data keep the master's sort order.
  const sorted = [...data.sortedBy];
  const keyOf = (set, i) => JSON.stringify(keys.map((k) => set.get(k).data[i])),
    groups = new Map();
  for (let j = 0; j < other.n; j++) {
    const key = keyOf(other, j);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }
  const master = [],
    using = [],
    merge = [],
    met = new Set();
  // Master observations keep their order; pairings follow each one.
  const order = Array.from({ length: data.n }, (_, i) => i);
  for (const i of order) {
    const found = groups.get(keyOf(data, i));
    if (found) {
      met.add(keyOf(data, i));
      for (const j of found) {
        master.push(i);
        using.push(j);
        merge.push(3);
      }
    } else if (unmatched === "both" || unmatched === "master") {
      master.push(i);
      using.push(null);
      merge.push(1);
    }
  }
  if (unmatched === "both" || unmatched === "using")
    for (const [key, rows] of groups)
      if (!met.has(key))
        for (const j of rows) {
          master.push(null);
          using.push(j);
          merge.push(2);
        }
  const mine = [...data.variables];
  arrange(data, mine, master);
  data.n = master.length;
  // A row that exists only in the using data takes its keys from there.
  for (const key of keys) {
    const here = data.get(key),
      there = other.get(key);
    master.forEach((i, r) => {
      if (i === null) here.data[r] = there.data[using[r]];
    });
  }
  data.sortedBy = sorted;
  if (unmatched !== "none") {
    const name = parsed.options._merge ?? "_merge";
    data.generate(name, merge, { type: "byte" });
    data.valueLabels.set(
      "__MERGE",
      new Map([
        [1, "only in master data"],
        [2, "only in using data"],
        [3, "both in master and using data"],
      ]),
    );
    Object.assign(data.get(name), { valueLabel: "__MERGE", format: "%29.0g" });
  }
  for (const variable of other.variables)
    if (!data.has(variable.name)) bring(data, variable, using);
  unfiled(data);
}
/**
 * joinby and stack build their result in a temporary file, so the data are
 * no longer those of any file: describe names none, and save needs a name.
 */
function unfiled(data) {
  data.filename = "";
  data.filedate = "";
}

function stack(session, text, ctx) {
  const parsed = session.parse(
      "varlist(min=2) [if] [in] , Into(string) [clear Wide]",
      text,
    ),
    data = session.data,
    into = parsed.options.into.trim().split(/\s+/),
    width = into.length;
  if (parsed.varlist.length % width)
    throw new StataError(
      "the variables do not divide evenly among the into() names",
      198,
    );
  if (parsed.options.wide)
    throw new StataError("stack, wide is not available yet", 198);
  const rows = session.rows(parsed, null),
    sets = parsed.varlist.length / width,
    sources = parsed.varlist.map((name) => data.get(name)),
    made = into.map((name, c) => {
      const group = Array.from(
          { length: sets },
          (_, s) => sources[s * width + c],
        ),
        text2 = isStringType(group[0].type);
      if (group.some((v) => isStringType(v.type) !== text2))
        throw new StataError("type mismatch", 109);
      return {
        name,
        text: text2,
        format: group[0].format,
        type: text2
          ? group.reduce(
              (a, v) =>
                Number(v.type.slice(3)) > Number(a.slice(3)) ? v.type : a,
              group[0].type,
            )
          : RANK[greatest(group.map((v) => RANK.indexOf(v.type)))],
        values: group.flatMap((v) => rows.map((i) => v.data[i])),
      };
    });
  if (!parsed.options.clear) {
    ctx.out("Warning: data in memory will be lost.");
    ctx.out("         Press any key to continue, Ctrl-Break to abort.");
  }
  data.variables = [];
  data.n = rows.length * sets;
  data.sortedBy = [];
  data.generate(
    "_stack",
    Array.from({ length: data.n }, (_, r) => Math.floor(r / rows.length) + 1),
    { type: "int" },
  );
  for (const column of made) {
    data.generate(column.name, column.values, {
      type: column.type,
      string: column.text,
    });
    data.get(column.name).format = column.format;
  }
  unfiled(data);
}

export const MORE_DATA_COMMANDS = [
  { name: "do", minimum: 2, run: doFile("do") },
  { name: "run", minimum: 3, run: doFile("run") },
  { name: "include", minimum: 7, run: doFile("include") },
  { name: "cross", minimum: 5, run: cross },
  { name: "joinby", minimum: 6, run: joinby },
  { name: "stack", minimum: 5, run: stack },
  ...INSPECT_COMMANDS,
];
