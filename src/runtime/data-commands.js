// Commands that combine and reshape datasets, and the cleaning commands
// that convert between strings and numbers. Datasets are saved to a folder
// that lives in the session (session.files), so save, use, append and merge
// work together without touching the student's disk.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { count, list } from "./reports.js";
import { splitAtComma } from "./syntax.js";
import { Dataset } from "./store.js";
import {
  MISSING,
  byteLength,
  defaultFormat,
  inferType,
  isMissing,
  isName,
  isStringType,
  parseNumber,
  stringWidth,
} from "./values.js";

const invalid = (message = "invalid syntax") => new StataError(message, 198);
const RANK = ["byte", "int", "long", "float", "double"];
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

// ----- the session's folder -----
export function fileName(text) {
  let name = text.trim();
  if (name.startsWith('`"') && name.endsWith("\"'")) name = name.slice(2, -2);
  else if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
  if (!name) throw invalid("invalid file specification");
  return /\.[A-Za-z0-9]+$/.test(name) ? name : name + ".dta";
}
const files = (session) => (session.files ??= new Map());
const fingerprint = (data) =>
  JSON.stringify([
    data.n,
    data.variables.map((v) => [
      v.name,
      v.type,
      v.format,
      v.label,
      Array.from(v.data),
    ]),
  ]);
/** True when the data in memory differ from what was last saved or loaded. */
function changed(session) {
  return (
    session.data.variables.length > 0 &&
    fingerprint(session.data) !== session.cleanFingerprint
  );
}
export function load(session, name) {
  const stored = files(session).get(name);
  if (!stored) throw new StataError(`file ${name} not found`, 601);
  if (typeof stored.text === "string")
    throw new StataError(
      `${name} is a text file, not a Stata dataset; use import delimited`,
      610,
    );
  const data = new Dataset({ defaultType: session.data.defaultType });
  data.restore(stored);
  data.defaultType = session.data.defaultType;
  return data;
}

function save(session, text, ctx) {
  const parsed = session.parse(
      "[anything] [, replace EMPTYok noLabel ORPHANS]",
      text,
    ),
    name = fileName(parsed.anything || session.fileInUse || ""),
    store = files(session);
  if (store.has(name) && !parsed.options.replace)
    throw new StataError(`file ${name} already exists`, 602);
  if (parsed.options.replace && !store.has(name))
    ctx.out(`(file ${name} not found)`);
  store.set(name, session.data.snapshot());
  session.fileInUse = name;
  session.cleanFingerprint = fingerprint(session.data);
  ctx.out(`file ${name} saved`);
}
function use(session, text) {
  const parsed = session.parse("anything [, clear]", text),
    name = fileName(parsed.anything),
    data = load(session, name);
  if (changed(session) && !parsed.options.clear)
    throw new StataError(
      "no; dataset in memory has changed since last saved",
      4,
    );
  session.data = data;
  session.fileInUse = name;
  session.cleanFingerprint = fingerprint(data);
}

// ----- append -----
function widerType(a, b) {
  if (isStringType(a) !== isStringType(b)) return null;
  if (isStringType(a)) return stringWidth(a) >= stringWidth(b) ? a : b;
  return RANK[Math.max(RANK.indexOf(a), RANK.indexOf(b))];
}
function append(session, text) {
  const parsed = session.parse(
      "using/ [, GENerate(name) FORCE | KEEP(string) noLabel noNOTEs]",
      text,
    ),
    other = load(session, fileName(parsed.using)),
    data = session.data,
    n = data.n,
    total = n + other.n;
  if (parsed.options.generate && data.has(parsed.options.generate))
    throw new StataError(
      `variable ${parsed.options.generate} already defined`,
      110,
    );
  for (const theirs of other.variables) {
    if (!data.has(theirs.name)) continue;
    if (
      widerType(data.get(theirs.name).type, theirs.type) === null &&
      !parsed.options.force
    )
      throw new StataError(
        `variable ${theirs.name} is ${isStringType(data.get(theirs.name).type) ? "str" : "numeric"} in master but ${isStringType(theirs.type) ? "str" : "numeric"} in using data`,
        106,
      );
  }
  const extend = (values, text, fill) => {
    const out = text ? values.slice() : Array.from(values);
    while (out.length < total) out.push(fill);
    return out;
  };
  for (const variable of data.variables) {
    const text = isStringType(variable.type),
      theirs = other.variables.find((v) => v.name === variable.name),
      values = extend(variable.data, text, text ? "" : MISSING);
    if (theirs && isStringType(theirs.type) === text) {
      const type = widerType(variable.type, theirs.type);
      for (let i = 0; i < other.n; i++) values[n + i] = theirs.data[i];
      if (type !== variable.type) data.retype(variable, type);
    }
    variable.data = text ? values : Float64Array.from(values);
  }
  data.n = total;
  if (parsed.options.generate) {
    data.generate(
      parsed.options.generate,
      Array.from({ length: total }, (_, i) => Number(i >= n)),
      { type: "byte" },
    );
    data.valueLabels.set(
      "_append",
      new Map([
        [0, "Master (0)"],
        [1, "Using (1)"],
      ]),
    );
    Object.assign(data.get(parsed.options.generate), {
      format: "%18.0g",
      valueLabel: "_append",
      label: "Dataset source",
    });
  }
  for (const theirs of other.variables) {
    if (data.has(theirs.name)) continue;
    const text = isStringType(theirs.type),
      values = new Array(n)
        .fill(text ? "" : MISSING)
        .concat(Array.from(theirs.data));
    data.generate(theirs.name, values, { type: theirs.type, string: text });
    Object.assign(data.get(theirs.name), {
      format: theirs.format,
      label: theirs.label,
      valueLabel: theirs.valueLabel,
    });
  }
  for (const [name, map] of other.valueLabels)
    if (!data.valueLabels.has(name)) data.valueLabels.set(name, new Map(map));
  data.sortedBy = [];
}

