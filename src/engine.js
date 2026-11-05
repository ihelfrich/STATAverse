import { DATASETS, createDataset } from "./datasets.js";
import { StataError, compileExpression } from "./expression.js";
import { commandBlocks } from "./do-file.js";
import { runProgram, runProgramAsync } from "./stata-program.js";
import { dataChanges } from "./data-changes.js";
import { nativeImportOptions } from "./import-library.js";
import { egenColumn, collapseDataset } from "./grouped-data.js";
import {
  RESOURCE_LIMITS,
  estimatedBytes,
  dataResourceError,
} from "./resource-limits.js";
import { missing, summarize, regress, correlation } from "./statistics.js";
export { StataError };
const aliases = {
  sum: "summarize",
  su: "summarize",
  summ: "summarize",
  reg: "regress",
  gen: "generate",
  g: "generate",
  tab: "tabulate",
  hist: "histogram",
  corr: "correlate",
  desc: "describe",
  l: "list",
};
export const SUPPORTED_COMMANDS = Object.freeze([
  "describe",
  "codebook",
  "list",
  "count",
  "summarize",
  "tabulate",
  "correlate",
  "generate",
  "egen",
  "collapse",
  "replace",
  "rename",
  "label",
  "sort",
  "drop",
  "keep",
  "preserve",
  "restore",
  "assert",
  "isid",
  "duplicates",
  "regress",
  "predict",
  "scatter",
  "histogram",
  "import",
  "clear",
  "set",
  "display",
  "help",
  "local",
  "foreach",
  "forvalues",
  "if",
  "else",
  ...Object.keys(aliases),
]);
const clone = (x) => structuredClone(x);
const snapshotSizes = new WeakMap();
const cleanName = (name) =>
  /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name) &&
  ![
    "_n",
    "_N",
    "_all",
    "_cons",
    "__proto__",
    "constructor",
    "prototype",
  ].includes(name);
const truth = (v) => missing(v) || Boolean(v);
function splitTop(source, delimiter) {
  let quote = false,
    depth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') quote = !quote;
    if (quote) continue;
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth === 0 && source.startsWith(delimiter, i))
      return [
        source.slice(0, i).trim(),
        source.slice(i + delimiter.length).trim(),
      ];
  }
  return [source.trim(), ""];
}
export function splitDoFile(source) {
  return commandBlocks(source).map((block) => block.command);
}