// ----- merge -----
function merge(session, text, ctx) {
  const m = /^\s*(1:1|m:1|1:m|m:m)\s+([\s\S]*)$/.exec(text);
  if (!m) throw invalid("merge needs 1:1, m:1, 1:m or m:m");
  if (m[1] === "m:m")
    throw invalid("merge m:m is not available; it rarely does what is wanted");
  const parsed = session.parse(
      "varlist using/ [, KEEPUSing(string) GENerate(name) noGENerate KEEP(string) ASSERT(string) NOREPort | noLabel UPDATE REPLACE FORCE SORTED noNOTEs]",
      m[2],
    ),
    data = session.data,
    keys = parsed.varlist,
    noMarker = /\bnogen/.test(splitAtComma(m[2])[1] ?? ""),
    marker =
      typeof parsed.options.generate === "string"
        ? parsed.options.generate
        : "_merge";
  if (!noMarker && data.has(marker))
    throw new StataError(`variable ${marker} already defined`, 110);
  // Stata sorts the master data on the key before it reads the using data.
  data.sort(keys);
  const other = load(session, fileName(parsed.using));
  for (const key of keys) {
    if (!other.has(key)) throw new StataError(`variable ${key} not found`, 111);
    if (isStringType(other.get(key).type) !== isStringType(data.get(key).type))
      throw new StataError(
        `key variable ${key} is str in one dataset and numeric in the other`,
        106,
      );
  }
  other.sort(keys);
  const keyOf = (set, i) => JSON.stringify(keys.map((k) => set.get(k).data[i])),
    index = (set) => {
      const map = new Map();
      for (let i = 0; i < set.n; i++) {
        const key = keyOf(set, i);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(i);
      }
      return map;
    },
    master = index(data),
    using = index(other),
    unique = (map, side) => {
      for (const rows of map.values())
        if (rows.length > 1)
          throw new StataError(
            `variable${keys.length > 1 ? "s" : ""} ${keys.join(" ")} do${keys.length > 1 ? "" : "es"} not uniquely identify observations in the ${side} data`,
            459,
          );
    };
  if (m[1][0] === "1") unique(master, "master");
  if (m[1][2] === "1") unique(using, "using");
  const wanted = parsed.options.keepusing
      ? expand(parsed.options.keepusing, other.names)
      : other.names,
    brought = wanted.filter((name) => !keys.includes(name) && !data.has(name));
  // Each output row is a master row, a using row, or both.
  const rows = [],
    extra = [],
    used = new Set();
  for (let i = 0; i < data.n; i++) {
    const matches = using.get(keyOf(data, i)) ?? [];
    rows.push({ master: i, using: matches[0] ?? null });
    if (matches.length) used.add(matches[0]);
  }
  for (let j = 0; j < other.n; j++) {
    if (used.has(j)) continue;
    const mine = master.get(keyOf(other, j));
    extra.push({ master: mine ? mine[0] : null, using: j });
  }
  let all = [...rows, ...extra];
  const code = (row) => (row.master === null ? 2 : row.using === null ? 1 : 3),
    tally = [0, 0, 0, 0];
  for (const [option, action] of [
    ["assert", "assert"],
    ["keep", "keep"],
  ]) {
    const spec = parsed.options[option];
    if (!spec) continue;
    const allowed = new Set(
      spec.split(/\s+/).map((word) => {
        if (/^(1|mas(t(er?)?)?)$/.test(word)) return 1;
        if (/^(2|us(i(ng?)?)?)$/.test(word)) return 2;
        if (/^(3|mat(c(h(ed?)?)?)?)$/.test(word)) return 3;
        throw invalid(`${option}(${spec}) is not understood`);
      }),
    );
    if (action === "assert" && all.some((row) => !allowed.has(code(row))))
      throw new StataError(
        "merge:  after merge, not all observations matched as asserted",
        9,
      );
    if (action === "keep") all = all.filter((row) => allowed.has(code(row)));
  }
  // The report counts what is kept.
  for (const row of all) tally[code(row)]++;
  const result = new Dataset({ defaultType: data.defaultType });
  result.n = all.length;
  result.label = data.label;
  result.valueLabels = data.valueLabels;
  for (const variable of data.variables) {
    const text = isStringType(variable.type),
      theirs = other.has(variable.name) ? other.get(variable.name) : null,
      shared = theirs && isStringType(theirs.type) === text,
      type =
        shared && keys.includes(variable.name)
          ? widerType(variable.type, theirs.type)
          : variable.type,
      // A row with a master observation keeps the master's values; a
      // using-only row takes shared variables from the using data.
      values = all.map((row) =>
        row.master !== null
          ? variable.data[row.master]
          : shared
            ? theirs.data[row.using]
            : text
              ? ""
              : MISSING,
      );
    result.generate(variable.name, values, { type, string: text });
    Object.assign(result.get(variable.name), {
      format: variable.format,
      label: variable.label,
      valueLabel: variable.valueLabel,
    });
  }
  for (const name of brought) {
    const theirs = other.get(name),
      text = isStringType(theirs.type);
    result.generate(
      name,
      all.map((row) =>
        row.using === null ? (text ? "" : MISSING) : theirs.data[row.using],
      ),
      { type: theirs.type, string: text },
    );
    Object.assign(result.get(name), {
      format: theirs.format,
      label: theirs.label,
      valueLabel: theirs.valueLabel,
    });
  }
  for (const [name, map] of other.valueLabels)
    if (!result.valueLabels.has(name))
      result.valueLabels.set(name, new Map(map));
  if (!noMarker) {
    result.generate(marker, all.map(code), { type: "byte" });
    result.valueLabels.set(
      "_merge",
      new Map([
        [1, "Master only (1)"],
        [2, "Using only (2)"],
        [3, "Matched (3)"],
      ]),
    );
    Object.assign(result.get(marker), {
      format: "%23.0g",
      valueLabel: "_merge",
      label: "Matching result from merge",
    });
  }
  // The result is in key order only when no using rows were added below.
  result.sortedBy = all.some(
    (row) => row.master === null || extra.includes(row),
  )
    ? []
    : [...keys];
  session.data = result;
  if (!parsed.options.noreport) {
    const from = (label, n) =>
      `        ${label.padEnd(24)}${count(n).padStart(13)}`;
    ctx.out("");
    ctx.out("    Result                      Number of obs");
    ctx.out("    -----------------------------------------");
    ctx.out(
      `    ${"Not matched".padEnd(28)}${count(tally[1] + tally[2]).padStart(13)}`,
    );
    if (tally[1] + tally[2]) {
      ctx.out(
        `${from("from master", tally[1])}${noMarker ? "" : `  (${marker}==1)`}`,
      );
      ctx.out(
        `${from("from using", tally[2])}${noMarker ? "" : `  (${marker}==2)`}`,
      );
      ctx.out("");
    }
    ctx.out(
      `    ${"Matched".padEnd(28)}${count(tally[3]).padStart(13)}${noMarker ? "" : `  (${marker}==3)`}`,
    );
    ctx.out("    -----------------------------------------");
  }
}
function expand(text, names) {
  return text
    .trim()
    .split(/\s+/)
    .flatMap((word) => {
      const hits = names.filter(
        (name) => name === word || name.startsWith(word),
      );
      if (names.includes(word)) return [word];
      if (hits.length !== 1)
        throw new StataError(`variable ${word} not found`, 111);
      return hits;
    });
}

// ----- reshape -----
function reshape(session, text) {
  const m = /^\s*(long|wide)\s+([\s\S]*)$/.exec(text);
  if (!m) throw invalid("reshape long or reshape wide is required");
  const [head, optionText] = splitAtComma(m[2]),
    options = session.parse(
      "[, I(varlist) J(string) String]",
      "," + (optionText ?? ""),
    ).options,
    stubs = head.trim().split(/\s+/).filter(Boolean),
    data = session.data,
    ids = options.i,
    jWords = (options.j ?? "").trim().split(/\s+/),
    j = jWords[0],
    text2 = !!options.string || jWords.includes("string");
  if (!ids?.length || !j || !stubs.length)
    throw invalid("i() and j() are required");
  const result = new Dataset({ defaultType: data.defaultType });
  result.valueLabels = data.valueLabels;
  result.label = data.label;
  const copy = (target, source, name, values) => {
    target.generate(name, values, {
      type: source.type,
      string: isStringType(source.type),
    });
    Object.assign(target.get(name), {
      format: source.format,
      label: source.label,
      valueLabel: source.valueLabel,
    });
  };
  if (m[1] === "long") {
    if (data.has(j)) throw new StataError(`variable ${j} already defined`, 110);
    // The j values are the suffixes found after any stub.
    const suffixes = new Set(),
      members = new Map();
    for (const stub of stubs) {
      if (data.has(stub))
        throw new StataError(`variable ${stub} already defined`, 110);
      for (const name of data.names) {
        if (!name.startsWith(stub) || name === stub) continue;
        const suffix = name.slice(stub.length);
        if (!text2 && !/^\d+$/.test(suffix)) continue;
        suffixes.add(suffix);
        members.set(`${stub}|${suffix}`, name);
      }
    }
    if (!suffixes.size) throw new StataError(`no xij variables found`, 111);
    const levels = [...suffixes].sort((a, b) =>
        text2 ? (a < b ? -1 : a > b ? 1 : 0) : Number(a) - Number(b),
      ),
      wide = new Set(members.values());
    data.sort(ids);
    for (let i = 1; i < data.n; i++)
      if (ids.every((id) => data.get(id).data[i] === data.get(id).data[i - 1]))
        throw new StataError(
          `variable${ids.length > 1 ? "s" : ""} ${ids.join(" ")} do${ids.length > 1 ? "" : "es"} not uniquely identify the observations`,
          9,
        );
    const rows = [];
    for (let i = 0; i < data.n; i++)
      for (const level of levels) rows.push([i, level]);
    result.n = rows.length;
    for (const id of ids)
      copy(
        result,
        data.get(id),
        id,
        rows.map(([i]) => data.get(id).data[i]),
      );
    if (text2)
      result.generate(
        j,
        rows.map(([, level]) => level),
        { string: true },
      );
    else {
      const values = rows.map(([, level]) => Number(level));
      result.generate(j, values, { type: inferType(values) });
      result.get(j).format = "%10.0g";
    }
    for (const stub of stubs) {
      const sources = levels.map((level) => members.get(`${stub}|${level}`)),
        first = data.get(sources.find(Boolean)),
        text = isStringType(first.type);
      let type = first.type;
      for (const name of sources.filter(Boolean))
        type = widerType(type, data.get(name).type) ?? type;
      result.generate(
        stub,
        rows.map(([i, level]) => {
          const name = members.get(`${stub}|${level}`);
          return name ? data.get(name).data[i] : text ? "" : MISSING;
        }),
        { type, string: text },
      );
      result.get(stub).format = first.format;
    }
    for (const variable of data.variables)
      if (!ids.includes(variable.name) && !wide.has(variable.name))
        copy(
          result,
          variable,
          variable.name,
          rows.map(([i]) => variable.data[i]),
        );
    result.sortedBy = [...ids, j];
  } else {
    const jVariable = data.get(j),
      levels = [...new Set(Array.from(jVariable.data))]
        .filter((v) => (typeof v === "string" ? v !== "" : !isMissing(v)))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      suffix = (level) => (typeof level === "string" ? level : String(level));
    for (const stub of stubs) data.get(stub);
    data.sort([...ids, j]);
    const groups = session.groupsOf(ids);
    for (let i = 1; i < data.n; i++)
      if (
        [...ids, j].every(
          (name) => data.get(name).data[i] === data.get(name).data[i - 1],
        )
      )
        throw new StataError(
          `values of variable ${j} not unique within ${ids.join(" ")}`,
          9,
        );
    result.n = groups.length;
    for (const id of ids)
      copy(
        result,
        data.get(id),
        id,
        groups.map((group) => data.get(id).data[group.start]),
      );
    for (const level of levels)
      for (const stub of stubs) {
        const source = data.get(stub),
          text = isStringType(source.type),
          name = stub + suffix(level);
        if (!isName(name)) throw invalid(`${name} invalid name`);
        result.generate(
          name,
          groups.map((group) => {
            for (let i = group.start; i < group.start + group.count; i++)
              if (jVariable.data[i] === level) return source.data[i];
            return text ? "" : MISSING;
          }),
          { type: source.type, string: text },
        );
        Object.assign(result.get(name), {
          format: source.format,
          label: `${suffix(level)} ${stub}`,
          valueLabel: source.valueLabel,
        });
      }
    for (const variable of data.variables)
      if (![...ids, j, ...stubs].includes(variable.name))
        copy(
          result,
          variable,
          variable.name,
          groups.map((group) => variable.data[group.start]),
        );
    result.sortedBy = [...ids];
  }
  session.data = result;
}