function qualify(source, dataset) {
  let main = source,
    condition = "",
    range = "";
  // Keywords are recognized only outside quoted strings and parentheses.
  [main, condition] = splitTop(main, " if ");
  if (condition) [condition, range] = splitTop(condition, " in ");
  else [main, range] = splitTop(main, " in ");
  if (!condition && main.startsWith("if ")) {
    condition = main.slice(3);
    main = "";
    [condition, range] = splitTop(condition, " in ");
  }
  if (!range && main.startsWith("in ")) {
    range = main.slice(3);
    main = "";
  }
  const fn = condition
    ? compileExpression(condition, dataset.columns)
    : () => true;
  if (condition && fn.valueType === "string")
    throw new StataError(
      'The if condition must be numeric, usually a comparison such as group == "A".',
      109,
    );
  let start = 1,
    end = dataset.rows.length;
  if (range) {
    const m = range.match(/^(\d+|f|l)(?:\/(\d+|f|l))?$/);
    if (!m)
      throw new StataError(
        "Use in 1/5 (observation positions); f and l mean first and last.",
      );
    const val = (x) =>
      x === "f" ? 1 : x === "l" ? dataset.rows.length : Number(x);
    start = val(m[1]);
    end = val(m[2] || m[1]);
    if (start < 1 || end < start || end > dataset.rows.length)
      throw new StataError(
        "The in range is outside this dataset.",
        198,
        "Check the observation count and use positions within the data.",
      );
  }
  const selected = dataset.rows
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r, i }) =>
        i + 1 >= start && i + 1 <= end && truth(fn(r, i, dataset.rows.length)),
    );
  return { main, selected, condition, range };
}
function variables(
  source,
  dataset,
  { numeric = false, allowEmpty = false, preserveDuplicates = false } = {},
) {
  const names = source.trim()
    ? source.trim().split(/\s+/)
    : allowEmpty
      ? dataset.columns.map((c) => c.name)
      : [];
  if (!names.length) throw new StataError("Specify a variable name.", 100);
  const expanded = names.flatMap((name) => {
    if (name === "_all" || name === "*")
      return dataset.columns.map((c) => c.name);
    if (name.endsWith("*")) {
      const matches = dataset.columns
        .filter((c) => c.name.startsWith(name.slice(0, -1)))
        .map((c) => c.name);
      if (!matches.length)
        throw new StataError(`No variables match ${name}.`, 111);
      return matches;
    }
    if (name.includes("-")) {
      const [a, b, ...extra] = name.split("-"),
        lo = dataset.columns.findIndex((c) => c.name === a),
        hi = dataset.columns.findIndex((c) => c.name === b);
      if (extra.length || lo < 0 || hi < lo)
        throw new StataError(`Invalid variable range ${name}.`);
      return dataset.columns.slice(lo, hi + 1).map((c) => c.name);
    }
    return [name];
  });
  const unique = [...new Set(expanded)];
  for (const name of unique) {
    const col = dataset.columns.find((c) => c.name === name);
    if (!col)
      throw new StataError(
        `Variable ${name} not found.`,
        111,
        "Check spelling and capitalization in the data browser. Factor variables (i.var), interactions and time-series operators require Stata.",
      );
    if (numeric && col.type !== "numeric")
      throw new StataError(
        `${name} is a string variable; this command requires numbers.`,
        109,
      );
  }
  return preserveDuplicates ? expanded : unique;
}
const noOptions = (options) => {
  if (options)
    throw new StataError(
      `Option ${options} is not supported for this command in browser practice.`,
      198,
      "See Command help for the exact supported syntax, or export your work to Stata.",
    );
};
function newVariable(name, data) {
  if (!cleanName(name))
    throw new StataError(
      "Use a valid Stata variable name: letters, digits and underscores; begin with a letter or underscore; at most 32 characters.",
    );
  if (data.columns.some((c) => c.name === name))
    throw new StataError(
      `Variable ${name} already exists.`,
      110,
      "Choose a new name, use replace, or undo the earlier command.",
    );
}
export class PracticeSession {
  constructor(dataset = "study", customDatasets = {}) {
    this.customDatasets = customDatasets;
    this.load(dataset);
  }
  originalDataset(id) {
    if (Object.hasOwn(DATASETS, id)) return createDataset(id);
    if (Object.hasOwn(this.customDatasets, id))
      return clone(this.customDatasets[id].data);
    throw new StataError(
      "This dataset is not available in the local practice library.",
      601,
    );
  }
  load(dataset) {
    this.data = this.originalDataset(dataset);
    this.model = null;
    this.graph = null;
    this.history = [];
    this.undoStack = [];
    this.last = null;
    this.preservedData = null;
  }
  snapshot() {
    return clone(this.executionState());
  }
  executionState() {
    return {
      data: this.data,
      model: this.model,
      graph: this.graph,
      history: this.history,
      last: this.last,
      preservedData: this.preservedData,
    };
  }
  acceptExecution(state, undo = []) {
    for (const key of Object.keys(this.executionState()))
      this[key] = state[key];
    this.undoStack.push(...undo);
    this.trimUndo();
  }
  trimUndo() {
    const cellCost = (snapshot) =>
      snapshot.data.rows.length * Math.max(1, snapshot.data.columns.length) +
      (snapshot.preservedData
        ? snapshot.preservedData.rows.length *
          Math.max(1, snapshot.preservedData.columns.length)
        : 0);
    const byteCost = (snapshot) => {
      if (!snapshotSizes.has(snapshot))
        snapshotSizes.set(snapshot, estimatedBytes(snapshot));
      return snapshotSizes.get(snapshot);
    };
    let cells = this.undoStack.reduce((sum, state) => sum + cellCost(state), 0);
    let bytes = this.undoStack.reduce((sum, state) => sum + byteCost(state), 0);
    while (
      this.undoStack.length > 1 &&
      (this.undoStack.length > 50 ||
        cells > 750000 ||
        bytes > RESOURCE_LIMITS.undoBytes)
    ) {
      const released = this.undoStack.shift();
      cells -= cellCost(released);
      bytes -= byteCost(released);
    }
  }
  undo() {
    const old = this.undoStack.pop();
    if (!old) return false;
    Object.assign(this, old);
    return true;
  }
  run(source, options) {
    return runProgram(
      source,
      this,
      (text, data) => variables(text, data, { preserveDuplicates: true }),
      options,
    );
  }
  runAsync(source, options) {
    return runProgramAsync(
      source,
      this,
      (text, data) => variables(text, data, { preserveDuplicates: true }),
      options,
    );
  }
  execute(command) {
    if (
      this.history.reduce((sum, text) => sum + text.length, 0) +
        command.length >
      RESOURCE_LIMITS.historyCharacters
    )
      throw new StataError(
        "This session has reached the saved-history limit of 1 million characters. Export your work and restart the dataset to continue.",
        901,
      );
    if (this.history.length >= 500)
      throw new StataError(
        "This practice session has reached 500 successful commands. Export your work and restart the dataset to continue.",
      );
    const before = this.snapshot();
    try {
      const result = this.dispatch(command);
      if (result.changed) {
        const resourceError = dataResourceError(this.data);
        if (resourceError) throw new StataError(resourceError, 901);
      }
      this.undoStack.push(before);
      this.trimUndo();
      this.history.push(command);
      this.last = {
        ...result,
        command,
        effect: dataChanges(
          before.data,
          this.data,
          result.kind === "restore" && !result.changed
            ? "message"
            : result.kind,
        ),
      };
      return this.last;
    } catch (error) {
      Object.assign(this, before);
      throw error;
    }
  }
  dispatch(command) {
    const match = command.match(/^([^\s,]+)\s*([\s\S]*)$/);
    if (!match) throw new StataError("Enter a command.");
    const verb = aliases[match[1]] || match[1],
      rest = match[2] || "";
    const [body, options] = splitTop(rest, ",");
    const data = this.data;
    if (verb === "help")
      return {
        kind: "help",
        message:
          "Open Command help for the browser-supported subset. In Stata, help command opens the full reference.",
      };
    if (verb === "preserve") {
      noOptions(options);
      if (body) throw new StataError("Use preserve without arguments.");
      if (this.preservedData)
        throw new StataError(
          "Data are already preserved.",
          621,
          "Use restore to recover the preserved data, or restore, not to discard that copy before preserving again.",
        );
      this.preservedData = clone(data);
      return {
        kind: "preserve",
        message: `Preserved ${data.rows.length} observations and ${data.columns.length} variables. Use restore to recover this copy. Browser practice keeps it across Run actions until you restore or restart.`,
      };
    }
    if (verb === "restore") {
      if (body || !["", "not", "preserve"].includes(options))
        throw new StataError(
          "Use restore, restore, preserve, or restore, not.",
        );
      if (!this.preservedData)
        throw new StataError(
          "Nothing to restore.",
          622,
          "Run preserve before making temporary changes. Undo may still recover an earlier command.",
        );
      if (options === "not") {
        this.preservedData = null;
        return {
          kind: "restore",
          message:
            "Discarded the preserved copy. The current data remain in memory.",
        };
      }
      this.data = clone(this.preservedData);
      if (options !== "preserve") this.preservedData = null;
      this.model = null;
      this.graph = null;
      return {
        kind: "restore",
        changed: true,
        message: `Restored ${this.data.rows.length} observations and ${this.data.columns.length} variables.${options === "preserve" ? " The preserved copy is still available." : " The preserved copy has been released."} Rerun regress before predicting in browser practice.`,
      };
    }
    if (verb === "import") {
      const m = body.match(/^delimited\s+using\s+"([A-Za-z0-9_-]+\.csv)"$/);
      if (!m)
        throw new StataError(
          'Use import delimited using "study.csv", clear (or wages.csv or clinic.csv).',
          198,
          "Browser commands load built-in or locally imported datasets from this workspace. Choose Import data to add a file; a command cannot read an arbitrary disk path or URL.",
        );
      const entry = [
        ...Object.values(DATASETS),
        ...Object.values(this.customDatasets),
      ].find((d) => d.file === m[1]);
      if (!entry)
        throw new StataError(
          `Dataset ${m[1]} is not available in browser practice.`,
          601,
        );
      const original = this.originalDataset(entry.id);
      if (options !== "clear" && options !== nativeImportOptions(original))
        throw new StataError(
          "These import options do not match the supported local dataset schema.",
          198,
          "Use the clear option to reload the agreed local import, or the exact import command supplied in its Stata export. Change column decisions in the import preview.",
        );
      this.data = original;
      this.model = null;
      this.graph = null;
      return {
        kind: "import",
        message: `Loaded ${this.data.rows.length} observations and ${this.data.columns.length} variables from ${entry.file}.`,
        changed: true,
      };
    }
    if (verb === "clear") {
      noOptions(options);
      if (body && body !== "all")
        throw new StataError("Use clear or clear all.");
      this.data = { id: data.id, rows: [], columns: [] };
      this.model = null;
      this.graph = null;
      return {
        kind: "clear",
        message: "Data cleared. Undo restores the previous dataset.",
        changed: true,
      };
    }
    if (verb === "set" && body === "more off") {
      noOptions(options);
      return {
        kind: "message",
        message: "Output is shown without pausing in browser practice.",
      };
    }
    if (verb === "display") {
      noOptions(options);
      const fn = compileExpression(body, data.columns);
      return {
        kind: "display",
        value: fn(data.rows[0] || {}, 0, data.rows.length),
      };
    }
    if (!data.columns.length)
      throw new StataError(
        "No dataset is loaded.",
        3,
        'Use import delimited using "study.csv", clear, or restart the lesson.',
      );
    if (verb === "describe") {
      noOptions(options);
      const names = variables(body, data, { allowEmpty: true });
      return {
        kind: "describe",
        n: data.rows.length,
        columns: data.columns.filter((c) => names.includes(c.name)),
        message:
          "Numeric values use double precision in this browser. Stata chooses storage types when importing a CSV.",
      };
    }
    if (verb === "codebook") {
      noOptions(options);
      const names = variables(body, data, { allowEmpty: true });
      return {
        kind: "codebook",
        variables: names.map((name) => {
          const values = data.rows.map((r) => r[name]),
            valid = values.filter((v) => !missing(v) && v !== "");
          return {
            name,
            label: data.columns.find((c) => c.name === name).label,
            type: data.columns.find((c) => c.name === name).type,
            missing: values.length - valid.length,
            unique: new Set(valid).size,
            examples: [...new Set(valid)].slice(0, 8),
          };
        }),
      };
    }
    if (verb === "label") {
      noOptions(options);
      const m = body.match(/^variable\s+(\w+)\s+"([^"\n]*)"$/);
      if (!m) throw new StataError('Use label variable name "Description".');
      variables(m[1], data);
      data.columns.find((c) => c.name === m[1]).label = m[2];
      return {
        kind: "label",
        message: `Label updated for ${m[1]}.`,
        changed: true,
      };
    }
    if (verb === "rename") {
      noOptions(options);
      const parts = body.split(/\s+/);
      if (parts.length !== 2)
        throw new StataError("Use rename oldname newname.");
      const [old, name] = parts;
      variables(old, data);
      newVariable(name, data);
      data.columns.find((c) => c.name === old).name = name;
      for (const r of data.rows) {
        r[name] = r[old];
        delete r[old];
      }
      this.model = null;
      this.graph = null;
      return {
        kind: "rename",
        message: `Renamed ${old} to ${name}.`,
        changed: true,
      };
    }
    if (verb === "sort") {
      noOptions(options);
      const names = variables(body, data);
      data.rows.sort((a, b) => {
        for (const name of names) {
          const x = missing(a[name]) ? Infinity : a[name],
            y = missing(b[name]) ? Infinity : b[name];
          if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
      });
      this.model = null;
      this.graph = null;
      return {
        kind: "sort",
        message: `Observations sorted by ${names.join(", ")}. Numeric missing values sort last.`,
        changed: true,
      };
    }
    const q = qualify(body, data),
      rows = q.selected.map((x) => x.r);
    if (verb === "egen" || verb === "collapse") {
      const args = {
        data,
        main: q.main,
        options,
        selected: q.selected,
        command,
        resolve: (source, settings) => variables(source, data, settings),
        newName: (name) => newVariable(name, data),
        validName: cleanName,
      };
      let result;
      if (verb === "egen") result = egenColumn(args);
      else {
        const output = collapseDataset(args);
        this.data = output.data;
        result = output.result;
      }
      this.model = null;
      this.graph = null;
      return result;
    }
    if (verb === "count") {
      noOptions(options);
      if (q.main)
        throw new StataError(
          "Use count, count if expression, or count in first/last.",
        );
      return {
        kind: "count",
        n: rows.length,
        total: data.rows.length,
        selected: q.selected.map((x) => x.i),
      };
    }
    if (verb === "list") {
      noOptions(options);
      const names = variables(q.main, data, { allowEmpty: true });
      return {
        kind: "list",
        names,
        rows: q.selected.map(({ r, i }) => ({
          position: i + 1,
          values: names.map((n) => r[n]),
        })),
        n: rows.length,
      };
    }
    if (verb === "summarize") {
      noOptions(options);
      const names = variables(q.main, data, { allowEmpty: true });
      return {
        kind: "summarize",
        stats: names.map((name) => ({
          name,
          ...summarize(rows.map((r) => r[name])),
        })),
        n: rows.length,
      };
    }
    if (verb === "tabulate") {
      if (options && options !== "missing") noOptions(options);
      const names = variables(q.main, data);
      if (names.length !== 1)
        throw new StataError(
          "Browser practice supports one-way tables: tabulate variable [, missing].",
        );
      const name = names[0],
        values = rows
          .map((r) => r[name])
          .filter((v) => options === "missing" || (!missing(v) && v !== "")),
        counts = new Map();
      for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
      const entries = [...counts].sort(([a], [b]) => {
        if (a === b) return 0;
        if (missing(a)) return 1;
        if (missing(b)) return -1;
        return a < b ? -1 : 1;
      });
      let cum = 0;
      return {
        kind: "tabulate",
        name,
        n: values.length,
        entries: entries.map(([value, count]) => ({
          value,
          count,
          percent: (100 * count) / values.length,
          cumulative: (100 * (cum += count)) / values.length,
        })),
      };
    }
    if (verb === "generate" || verb === "replace") {
      if (verb === "generate" && data.columns.length >= 100)
        throw new StataError(
          "Browser practice supports at most 100 variables. Export your work to continue in Stata.",
        );
      noOptions(options);
      const m = q.main.match(
        /^(?:(double|float|byte|int|long|str\d+)\s+)?([A-Za-z_]\w*)\s*=\s*(.+)$/,
      );
      if (!m)
        throw new StataError(
          `Use ${verb} ${verb === "generate" ? "double " : ""}newvar = expression [if condition].`,
        );
      const [, storage, name, expression] = m;
      if (storage && verb === "replace")
        throw new StataError("replace does not take a storage type.");
      if (storage && storage !== "double")
        throw new StataError(
          "Only double storage is supported explicitly in browser practice.",
          198,
          'Use generate double for numeric variables. Type generate name = "text" for strings.',
        );
      if (verb === "generate") newVariable(name, data);
      else variables(name, data);
      const fn = compileExpression(expression, data.columns),
        values = q.selected.map(({ r, i }) => fn(r, i, data.rows.length));
      const string = fn.valueType === "string",
        numeric = fn.valueType === "numeric";
      if (storage === "double" && string)
        throw new StataError(
          "Type mismatch: double storage requires a numeric expression.",
          109,
        );
      const type =
        verb === "generate"
          ? string
            ? "string"
            : "numeric"
          : data.columns.find((c) => c.name === name).type;
      if ((type === "string" && numeric) || (type === "numeric" && string))
        throw new StataError(
          "Type mismatch between the variable and the expression.",
          109,
        );
      if (verb === "generate") {
        data.columns.push({ name, label: "", type, origin: { command } });
        for (const r of data.rows) r[name] = type === "string" ? "" : null;
      }
      let changed = 0;
      q.selected.forEach(({ r }, i) => {
        if (r[name] !== values[i]) changed++;
        r[name] = values[i];
      });
      if (verb === "replace") {
        const column = data.columns.find((c) => c.name === name);
        column.origin = { ...(column.origin || {}), edited: true };
      }
      this.model = null;
      this.graph = null;
      return {
        kind: verb,
        name,
        changed: true,
        changedCells: changed,
        n: values.length,
        missing: data.rows.filter((r) => missing(r[name]) || r[name] === "")
          .length,
        message: `${name}: ${verb === "generate" ? "variable created" : `${changed} value(s) changed`}. ${data.rows.filter((r) => missing(r[name]) || r[name] === "").length} missing value(s). Browser data changes clear the fitted model; rerun regress before predict.`,
      };
    }
    if (verb === "drop" || verb === "keep") {
      noOptions(options);
      if (q.condition || q.range) {
        if (q.main)
          throw new StataError(
            `Use ${verb} varlist or ${verb} if condition, not both.`,
          );
        const chosen = new Set(q.selected.map((x) => x.i));
        const old = data.rows.length;
        data.rows = data.rows.filter((r, i) =>
          verb === "keep" ? chosen.has(i) : !chosen.has(i),
        );
        this.model = null;
        this.graph = null;
        return {
          kind: verb,
          changed: true,
          removed: old - data.rows.length,
          message: `${old - data.rows.length} observation(s) removed. ${data.rows.length} remain. Undo restores them.`,
        };
      }
      const names = variables(q.main, data);
      data.columns = data.columns.filter((c) =>
        verb === "keep" ? names.includes(c.name) : !names.includes(c.name),
      );
      const retain = new Set(data.columns.map((c) => c.name));
      data.rows = data.rows.map((r) =>
        Object.fromEntries(
          Object.entries(r).filter(([name]) => retain.has(name)),
        ),
      );
      this.model = null;
      this.graph = null;
      return {
        kind: verb,
        changed: true,
        message: `${data.columns.length} variable(s) remain. Undo restores the previous dataset.`,
      };
    }
    if (verb === "assert") {
      noOptions(options);
      const fn = compileExpression(q.main, data.columns);
      const failed = q.selected.filter(
        ({ r, i }) => !truth(fn(r, i, data.rows.length)),
      ).length;
      if (fn.valueType === "string")
        throw new StataError(
          "assert requires a numeric condition, usually a comparison.",
          109,
        );
      if (failed) {
        const error = new StataError(
          `${failed} of ${rows.length} observation(s) contradict the assertion.`,
          9,
          "Inspect the unexpected values with list ... if condition. Do not delete them until you understand their source.",
        );
        error.evidence = {
          operation: "assert",
          checked: q.selected.map(({ i }) => i),
          failed: q.selected
            .filter(({ r, i }) => !truth(fn(r, i, data.rows.length)))
            .map(({ i }) => i),
        };
        throw error;
      }
      return {
        kind: "assert",
        message: `Assertion holds for all ${rows.length} selected observation(s).`,
      };
    }
    if (verb === "isid") {
      noOptions(options);
      if (q.condition || q.range)
        throw new StataError("if and in are not supported with isid.");
      const names = variables(q.main, data),
        keys = new Set();
      for (const r of rows) {
        if (names.some((n) => missing(r[n]) || r[n] === ""))
          throw new StataError("Identifier contains missing values.", 459);
        const key = JSON.stringify(names.map((n) => r[n]));
        if (keys.has(key))
          throw new StataError(
            "These variables do not uniquely identify observations.",
            459,
            "Use duplicates report id to inspect repeated identifiers.",
          );
        keys.add(key);
      }
      return {
        kind: "isid",
        message: `${names.join(" ")} uniquely identifies ${rows.length} observations, with no missing identifiers.`,
      };
    }
    if (verb === "duplicates") {
      noOptions(options);
      if (q.condition || q.range)
        throw new StataError(
          "if and in are not supported with duplicates here.",
        );
      const m = q.main.match(/^report(?:\s+(.*))?$/);
      if (!m)
        throw new StataError(
          "Browser practice supports duplicates report [varlist].",
        );
      const names = variables(m[1] || "", data, { allowEmpty: true }),
        groups = new Map();
      for (const r of rows) {
        const key = JSON.stringify(names.map((n) => r[n]));
        groups.set(key, (groups.get(key) || 0) + 1);
      }
      const copies = new Map();
      for (const count of groups.values())
        copies.set(count, (copies.get(count) || 0) + 1);
      return {
        kind: "duplicates",
        names,
        entries: [...copies]
          .sort((a, b) => a[0] - b[0])
          .map(([copies, groups]) => ({
            copies,
            observations: copies * groups,
            surplus: (copies - 1) * groups,
          })),
      };
    }
    if (verb === "regress") {
      if (options && !["robust", "vce(robust)"].includes(options))
        noOptions(options);
      const rawNames = q.main.split(/\s+/);
      if (new Set(rawNames).size !== rawNames.length)
        throw new StataError(
          "A variable is repeated in the model. Use distinct predictors and do not regress an outcome on itself.",
        );
      const names = variables(q.main, data, { numeric: true });
      const [y, ...x] = names;
      let model;
      try {
        model = regress(rows, y, x, Boolean(options));
      } catch (e) {
        throw new StataError(e.message, 498);
      }
      this.model = model;
      model.columnOrigins = Object.fromEntries(
        data.columns
          .filter((c) => names.includes(c.name) && c.origin)
          .map((c) => [c.name, clone(c.origin)]),
      );
      this.graph =
        x.length === 1
          ? {
              kind: "scatter",
              x: x[0],
              y,
              points: model.sample.map((r) => ({ x: r[x[0]], y: r[y] })),
              line: {
                slope: model.coefficients[0].b,
                intercept: model.coefficients[1].b,
              },
              title: `${y} and ${x[0]}`,
              model: true,
            }
          : null;
      return {
        kind: "regress",
        model,
        omitted: rows.length - model.n,
        message:
          "OLS describes a conditional association. Robust standard errors change uncertainty, not the coefficients or the identification assumptions.",
      };
    }
    if (verb === "predict") {
      if (options && !["xb", "residuals", "resid"].includes(options))
        noOptions(options);
      if (!this.model)
        throw new StataError(
          "No regression is available.",
          301,
          "Run regress first. Data-changing commands in browser practice clear the fitted model.",
        );
      const m = q.main.match(/^(?:double\s+)?(\w+)$/);
      if (!m)
        throw new StataError("Use predict double newvar [, xb | residuals].");
      const name = m[1];
      newVariable(name, data);
      const residual = options.startsWith("resid"),
        model = this.model;
      data.columns.push({
        name,
        label: residual ? "Regression residual" : "Fitted value",
        type: "numeric",
      });
      for (const r of data.rows) r[name] = null;
      for (const { r } of q.selected) {
        if (model.predictors.some((p) => missing(r[p]))) continue;
        const fit =
          model.coefficients.at(-1).b +
          model.predictors.reduce(
            (s, p, j) => s + r[p] * model.coefficients[j].b,
            0,
          );
        r[name] = residual
          ? missing(r[model.dependent])
            ? null
            : r[model.dependent] - fit
          : fit;
      }
      return {
        kind: "predict",
        name,
        residual,
        changed: true,
        message: `Created ${name}. Predictions use every selected row with observed predictors, including rows outside the estimation sample. Residuals also require the outcome.`,
      };
    }
    if (verb === "correlate") {
      noOptions(options);
      const names = variables(q.main, data, { numeric: true });
      if (names.length < 2)
        throw new StataError("Specify at least two numeric variables.");
      const valid = rows.filter((r) => names.every((n) => !missing(r[n])));
      if (valid.length < 2)
        throw new StataError(
          "At least two complete observations are needed.",
          2001,
        );
      return {
        kind: "correlate",
        names,
        n: valid.length,
        values: names.map((a) =>
          names.map((b) =>
            correlation(
              valid.map((r) => r[a]),
              valid.map((r) => r[b]),
            ),
          ),
        ),
      };
    }
    if (verb === "scatter" || verb === "histogram") {
      if (verb === "scatter") noOptions(options);
      else if (options && options !== "frequency") noOptions(options);
      const names = variables(q.main, data, { numeric: true });
      if (names.length !== (verb === "scatter" ? 2 : 1))
        throw new StataError(
          verb === "scatter"
            ? "Use scatter outcome predictor."
            : "Use histogram variable, frequency.",
        );
      if (
        rows.some((row) =>
          names.some(
            (name) => !missing(row[name]) && Math.abs(row[name]) > 1e100,
          ),
        )
      )
        throw new StataError(
          "Graph values exceed the supported numerical range (absolute value 1e100). Rescale the variables.",
          498,
        );
      if (verb === "histogram" && options !== "frequency")
        throw new StataError(
          "Use histogram variable, frequency in browser practice.",
          198,
          "Stata defaults to density; this workspace currently supports frequency histograms only.",
        );
      if (verb === "scatter") {
        const [y, x] = names,
          points = rows
            .filter((r) => !missing(r[y]) && !missing(r[x]))
            .map((r) => ({ x: r[x], y: r[y] }));
        if (!points.length)
          throw new StataError("No complete observations to plot.", 2000);
        this.graph = { kind: "scatter", x, y, points, title: `${y} and ${x}` };
      } else {
        const name = names[0],
          values = rows.map((r) => r[name]).filter((v) => !missing(v));
        if (!values.length)
          throw new StataError("No nonmissing observations to plot.", 2000);
        this.graph = {
          kind: "histogram",
          name,
          values,
          title: `Distribution of ${name}`,
        };
      }
      return {
        kind: verb,
        graph: this.graph,
        message:
          verb === "histogram"
            ? "Frequency histogram. Browser bin boundaries are illustrative and may differ from Stata’s automatic bins."
            : "Each point represents one observation with both variables observed.",
      };
    }
    throw new StataError(
      `Command ${match[1]} is not supported in browser practice.`,
      199,
      "Open Command help for the supported subset. No command was executed; export your work to use the full Stata language.",
    );
  }
}