// ----- observations -----
function expandCommand(session, text, ctx) {
  if (!text.trim() || /^(if|in)\b/.test(text.trim()))
    throw new StataError("=exp required", 100);
  const parsed = session.parse(
      "=exp [if] [in] [, | Generate(name)]",
      "= " + text.replace(/^\s*=?/, ""),
    ),
    compiled = session.compile(parsed.exp),
    data = session.data,
    order = Array.from({ length: data.n }, (_, i) => i),
    before = data.n;
  session.select(parsed, ctx.by, (i, env) => {
    const copies = compiled.evaluate(i, env);
    if (isMissing(copies)) return;
    for (let k = 1; k < Math.trunc(copies); k++) order.push(i);
  });
  data.reorder(order);
  data.sortedBy = [];
  ctx.out(`(${plural(data.n - before, "observation")} created)`);
}

const DUPLICATES = ["report", "examples", "list", "tag"];
function duplicates(session, text, ctx) {
  const m = /^\s*([A-Za-z]*)([\s\S]*)$/.exec(text),
    sub =
      m[1] === "drop"
        ? "drop"
        : DUPLICATES.find((name) => m[1] && name.startsWith(m[1]));
  if (!m[1]) throw invalid("subcommand required; see duplicates");
  if (!sub) throw invalid(`${m[1]} invalid duplicates subcommand`);
  // list and examples pass their options on to list.
  const listing = sub === "list" || sub === "examples",
    parsed = session.parse(
      listing
        ? "[varlist] [if] [in] [, *]"
        : "[varlist] [if] [in] [, Generate(name) force]",
      m[2],
    ),
    data = session.data,
    columns = parsed.varlist.map((name) => data.get(name).data),
    rows = session.rows(parsed, null),
    keyOf = (i) => JSON.stringify(columns.map((column) => column[i])),
    groups = new Map();
  for (const i of rows) groups.set(keyOf(i), (groups.get(keyOf(i)) ?? 0) + 1);
  const all = !m[2]
      .replace(/,.*$/, "")
      .replace(/\b(if|in)\b[\s\S]*$/, "")
      .trim(),
    heading = () => {
      ctx.out("");
      ctx.out(
        `Duplicates in terms of ${all ? "all variables" : parsed.varlist.join(" ")}`,
      );
    };
  if (sub === "tag") {
    if (!parsed.options.generate) throw invalid("option generate() required");
    if (!rows.length) throw new StataError("no observations", 2000);
    heading();
    const selected = new Set(rows),
      sorted = [...data.sortedBy];
    data.generate(
      parsed.options.generate,
      Array.from({ length: data.n }, (_, i) =>
        selected.has(i) ? groups.get(keyOf(i)) - 1 : MISSING,
      ),
      { type: "byte" },
    );
    data.get(parsed.options.generate).format = "%12.0g";
    data.sortedBy = sorted;
    session.results.r = { N: rows.length };
  } else if (sub === "drop") {
    if (!all && !parsed.options.force)
      throw new StataError(
        "force option required with duplicates drop varlist",
        198,
      );
    if (all && parsed.options.force)
      throw new StataError("options not allowed", 101);
    if (!rows.length) throw new StataError("no observations", 2000);
    const seen = new Set(),
      selected = new Set(rows),
      keep = [];
    for (let i = 0; i < data.n; i++) {
      if (!selected.has(i)) keep.push(i);
      else if (!seen.has(keyOf(i))) {
        seen.add(keyOf(i));
        keep.push(i);
      }
    }
    const dropped = data.n - keep.length;
    heading();
    ctx.out("");
    ctx.out(
      dropped
        ? `(${plural(dropped, "observation")} deleted)`
        : "(0 observations are duplicates)",
    );
    if (dropped) data.reorder(keep);
    session.results.r = { N_drop: dropped, N: rows.length };
  } else if (listing) {
    if (!rows.length) throw new StataError("no observations", 2000);
    heading();
    listDuplicates(session, sub, parsed, rows, groups, keyOf, ctx);
  } else {
    const copies = new Map();
    for (const size of groups.values())
      copies.set(size, (copies.get(size) ?? 0) + size);
    heading();
    ctx.out("");
    ctx.out("--------------------------------------");
    ctx.out("   Copies | Observations       Surplus");
    ctx.out("----------+---------------------------");
    // tabdisp shows the counts in %9.0g, without thousands separators.
    for (const [size, n] of [...copies].sort((a, b) => a[0] - b[0]))
      ctx.out(
        `${String(size).padStart(9)} |${String(n).padStart(13)}${String(n - n / size).padStart(14)}`,
      );
    ctx.out("--------------------------------------");
    session.results.r = { unique_value: groups.size, N: rows.length };
  }
}
/**
 * duplicates list and duplicates examples. duplicates.ado numbers the
 * duplicated groups in the sort order of the varlist, then lists, by group
 * and observation number, either every member or the first of each group.
 * The group number is left out when there is only one group.
 */
function listDuplicates(session, sub, parsed, rows, groups, keyOf, ctx) {
  const data = session.data,
    columns = parsed.varlist.map((name) => data.get(name).data),
    sorted = [...rows].sort((a, b) => {
      for (const column of columns)
        if (column[a] !== column[b]) return column[a] < column[b] ? -1 : 1;
      return a - b;
    }),
    number = new Map(),
    shown = [];
  for (const i of sorted) {
    const key = keyOf(i);
    if (groups.get(key) < 2) continue;
    if (!number.has(key)) {
      number.set(key, number.size + 1);
      shown.push(i);
    } else if (sub === "list") shown.push(i);
  }
  session.results.r = { N: rows.length };
  if (!number.size) {
    ctx.out("");
    ctx.out("(0 observations are duplicates)");
    return;
  }
  // Temporary variables carry the headings Stata gives them.
  const listed = new Dataset(),
    names = [];
  listed.setObservations(shown.length);
  listed.valueLabels = data.valueLabels;
  const temporary = (header, values, format) => {
    let k = names.length,
      name;
    do name = `__00000${k++}`;
    while (data.has(name) || names.includes(name));
    names.push(name);
    return {
      name,
      header,
      type: "long",
      format,
      label: "",
      valueLabel: "",
      data: Float64Array.from(values),
    };
  };
  const front = [];
  if (number.size > 1)
    front.push(
      temporary(
        "Group",
        shown.map((i) => number.get(keyOf(i))),
        "%9.0g",
      ),
    );
  if (sub === "examples")
    front.push(
      temporary(
        "#",
        shown.map((i) => groups.get(keyOf(i))),
        "%12.0g",
      ),
    );
  front.push(
    temporary(
      sub === "examples" ? "e.g. obs" : "Obs",
      shown.map((i) => i + 1),
      "%12.0g",
    ),
  );
  // The other variables come along, after those listed, so that an option
  // such as sepby() can name them.
  const rest = data.names.filter((name) => !parsed.varlist.includes(name));
  listed.variables = [
    ...front,
    ...[...parsed.varlist, ...rest].map((name) => {
      const variable = data.get(name);
      return {
        ...variable,
        data: isStringType(variable.type)
          ? shown.map((i) => variable.data[i])
          : Float64Array.from(shown, (i) => variable.data[i]),
      };
    }),
  ];
  list(
    Object.assign(Object.create(session), { data: listed }),
    `${[...front.map((v) => v.name), ...parsed.varlist].join(" ")}, noobs ${(parsed.options["*"] ?? []).join(" ")}`,
    { ...ctx, group: undefined },
  );
}

// ----- strings and numbers -----
/** Inserts a new variable directly after another, as destring and tostring do. */
function placeAfter(data, name, after) {
  const names = data.names.filter((n) => n !== name);
  names.splice(names.indexOf(after) + 1, 0, name);
  data.order(names);
}
/**
 * Replaces a variable with new values in its own position. The new column is
 * made before the old one is dropped: dropping the only variable empties the
 * dataset, after which there would be no observations to fill.
 */
function swapVariable(data, name, values, options) {
  const position = data.names,
    label = data.get(name).label;
  let temporary = "__swap";
  while (data.has(temporary)) temporary += "_";
  data.generate(temporary, values, options);
  data.drop([name]);
  data.rename(temporary, name);
  data.order(position);
  data.get(name).label = label;
}
function targets(parsed, action) {
  const { generate, replace } = parsed.options;
  if (!generate === !replace)
    throw invalid(`${action}: specify generate() or replace, not both`);
  const names = generate ? generate.trim().split(/\s+/) : null;
  if (names && names.length !== parsed.varlist.length)
    throw invalid("generate() must name one new variable for each variable");
  return names;
}

function destring(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [, Generate(string) replace force IGnore(string) PERCENT | DPcomma FLOAT]",
      text,
    ),
    names = targets(parsed, "destring"),
    data = session.data,
    ignore = parsed.options.ignore?.replace(/^"|"$/g, "") ?? "";
  parsed.varlist.forEach((name, k) => {
    const variable = data.get(name);
    if (!isStringType(variable.type)) {
      ctx.out(`${name} already numeric; no ${names ? "generate" : "replace"}`);
      return;
    }
    let bad = 0;
    const values = variable.data.map((raw) => {
      let cell = raw;
      for (const c of ignore) cell = cell.split(c).join("");
      if (parsed.options.percent) cell = cell.replace(/%/g, "");
      cell = cell.trim();
      if (cell === "") return MISSING;
      const value = parseNumber(cell);
      if (value === undefined) {
        bad++;
        return MISSING;
      }
      return parsed.options.percent ? value / 100 : value;
    });
    if (bad && !parsed.options.force) {
      ctx.out(
        `${name}: contains nonnumeric characters; no ${names ? "generate" : "replace"}`,
      );
      return;
    }
    const smallest = inferType(values),
      type = smallest === "float" ? "double" : smallest,
      missing = values.filter(isMissing).length,
      target = names ? names[k] : name;
    if (names) {
      data.generate(target, values, { type });
      placeAfter(data, target, name);
    } else {
      swapVariable(data, name, values, { type });
    }
    data.get(target).format = "%10.0g";
    ctx.out(
      `${name}: ${bad ? "contains nonnumeric characters; " : ignore ? `character${ignore.length > 1 ? "s" : ""} ${[...ignore].join(" ")} removed; ` : "all characters numeric; "}${names ? `${target} generated` : "replaced"} as ${type}`,
    );
    if (missing) ctx.out(`(${plural(missing, "missing value")} generated)`);
  });
}

function tostring(session, text, ctx) {
  const parsed = session.parse(
      "varlist [, Generate(string) replace force Format(string) Usedisplayformat]",
      text,
    ),
    names = targets(parsed, "tostring"),
    data = session.data,
    format = parsed.options.format ?? "%12.0g";
  parsed.varlist.forEach((name, k) => {
    const variable = data.get(name);
    if (isStringType(variable.type)) {
      ctx.out(`${name} already string; no ${names ? "generate" : "replace"}`);
      return;
    }
    const values = Array.from(variable.data, (v) =>
        applyFormat(
          v,
          parsed.options.usedisplayformat ? variable.format : format,
        ).trim(),
      ),
      lossy = values.some((cell, i) => {
        const back = parseNumber(cell);
        return (
          back !== variable.data[i] &&
          !(isMissing(back ?? MISSING) && isMissing(variable.data[i]))
        );
      });
    if (lossy && !parsed.options.force) {
      ctx.out(
        `${name} cannot be converted reversibly; no ${names ? "generate" : "replace"}`,
      );
      return;
    }
    const target = names ? names[k] : name,
      was = variable.type,
      label = variable.label;
    if (names) {
      data.generate(target, values, { string: true });
      placeAfter(data, target, name);
      data.get(target).label = label || name;
      ctx.out(`${target} generated as ${data.get(target).type}`);
    } else {
      swapVariable(data, name, values, { string: true });
      ctx.out(`${name} was ${was} now ${data.get(name).type}`);
    }
  });
}

function encode(session, text) {
  const parsed = session.parse(
      "varname [if] [in] , Generate(name) [ Label(name) noExtend ]",
      text,
    ),
    data = session.data,
    source = data.get(parsed.varlist[0]),
    target = parsed.options.generate,
    labelName = parsed.options.label ?? target;
  if (!isStringType(source.type))
    throw new StataError("not possible with numeric variable", 107);
  if (data.has(target))
    throw new StataError(`variable ${target} already defined`, 110);
  const rows = new Set(session.rows(parsed, null)),
    map = data.valueLabels.get(labelName) ?? new Map(),
    codes = new Map([...map].map(([value, label]) => [label, value])),
    fresh = [
      ...new Set(
        Array.from(source.data).filter(
          (v, i) => rows.has(i) && v !== "" && !codes.has(v),
        ),
      ),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // A value label holds at most 65,536 codings (help limits).
  if (map.size + fresh.length > 65536)
    throw new StataError("too many values", 134);
  let next = Math.max(0, greatest(map.keys()));
  for (const label of fresh) {
    codes.set(label, ++next);
    map.set(next, label);
  }
  data.valueLabels.set(labelName, map);
  const sorted = [...data.sortedBy];
  data.generate(
    target,
    Array.from(source.data, (v, i) =>
      rows.has(i) && v !== "" ? codes.get(v) : MISSING,
    ),
    { type: "long" },
  );
  data.sortedBy = sorted;
  // The display format is as wide as the longest label the new variable
  // uses, in bytes, and never narrower than %8.0g. When it uses no label at
  // all, it keeps a long's %12.0g.
  const used = Array.from(source.data).filter((v, i) => rows.has(i) && v);
  Object.assign(data.get(target), {
    valueLabel: labelName,
    label: source.label,
    format: used.length
      ? `%${Math.max(8, greatest(used.map(byteLength)))}.0g`
      : "%12.0g",
  });
}
function decode(session, text) {
  const parsed = session.parse(
      "varname [if] [in] , Generate(name) [ MAXLength(integer 0) ]",
      text,
    ),
    data = session.data,
    source = data.get(parsed.varlist[0]),
    map = data.valueLabels.get(source.valueLabel);
  if (isStringType(source.type))
    throw new StataError("not possible with string variable", 108);
  if (!map) throw new StataError(`${source.name} not labeled`, 182);
  const rows = new Set(session.rows(parsed, null)),
    sorted = [...data.sortedBy];
  data.generate(
    parsed.options.generate,
    Array.from(source.data, (v, i) => (rows.has(i) ? (map.get(v) ?? "") : "")),
    { string: true },
  );
  data.sortedBy = sorted;
  data.get(parsed.options.generate).label = source.label;
}

function recode(session, text, ctx) {
  const firstRule = text.indexOf("(");
  if (firstRule < 0)
    throw invalid("recode needs at least one rule in parentheses");
  const rules = [],
    names = session.varlist(text.slice(0, firstRule));
  let rest = text.slice(firstRule),
    r;
  while ((r = /^\s*\(([^()]*)\)/.exec(rest))) {
    const [from, to] = r[1].split("=").map((part) => part.trim());
    if (to === undefined) throw invalid(`rule (${r[1]}) has no =`);
    rules.push({ from, to: to.split(/\s+/)[0] });
    rest = rest.slice(r[0].length);
  }
  const parsed = session.parse(
      "[if] [in] [, Generate(string) PREfix(string) Test COPYrest INTO(string)]",
      rest,
    ),
    data = session.data,
    rows = session.rows(parsed, null),
    made = parsed.options.generate?.trim().split(/\s+/);
  if (made && made.length !== names.length)
    throw invalid("generate() must name one new variable for each variable");
  const sorted = [...data.sortedBy];
  names.forEach((name, k) => {
    const variable = data.get(name);
    if (isStringType(variable.type))
      throw new StataError("recode only allows numeric variables", 108);
    const column = variable.data,
      nonmissing = Array.from(column).filter((v) => !isMissing(v)),
      low = least(nonmissing),
      high = greatest(nonmissing),
      // A rule's numbers are read at the variable's own precision.
      point = (word) =>
        word === "min"
          ? low
          : word === "max"
            ? high
            : variable.type === "float"
              ? Math.fround(parseNumber(word))
              : parseNumber(word),
      matches = (rule, value) => {
        if (/^(else|\*)$/.test(rule.from)) return true;
        if (/^mis(s(i(ng?)?)?)?$/.test(rule.from)) return isMissing(value);
        if (/^nonm(i(s(s(i(ng?)?)?)?)?)?$/.test(rule.from))
          return !isMissing(value);
        return rule.from.split(/\s+/).some((item) => {
          const range = /^(.+?)\/(.+)$/.exec(item);
          if (range)
            return (
              !isMissing(value) &&
              value >= point(range[1]) &&
              value <= point(range[2])
            );
          const target = point(item);
          if (target === undefined)
            throw invalid(
              `${item} is not a number in rule (${rule.from} = ${rule.to})`,
            );
          return value === target;
        });
      },
      values = Array.from(column);
    let changes = 0;
    for (const i of rows) {
      const rule = rules.find((candidate) => matches(candidate, column[i]));
      if (!rule) continue;
      const to = parseNumber(rule.to);
      if (to === undefined) throw invalid(`${rule.to} is not a number`);
      if (values[i] !== to) changes++;
      values[i] = to;
    }
    if (made || parsed.options.prefix) {
      const target = made ? made[k] : parsed.options.prefix + name;
      if (!parsed.options.copyrest && rows.length !== data.n)
        for (let i = 0; i < data.n; i++)
          if (!rows.includes(i)) values[i] = MISSING;
      data.generate(target, values, { type: variable.type });
      Object.assign(data.get(target), {
        format: "%9.0g",
        label: `RECODE of ${name}${variable.label ? ` (${variable.label})` : ""}`,
      });
      ctx.out(`(${count(changes)} differences between ${name} and ${target})`);
    } else {
      data.replace(name, values, rows);
      ctx.out(`(${count(changes)} changes made to ${name})`);
    }
  });
  data.sortedBy = sorted.filter((name) => !names.includes(name) || made);
}

const quiet = () => {};
export const DATA_COMMANDS = [
  { name: "save", minimum: 3, run: save },
  { name: "use", minimum: 1, run: use },
  { name: "append", minimum: 3, run: append },
  { name: "merge", minimum: 3, run: merge },
  { name: "reshape", minimum: 7, run: reshape },
  { name: "expand", minimum: 6, run: expandCommand, byable: true },
  { name: "duplicates", minimum: 3, run: duplicates },
  { name: "destring", minimum: 8, run: destring },
  { name: "tostring", minimum: 8, run: tostring },
  { name: "encode", minimum: 2, run: encode },
  { name: "decode", minimum: 3, run: decode },
  { name: "recode", minimum: 6, run: recode },
  // A browser session has one folder and no log files; these are accepted
  // so that do-files written for Stata keep running.
  { name: "mkdir", minimum: 5, run: quiet },
  { name: "cd", minimum: 2, run: quiet },
  { name: "log", minimum: 3, run: quiet },
  { name: "cmdlog", minimum: 6, run: quiet },
  {
    name: "pwd",
    minimum: 3,
    run: (session, text, ctx) => ctx.out("/stataverse"),
  },
  { name: "more", minimum: 4, run: quiet },
  { name: "pause", minimum: 5, run: quiet },
  { name: "set_defaults", minimum: 12, run: quiet },
];
export { defaultFormat };
