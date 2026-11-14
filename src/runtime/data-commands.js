// Commands that combine and reshape datasets, and the cleaning commands
// that convert between strings and numbers. Datasets are saved to a folder
// that lives in the session (session.files), so save, use, append and merge
// work together without touching the student's disk.
import { least, greatest } from "./extremes.js";
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { count, list } from "./reports.js";
import { applySyntax, splitAtComma } from "./syntax.js";
import { Dataset } from "./store.js";
import { findFile } from "./files.js";
import {
  MISSING,
  byteLength,
  coerce,
  defaultFormat,
  formatNumber,
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

// Stata marks the data as changed when their contents, labels, notes or
// characteristics change, but not when the observations or the variables are
// only put in another order, and the mark stays until use, save or clear:
// data changed and changed back are still changed. After each command the
// fingerprint of the data is compared with the one they had when read or
// saved; once it differs, the data are marked. The fingerprint is a hash of
// each observation (its values taken in the order of the variable names)
// with the observations' hashes sorted, beside the dataset's descriptions.
const bits = new Float64Array(1),
  words = new Uint32Array(bits.buffer);
const mix = (h, x, prime) => {
  h = Math.imul(h ^ x, prime);
  return h ^ (h >>> 15);
};
function hashValue(lanes, value) {
  if (typeof value === "string") {
    for (let k = 0; k < value.length; k++) {
      const c = value.charCodeAt(k);
      lanes[0] = mix(lanes[0], c, 0x01000193);
      lanes[1] = mix(lanes[1], c, 0x5bd1e995);
    }
    lanes[0] = mix(lanes[0], 0x10ffff, 0x01000193);
    lanes[1] = mix(lanes[1], 0x10ffff, 0x5bd1e995);
    return;
  }
  bits[0] = value;
  lanes[0] = mix(mix(lanes[0], words[0], 0x01000193), words[1], 0x01000193);
  lanes[1] = mix(mix(lanes[1], words[1], 0x5bd1e995), words[0], 0x5bd1e995);
}
/** Maps, arrays and objects as plain values with their keys in order. */
function plain(value) {
  if (value instanceof Map)
    return [...value]
      .map(([key, item]) => [key, plain(item)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object")
    return plain(new Map(Object.entries(value)));
  return value;
}
const fingerprint = (data) => {
  const variables = [...data.variables].sort((a, b) =>
      a.name < b.name ? -1 : 1,
    ),
    rows = new Float64Array(data.n),
    lanes = new Int32Array(2);
  for (let i = 0; i < data.n; i++) {
    lanes[0] = 0x811c9dc5;
    lanes[1] = 0x9747b28c;
    for (const v of variables) hashValue(lanes, v.data[i]);
    rows[i] = (lanes[0] >>> 0) * 2 ** 21 + (lanes[1] >>> 11);
  }
  rows.sort();
  lanes[0] = 0x811c9dc5;
  lanes[1] = 0x9747b28c;
  for (const row of rows) hashValue(lanes, row);
  return JSON.stringify([
    data.n,
    data.label ?? "",
    variables.map((v) => [v.name, v.type, v.format, v.label, v.valueLabel]),
    plain(data.valueLabels ?? new Map()),
    plain(data.notes ?? new Map()),
    plain(data.chars ?? new Map()),
    lanes[0],
    lanes[1],
  ]);
};
let empty;
/**
 * True when the data in memory differ from what was last saved or loaded,
 * or, for data made in the session, from no data at all.
 */
export function changed(session) {
  const data = session.data;
  if (data.dirty) return true;
  empty ??= fingerprint(new Dataset());
  return fingerprint(data) !== (data.clean ?? empty);
}
/** Run after each command: marks the data once they have changed. */
export function markChanged(session) {
  if (!session.data.dirty && changed(session)) session.data.dirty = true;
}
/**
 * Puts data a command has remade in memory. They are still the data of the
 * file they came from, now changed.
 */
/**
 * Puts data that collapse or reshape built in memory. Stata builds them in
 * a temporary file, so they are no longer the data of any file: describe
 * names none, and save needs a name.
 */
export function rebuilt(session, result) {
  result.filename = "";
  result.filedate = "";
  session.data = result;
}
export function remade(session, result) {
  result.filename = session.data.filename;
  result.filedate = session.data.filedate;
  session.data = result;
}
/** A dataset's file, its time stamp and its contents as they were read. */
export function settle(data, name, stamp) {
  data.filename = name;
  data.filedate = stamp ?? "";
  data.clean = fingerprint(data);
  data.dirty = false;
}
/**
 * A line of output as Stata shows it when it is longer than the linesize:
 * cut at the linesize, the rest on lines that start with "> ".
 */
export function fold(line, linesize) {
  const chars = [...line],
    width = Math.max(linesize, 3);
  if (chars.length <= width) return [line];
  const lines = [chars.slice(0, width).join("")];
  for (let at = width; at < chars.length; at += width - 2)
    lines.push("> " + chars.slice(at, at + width - 2).join(""));
  return lines;
}
// The time stamp Stata writes into a dataset: 13 Nov 2026 17:08.
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
function stampNow(now = new Date()) {
  const two = (k) => String(k).padStart(2, "0");
  return `${two(now.getDate())} ${MONTHS[now.getMonth()]} ${now.getFullYear()} ${two(now.getHours())}:${two(now.getMinutes())}`;
}
const copy = (value) =>
  value === undefined ? undefined : structuredClone(value);

export function load(session, name) {
  const stored = files(session).get(findFile(files(session), name));
  if (!stored) throw new StataError(`file ${name} not found`, 601);
  if (typeof stored.text === "string")
    throw new StataError(
      `${name} is a text file, not a Stata dataset; use import delimited`,
      610,
    );
  // A workbook, SPSS or SAS file added to the folder is kept as its bytes,
  // and a picture written by graph export as its own kind of file.
  if (stored.bytes instanceof Uint8Array || !Array.isArray(stored.variables))
    throw new StataError(`file ${name} not Stata format`, 610);
  const data = new Dataset({ defaultType: session.data.defaultType });
  data.restore(stored);
  data.defaultType = session.data.defaultType;
  // Notes and characteristics are the file's own; the copy in memory may
  // change without changing the file.
  for (const key of ["notes", "chars"])
    if (stored[key] !== undefined) data[key] = copy(stored[key]);
  delete data.timestamp;
  data.filedate = stored.timestamp ?? "";
  return data;
}

function save(session, text, ctx) {
  const data = session.data,
    parsed = session.parse(
      "[anything] [, replace EMPTYok noLabel ORPHANS]",
      // save using saves using.dta.
      text.replace(/^(\s*)using(?=\s*(,|$))/, '$1"using"'),
    ),
    name = fileName(parsed.anything || data.filename || ""),
    store = files(session);
  if (store.has(name) && !parsed.options.replace)
    throw new StataError(`file ${name} already exists`, 602);
  if (!data.variables.length && !parsed.options.emptyok)
    throw new StataError("no variables defined", 111);
  if (!data.n && parsed.options.emptyok)
    ctx.out("(dataset contains 0 observations)");
  if (parsed.options.replace && !store.has(name))
    ctx.out(`(file ${name} not found)`);
  const stamp = stampNow(),
    snapshot = data.snapshot(),
    used = new Set(data.variables.map((v) => v.valueLabel));
  // The file keeps the value labels a variable uses (all of them with
  // orphans, none with nolabel), the most recently defined first, so that
  // they come back from the file in the opposite order, as Stata's do.
  snapshot.valueLabels = new Map(
    parsed.options.label === false
      ? []
      : [...snapshot.valueLabels]
          .filter(([label]) => parsed.options.orphans || used.has(label))
          .reverse(),
  );
  store.set(name, {
    ...snapshot,
    notes: copy(data.notes),
    chars: copy(data.chars),
    timestamp: stamp,
  });
  settle(data, name, stamp);
  ctx.out(`file ${name} saved`);
}

/**
 * use filename [if] [in] [, clear nolabel], and use varlist [if] [in] using
 * filename [, clear nolabel]. As in Stata, the data in memory are gone once
 * the file is open: an error in the varlist, the if or the in leaves no data.
 */
function use(session, text, ctx) {
  if (/^\s*using\s*(,|$)/.test(text))
    throw invalid("invalid file specification");
  const [head] = splitAtComma(text),
    // Observation numbers are checked before the file is opened: use takes
    // none below 1 (no counting from the end) and no range that runs
    // backward. Whether they lie in the file is known once it is open.
    range = /(?:^|\s)in\s+(-?\w+)(?:\s*\/\s*(-?\w+))?/.exec(
      head.replace(/`"[\s\S]*?"'|"[^"]*"/g, '""'),
    );
  if (range) {
    const bound = (word) =>
      /^[fF]$/.test(word) ? 1 : /^[lL]$/.test(word) ? Infinity : Number(word);
    for (const word of [range[1], range[2]])
      if (word !== undefined && /^-?\d+$/.test(word) && Number(word) < 1)
        throw invalid(`'${word}' invalid observation number`);
    if (range[2] !== undefined && bound(range[1]) > bound(range[2]))
      throw invalid("observation numbers out of range");
  }
  const form = applySyntax(
      "[anything] [if] [in] [using/] [, clear NOLabel]",
      text,
      { n: Number.MAX_SAFE_INTEGER },
    ),
    name = fileName(form.using ?? form.anything),
    data = load(session, name);
  if (changed(session) && !form.options.clear)
    throw new StataError(
      "no; dataset in memory has changed since last saved",
      4,
    );
  if (data.label)
    fold(`(${data.label})`, session.settings.linesize ?? 80).forEach(ctx.out);
  const cleared = new Dataset({ defaultType: session.data.defaultType });
  session.data = data;
  try {
    if (form.using !== undefined && form.anything) {
      const names = session.varlist(form.anything),
        dropped = data.names.filter((name) => !names.includes(name));
      data.keep(names);
      for (const name of dropped) {
        data.notes?.delete?.(name);
        data.chars?.delete?.(name);
      }
    }
    // The if and the in are read against the variables that were kept.
    const start = form.anything
        ? head.indexOf(form.anything) + form.anything.length
        : 0,
      qualifiers = head
        .slice(start)
        .replace(/(?<![A-Za-z_0-9.])using\s+("[^"]*"|`"[^"]*"'|\S+)/, ""),
      parsed = session.parse("[if] [in]", qualifiers);
    if (parsed.if || parsed.in) data.reorder(session.rows(parsed, null));
  } catch (error) {
    session.data = cleared;
    throw error;
  }
  if (form.options.nolabel) data.valueLabels = new Map();
  settle(data, name, data.filedate);
}

// ----- append and merge -----
function widerType(a, b) {
  if (isStringType(a) !== isStringType(b)) return null;
  if (isStringType(a)) return stringWidth(a) >= stringWidth(b) ? a : b;
  return RANK[Math.max(RANK.indexOf(a), RANK.indexOf(b))];
}
/**
 * The storage type append and merge give a variable both datasets have: the
 * smallest that holds the values of both. A float and a long need a double.
 */
function combinedType(a, b) {
  if (a === b) return a;
  if (isStringType(a))
    return a === "strL" || b === "strL"
      ? "strL"
      : stringWidth(a) >= stringWidth(b)
        ? a
        : b;
  const integers = ["byte", "int", "long"],
    ia = integers.indexOf(a),
    ib = integers.indexOf(b);
  if (ia >= 0 && ib >= 0) return integers[Math.max(ia, ib)];
  if (a === "double" || b === "double") return "double";
  return a === "long" || b === "long" ? "double" : "float";
}
/** An SMCL {p 4 4 2} paragraph: words wrapped two short of the line. */
function paragraph(session, text) {
  const width = (session.settings.linesize ?? 80) - 2,
    lines = [];
  let line = "    ";
  for (const word of text.split(" ")) {
    if (line.trim() && line.length + 1 + word.length > width) {
      lines.push(line.trimEnd());
      line = "    ";
    }
    line += (line.trim() ? " " : "") + word;
  }
  lines.push(line.trimEnd());
  return lines.join("\n");
}
/**
 * Settles the variables the master and using data share before append or
 * merge combines them. A string variable in one and a numeric one in the
 * other is an error unless force, which treats the using values as empty.
 * Otherwise the master variable is widened to hold the using values. The
 * value labels of the using data come along, except those the master data
 * already define. Returns the names whose using values are dropped.
 */
function reconcile(session, command, data, other, names, options, ctx) {
  const shared = data.variables.filter((v) => names.includes(v.name)),
    ignored = new Set(),
    widened = [];
  for (const variable of shared) {
    const theirs = other.get(variable.name);
    if (isStringType(theirs.type) === isStringType(variable.type)) continue;
    if (!options.force) {
      const text = isStringType(variable.type);
      throw new StataError(
        `variable ${variable.name} is ${variable.type} in master but ${theirs.type} in using data\n` +
          paragraph(
            session,
            `You could specify ${command}'s force option to ignore this ${text ? "string/numeric" : "numeric/string"} mismatch.  The using variable would then be treated as if it contained ${text ? '""' : "numeric missing value"}.`,
          ),
        106,
      );
    }
    ignored.add(variable.name);
  }
  for (const name of ignored)
    ctx.out(
      `(note: variable ${name} was ${other.get(name).type} in the using data, but will be ${data.get(name).type} now)`,
    );
  for (const variable of shared) {
    if (ignored.has(variable.name)) continue;
    const type = combinedType(variable.type, other.get(variable.name).type);
    if (type === variable.type) continue;
    ctx.out(
      `(variable ${variable.name} was ${variable.type}, now ${type} to accommodate using data's values)`,
    );
    widened.push([variable, type]);
  }
  for (const [variable, type] of widened) data.retype(variable, type);
  if (!options.label) return ignored;
  // Every value label in the using file is read, whichever variables are
  // kept, and each one the master data already define is reported.
  for (const [name, map] of other.valueLabels)
    if (data.valueLabels.has(name)) ctx.out(`(label ${name} already defined)`);
    else data.valueLabels.set(name, new Map(map));
  return ignored;
}

/** The file names after using, each quoted or a single word. */
function usingFiles(text) {
  const names = (text.match(/`"[^"]*"'|"[^"]*"|\S+/g) ?? []).map(fileName);
  if (!names.length) throw invalid("invalid file specification");
  return names;
}

function append(session, text, ctx) {
  // append using takes one or more files.
  const [head, optionText] = splitAtComma(text),
    m = /^\s*using\b([\s\S]*)$/.exec(head);
  if (!m) throw new StataError("using required", 100);
  const parsed = session.parse(
      "[, GENerate(name) FORCE KEEP(string) noLabel | noNOTEs]",
      optionText === null ? "" : "," + optionText,
    ),
    names = usingFiles(m[1]),
    others = names.map((name) => load(session, name)),
    data = session.data,
    marker = parsed.options.generate;
  if (marker && data.has(marker))
    throw new StataError(`variable ${marker} already defined`, 110);
  const sorted = data.sortedBy;
  if (marker) {
    data.generate(marker, new Array(data.n).fill(0), { type: "byte" });
    const labelName = data.valueLabels.has("_append") ? "__append" : "_append";
    data.valueLabels.set(labelName, new Map([[0, "Master"]]));
    Object.assign(data.get(marker), {
      label: "Dataset source",
      valueLabel: labelName,
    });
  }
  others.forEach((other, k) => {
    const n = data.n,
      kept = parsed.options.keep
        ? expand(parsed.options.keep, other.names)
        : other.names,
      ignored = reconcile(
        session,
        "append",
        data,
        other,
        kept,
        { force: parsed.options.force, label: parsed.options.label !== false },
        ctx,
      ),
      total = n + other.n;
    for (const variable of data.variables) {
      const text = isStringType(variable.type),
        fill = text ? "" : MISSING,
        values = text ? variable.data.slice() : Array.from(variable.data);
      while (values.length < total) values.push(fill);
      if (kept.includes(variable.name) && !ignored.has(variable.name)) {
        const theirs = other.get(variable.name);
        for (let i = 0; i < other.n; i++) values[n + i] = theirs.data[i];
      }
      variable.data = text ? values : Float64Array.from(values);
    }
    data.n = total;
    if (marker) {
      const column = data.get(marker).data;
      for (let i = n; i < total; i++) column[i] = k + 1;
      data.valueLabels
        .get(data.get(marker).valueLabel)
        .set(k + 1, `Appended dataset ${k + 1}`);
    }
    for (const name of kept) {
      if (data.has(name)) continue;
      const theirs = other.get(name),
        text = isStringType(theirs.type),
        values = new Array(n)
          .fill(text ? "" : MISSING)
          .concat(Array.from(theirs.data));
      data.generate(name, values, { type: theirs.type, string: text });
      Object.assign(data.get(name), {
        format: theirs.format,
        label: theirs.label,
        valueLabel: theirs.valueLabel,
      });
    }
  });
  if (marker) {
    // label values widens the format to the longest label.
    const longest = greatest(
      [...data.valueLabels.get(data.get(marker).valueLabel).values()].map(
        byteLength,
      ),
    );
    data.get(marker).format = `%${Math.max(8, longest)}.0g`;
  }
  data.sortedBy = others.some((other) => other.n) ? [] : sorted;
}

// ----- merge -----
// The words merge's assert() and keep() take, each with the shortest
// abbreviation merge.ado allows.
const MERGE_RESULTS = [
  [1, "masters", 3],
  [2, "usings", 2],
  [3, "matches", 3],
  [3, "matched", 3],
  [4, "match_updates", 8],
  [5, "match_conflicts", 8],
];
const MERGE_TEXT = [
  "",
  "from master",
  "from using",
  "matched",
  "matched and updated",
  "matched and conflicting",
];
function mergeResult(session, word) {
  if (/^[1-5]$/.test(word)) return Number(word);
  const hit = MERGE_RESULTS.find(
    ([, full, least]) =>
      word.length >= least &&
      full.slice(0, Math.max(least, word.length)) === word,
  );
  if (hit) return hit[0];
  throw new StataError(
    `${word}:  invalid resulttype\n` +
      paragraph(
        session,
        "results, specified in options assert() and keep(), are the integers 1 through 5, or master (equivalent to 1), using (2), match (3), match_update (4), or match_conflict (5).  The last two arise only when option update is specified.",
      ),
    198,
  );
}
/** Words laid out as Stata's {p 0 4 2} paragraph. */
function hanging(session, text) {
  const width = (session.settings.linesize ?? 80) - 2,
    lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line.trim() && line.length + 1 + word.length > width) {
      lines.push(line);
      line = "    " + word;
    } else line += (line.trim() ? " " : "") + word;
  }
  lines.push(line);
  return lines.join("\n");
}
function merge(session, text, ctx) {
  const m = /^\s*(1:1|m:1|1:m|m:m)\s+([\s\S]*)$/.exec(text);
  if (!m) throw invalid("merge needs 1:1, m:1, 1:m or m:m");
  if (m[1] === "m:m")
    throw invalid("merge m:m is not available; it rarely does what is wanted");
  // merge 1:1 _n is a sequential merge: observation i with observation i.
  const sequential = /^\s*_n(?=[\s,]|$)/.test(m[2]);
  if (sequential && m[1] !== "1:1")
    throw invalid(
      `${m[1]} _n invalid\n    the syntax for a sequential merge is merge 1:1 _n ...\n    the syntax for a ${m[1]} match merge is merge ${m[1]} varlist ...`,
    );
  let rest = sequential ? m[2].replace(/^\s*_n/, "") : m[2];
  // using is a reserved word, so the first one starts the file name, which
  // may itself be called using.dta.
  rest = rest.replace(
    /(^|\s)using\s+([^\s",`]+)/,
    (whole, before, name) => `${before}using "${name}"`,
  );
  const parsed = session.parse(
      `${sequential ? "" : "varlist "}using/ [, KEEPUSing(string) GENerate(name) noGENerate KEEP(string) ASSERT(string) NOREPort UPDATE REPLACE FORCE noLabel | SORTED noNOTEs]`,
      rest,
    ),
    data = session.data,
    keys = sequential ? [] : parsed.varlist,
    update = !!parsed.options.update,
    noMarker = /\bnogen/.test(splitAtComma(m[2])[1] ?? ""),
    marker =
      typeof parsed.options.generate === "string"
        ? parsed.options.generate
        : "_merge";
  const results = (option) =>
      parsed.options[option]
        ? [
            ...new Set(
              parsed.options[option]
                .trim()
                .split(/\s+/)
                .map((word) => mergeResult(session, word)),
            ),
          ].sort()
        : null,
    asserted = results("assert"),
    kept = results("keep");
  if (parsed.options.replace && !update)
    throw new StataError(
      "option replace not allowed\n" +
        paragraph(
          session,
          "option replace requires you also specify option update, thus demonstrating your understanding that an update will be performed",
        ),
      198,
    );
  if (!noMarker && data.has(marker))
    throw new StataError(`variable ${marker} already defined`, 110);
  // Stata sorts the master data on the key before it reads the using data.
  if (!sequential) data.sort(keys);
  const other = load(session, fileName(parsed.using));
  for (const key of keys) {
    if (!other.has(key)) throw new StataError(`variable ${key} not found`, 111);
    if (isStringType(other.get(key).type) !== isStringType(data.get(key).type))
      throw new StataError(
        `key variable ${key} is str in one dataset and numeric in the other`,
        106,
      );
  }
  if (!sequential) other.sort(keys);
  const keyOf = (set, i) =>
      sequential
        ? String(i)
        : JSON.stringify(keys.map((k) => set.get(k).data[i])),
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
      ? [
          ...new Set([
            ...keys,
            ...expand(parsed.options.keepusing, other.names),
          ]),
        ]
      : other.names,
    shared = wanted.filter((name) => data.has(name)),
    brought = wanted.filter((name) => !data.has(name));
  // The master variables are widened before the data are combined.
  const ignored = reconcile(
    session,
    "merge",
    data,
    other,
    wanted,
    { force: parsed.options.force, label: parsed.options.label !== false },
    ctx,
  );
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
  // With update, a matched row's missing master values take different
  // using values (_merge 4); one where both have different nonmissing values is
  // a conflict (_merge 5), which replace settles in favour of the using
  // data.
  const updated = update
      ? shared.filter((name) => !keys.includes(name) && !ignored.has(name))
      : [],
    empty = (value) =>
      typeof value === "string" ? value === "" : isMissing(value);
  for (const row of all) {
    row.code = row.master === null ? 2 : row.using === null ? 1 : 3;
    if (row.code !== 3 || !updated.length) continue;
    row.take = [];
    let filled = false,
      conflict = false;
    for (const name of updated) {
      const mine = data.get(name).data[row.master],
        theirs = other.get(name).data[row.using];
      // A missing master value takes any different using value, even
      // another missing value such as .a; a missing using value never
      // replaces a nonmissing one.
      if (empty(mine)) {
        if (mine === theirs) continue;
        filled = true;
        row.take.push(name);
      } else if (empty(theirs)) continue;
      else if (mine !== theirs) {
        conflict = true;
        if (parsed.options.replace) row.take.push(name);
      }
    }
    row.code = conflict ? 5 : filled ? 4 : 3;
  }
  // assert() is checked before keep() takes effect; a failure leaves the
  // merged result in memory.
  const failed = asserted && all.some((row) => !asserted.includes(row.code));
  if (kept && !failed) all = all.filter((row) => kept.includes(row.code));
  // The report counts what is kept.
  const tally = [0, 0, 0, 0, 0, 0];
  for (const row of all) tally[row.code]++;
  const result = new Dataset({ defaultType: data.defaultType });
  result.n = all.length;
  result.label = data.label;
  result.valueLabels = data.valueLabels;
  for (const variable of data.variables) {
    const text = isStringType(variable.type),
      theirs =
        shared.includes(variable.name) && !ignored.has(variable.name)
          ? other.get(variable.name)
          : null,
      // A row with a master observation keeps the master's values unless
      // update takes the using value; a using-only row takes shared
      // variables from the using data.
      values = all.map((row) =>
        row.master !== null && !row.take?.includes(variable.name)
          ? variable.data[row.master]
          : theirs && row.using !== null
            ? theirs.data[row.using]
            : text
              ? ""
              : MISSING,
      );
    result.generate(variable.name, values, {
      type: variable.type,
      string: text,
    });
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
  if (!noMarker) {
    result.generate(
      marker,
      all.map((row) => row.code),
      { type: "byte" },
    );
    if (!result.valueLabels.has("_merge"))
      result.valueLabels.set(
        "_merge",
        new Map([
          [1, "Master only (1)"],
          [2, "Using only (2)"],
          [3, "Matched (3)"],
          [4, "Missing updated (4)"],
          [5, "Nonmissing conflict (5)"],
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
  remade(session, result);
  if (failed) {
    const words = asserted.map((code) => MERGE_TEXT[code]),
      list =
        words.length === 1
          ? words[0]
          : words.length === 2
            ? `${words[0]} or ${words[1]}`
            : `${words.slice(0, -1).join(", ")}, or ${words.at(-1)}`;
    throw new StataError(
      `${hanging(session, `after merge, not all observations ${list}`)}\n(merged result left in memory)`,
      9,
    );
  }
  if (!parsed.options.noreport) {
    const line = (label, n, code) =>
      ctx.out(
        `${label.padEnd(29)}${count(n).padStart(16)}${noMarker || !code ? "" : `  (${marker}==${code})`}`,
      );
    ctx.out("");
    ctx.out("    Result                      Number of obs");
    ctx.out("    -----------------------------------------");
    line("    Not matched", tally[1] + tally[2]);
    if (tally[1] + tally[2]) {
      line("        from master", tally[1], 1);
      line("        from using", tally[2], 2);
      ctx.out("");
    }
    if (!update) line("    Matched", tally[3], 3);
    else {
      if (!tally[1] && !tally[2]) ctx.out("");
      line("    Matched", tally[3] + tally[4] + tally[5]);
      line("        not updated", tally[3], 3);
      line("        missing updated", tally[4], 4);
      line("        nonmissing conflict", tally[5], 5);
    }
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
// reshape follows reshape.ado. Its settings (i, j, the xij stubs) are
// characteristics of the data, as Stata keeps them in _dta[ReS_*], so they
// travel with the data through save and use and vanish when the data are
// cleared. Labels saved before a reshape wide are characteristics too, and
// come back on the next reshape long.

/** reshape.ado's picture of long and wide data. */
const RESHAPE_PICTURE = [
  "         long                                wide",
  "        +---------------+                   +------------------+",
  "        | i   j   a   b |                   | i   a1 a2  b1 b2 |",
  "        |---------------| <--- reshape ---> |------------------|",
  "        | 1   1   1   2 |                   | 1   1   3   2  4 |",
  "        | 1   2   3   4 |                   | 2   5   7   6  8 |",
  "        | 2   1   5   6 |                   +------------------+",
  "        | 2   2   7   8 |",
  "        +---------------+",
];
const reshapePicture = (commands) => [
  ...RESHAPE_PICTURE,
  ...(commands
    ? [
        "",
        "        long to wide: reshape wide a b, i(i) j(j)    (j existing variable)",
        "        wide to long: reshape long a b, i(i) j(j)    (j new variable)",
      ]
    : []),
];

/** reshape's report, as reshape.ado's Report1, ReportL and ReportW print it. */
function reshapeReport(ctx, direction, before, after, j, levelCount, pairs) {
  const rule = "-".repeat(77),
    from = direction === "wide" ? "Long" : "Wide",
    to = direction === "wide" ? "Wide" : "Long",
    // display's _col(#) pads to a column, or adds nothing once past it.
    col = (line, at) => line.padEnd(at - 1),
    arrow = (line, right) => `${col(col(line, 43) + "->", 48)}${right}`,
    counts = (label, a, b) =>
      ctx.out(arrow(`${col(label, 28)}${count(a).padStart(12)}`, count(b)));
  ctx.out("");
  ctx.out(arrow(`${col("Data", 36)}${from}`, to));
  ctx.out(rule);
  counts("Number of observations", before.n, after.n);
  counts("Number of variables", before.k, after.k);
  const head = `j variable (${levelCount} values)`;
  ctx.out(
    direction === "wide"
      ? arrow(`${col(head, 31 + (9 - j.length))}${j}`, "(dropped)")
      : arrow(head, j),
  );
  ctx.out("xij variables:");
  for (const [left, right] of pairs)
    ctx.out(
      arrow(`${" ".repeat(Math.max(0, 39 - left.length))}${left}`, right),
    );
  ctx.out(rule);
}
/** The wide names of a stub, as reshape lists them: three, or two ... last. */
const someNames = (names) =>
  names.length <= 3
    ? names.join(" ")
    : `${names[0]} ${names[1]} ... ${names.at(-1)}`;
/** Subname: the stub with its @, or its end, replaced by a value. */
const subname = (stub, value) => {
  const at = stub.indexOf("@");
  return at < 0 ? stub + value : stub.slice(0, at) + value + stub.slice(at + 1);
};
/** A line of plain display output, broken where Stata breaks it. */
function displayLine(session, ctx, text) {
  const width = session.settings.linesize ?? 80;
  ctx.out(text.slice(0, width));
  for (let rest = text.slice(width); rest; rest = rest.slice(width - 2))
    ctx.out("> " + rest.slice(0, width - 2));
}
// reshape's settings and saved labels, which Stata keeps as _dta
// characteristics, are kept beside the data and travel with them.
const reshapeChars = (data) => (data.reshapeChars ??= {});

/**
 * What describe, short leaves in r(), which reshape.ado runs before it
 * starts and again for its report: whether the data changed, the width of
 * an observation in bytes, and the numbers of variables and observations.
 */
function describeResults(session) {
  const bytes = { byte: 1, int: 2, long: 4, float: 4, double: 8 },
    data = session.data;
  session.results.r = {
    changed: changed(session) ? 1 : 0,
    width: data.variables.reduce(
      (total, v) =>
        total +
        (bytes[v.type] ?? (v.type === "strL" ? 8 : Number(v.type.slice(3)))),
      0,
    ),
    k: data.variables.length,
    N: data.n,
  };
}

/** reshape i, j, xij and the options of reshape long and wide set these. */
function reshapeJ(words, string) {
  const values = [];
  let text = !!string;
  for (let k = 0; k < words.length; k++) {
    if (words[k + 1] === "-") {
      const [a, b] = [words[k], words[k + 2]];
      if (!/^-?\d+$/.test(a ?? "") || !/^-?\d+$/.test(b ?? "")) throw invalid();
      if (Number(a) >= Number(b))
        throw new StataError(`${a}-${b}: invalid range`, 198);
      for (let v = Number(a); v <= Number(b); v++) values.push(String(v));
      k += 2;
    } else {
      if (!/^-?\d+$/.test(words[k])) text = true;
      values.push(words[k]);
    }
  }
  return { values, text };
}
function checkJ(data, j, text) {
  if (!data.has(j)) return;
  const string = isStringType(data.get(j).type);
  if (string && !text)
    throw new StataError(`variable ${j} is string; specify option string`, 109);
  if (!string && text) throw new StataError(`variable ${j} is numeric`, 109);
}

/** Simple: reshape long|wide stubs, i() j() sets the characteristics. */
function reshapeSimple(session, direction, text) {
  const [head, optionText] = splitAtComma(text),
    list = head.trim().split(/\s+/).filter(Boolean),
    data = session.data;
  if (!list.length) throw invalid();
  const required = (option, blank) =>
    new StataError(
      [`option ${option}() required`, ...(blank ? [""] : [])]
        .concat(reshapePicture(true))
        .join("\n"),
      198,
    );
  if (optionText === null) throw required("i", true);
  const options = session.parse(
    "[, I(string) J(string) ATwl(string) String favor(string)]",
    "," + optionText,
  ).options;
  if (!options.i?.trim()) throw required("i", true);
  if (
    options.favor !== undefined &&
    !/^(speed|memory)$/.test(options.favor.trim())
  )
    throw invalid(`favor(${options.favor}) invalid`);
  const ids = session.varlist(options.i);
  // The j option is a variable name followed by any values it takes.
  const jWords = (options.j ?? "")
    .replace(/-/g, " - ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let j = jWords[0] ?? "_j",
    stubs = list;
  if (direction === "wide") {
    try {
      stubs = session.varlist(list.join(" "));
    } catch {
      stubs = list;
    }
    try {
      j = session.varlist(j)[0];
    } catch (error) {
      if (!(error instanceof StataError) || error.code !== 111) throw error;
      if (j === "_j")
        throw new StataError(
          ["option j() required", ...reshapePicture(true)].join("\n"),
          198,
        );
      throw new StataError(
        `variable ${j} not found\n    Data are already wide.`,
        111,
      );
    }
  } else {
    if (data.has(j))
      throw new StataError(
        `variable ${j} already exists\n    Data are already long.`,
        110,
      );
    if (!isName(j)) throw new StataError(`${j} invalid name`, 198);
  }
  const { values, text: isText } = reshapeJ(jWords.slice(1), options.string);
  checkJ(data, j, isText);
  const chars = reshapeChars(data);
  chars.reshape = {
    i: ids,
    j,
    jv: values,
    str: isText,
    xij: stubs,
    xi: null,
    atwl: options.atwl?.trim() ?? "",
  };
}

/** Macros0 and Macros: the settings, checked; NotDefd when one is missing. */
function reshapeMacros(session) {
  const data = session.data,
    spec = data.reshapeChars?.reshape,
    notDefined = (what) =>
      spec
        ? new StataError(`${what} not defined`, 111)
        : new StataError(
            [
              "data have not been reshaped yet",
              paragraph(
                session,
                "What you typed is a syntax error because the data have not been reshaped previously. The basic syntax of reshape is",
              ),
              "",
              ...reshapePicture(true),
            ].join("\n"),
            111,
          );
  if (!spec?.j) throw notDefined("reshape j");
  const { j } = spec;
  if (data.has(j)) {
    checkJ(data, j, spec.str);
    const values = data.get(j).data,
      missing = new StataError(`variable ${j} contains missing values`, 498);
    if (!spec.str) {
      if (Array.from(values).some(isMissing)) throw missing;
    } else {
      if (values.some((v) => v.trim() === "")) throw missing;
      if (values.some((v) => v !== v.trim()))
        throw new StataError(
          `variable ${j} has leading or trailing blanks`,
          498,
        );
    }
  }
  if (!spec.i?.length) throw notDefined("reshape i");
  if (!spec.xij?.length) throw notDefined("reshape xij");
  return {
    ...spec,
    vans: spec.xij.map((stub) => subname(stub, spec.atwl)),
  };
}

/** Tab: the values of j, as "(j = ...)" shows them. */
function reshapeTab(session, ctx, spec, values, text) {
  let levels;
  if (!text) {
    const present = values.filter((v) => !isMissing(v));
    levels = [...new Set(present)]
      .sort((a, b) => a - b)
      .map((v) => formatNumber(v));
    // Tab finds the values with tabulate, which leaves r(N) and r(r).
    session.results.r = { N: present.length, r: levels.length };
  } else {
    levels = [...new Set(values.filter((v) => v !== ""))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (levels.some((level) => /\s/.test(level.trim())))
      throw new StataError(
        `string j variable ${spec.j} not allowed to contain spaces;\n` +
          paragraph(
            session,
            `encode string variable ${spec.j} into a numeric variable and use the new numeric variable as the j variable`,
          ),
        111,
      );
    levels = levels.map((level) => level.trim());
  }
  displayLine(session, ctx, `(j = ${levels.join(" ")})`);
  return levels;
}

/** Macros2: the j values and the variables constant within i. */
function reshapeLevels(session, ctx, spec) {
  const data = session.data,
    long = data.has(spec.j);
  let levels = spec.jv;
  if (!levels.length) {
    if (long)
      levels = reshapeTab(
        session,
        ctx,
        spec,
        Array.from(data.get(spec.j).data),
        spec.str,
      );
    else {
      // FillvalW: the part of each name that the @ (or the end) stands for.
      const middle = new Map();
      for (const stub of spec.xij) {
        const at = stub.includes("@") ? stub.indexOf("@") : stub.length,
          left = stub.slice(0, at),
          right = stub.slice(at + 1);
        for (const name of data.names)
          if (
            name.length > left.length + right.length &&
            name.startsWith(left) &&
            name.endsWith(right)
          )
            middle.set(name, name.slice(at, name.length - right.length));
      }
      if (!middle.size)
        throw new StataError(
          [
            "no xij variables found",
            "    You typed something like reshape wide a b, i(i) j(j).",
            paragraph(
              session,
              "reshape looked for existing variables named a# and b# but could not find any. Remember this picture:",
            ),
            "",
            ...reshapePicture(true),
          ].join("\n"),
          111,
        );
      const found = [...middle.values()];
      levels = reshapeTab(
        session,
        ctx,
        spec,
        spec.str
          ? found
          : found.map((text) =>
              /^\d+(e\d+)?$/i.test(text) ? Number(text) : MISSING,
            ),
        spec.str,
      );
    }
  }
  // FillXi: without reshape xi, every other variable is constant within i.
  let xi = spec.xi;
  if (!xi) {
    const used = new Set([spec.j, ...spec.i]);
    if (long) for (const name of spec.vans) used.add(name);
    else
      for (const stub of spec.xij)
        for (const level of levels) used.add(subname(stub, level));
    xi = data.names.filter((name) => !used.has(name));
  }
  return { levels, xi };
}

/** A copy of the data, to work on without touching what is in memory. */
function workingCopy(data) {
  const copy = new Dataset({ defaultType: data.defaultType });
  copy.restore(data.snapshot());
  return copy;
}
/** Groups of observations with the same values of names, in sorted data. */
function runsOf(data, names) {
  const columns = names.map((name) => data.get(name).data),
    groups = [];
  for (let i = 0; i < data.n; i++) {
    const last = groups.at(-1);
    if (last && columns.every((column) => column[i] === column[i - 1]))
      last.count++;
    else groups.push({ start: i, count: 1 });
  }
  return groups;
}

/** SaveCharsForLong: the labels of j and of the xij variables. */
function saveCharsForLong(data, spec) {
  const saved = (reshapeChars(data).labels ??= { xij: {} }),
    j = data.get(spec.j);
  if (j.valueLabel) {
    saved.jValLabName = j.valueLabel;
    const map = data.valueLabels.get(j.valueLabel);
    if (map)
      saved.jValLab = [...map].filter(([value]) => Number.isInteger(value));
  }
  if (j.label) saved.jVarLab = j.label;
  for (const name of spec.vans)
    if (data.has(name) && data.get(name).label)
      saved.xij[name] = data.get(name).label;
}
/** ApplyCharsForLong: those labels, put back once the data are long. */
function applyCharsForLong(result, spec) {
  const saved = result.reshapeChars?.labels;
  if (!saved) return;
  const j = result.get(spec.j);
  if (saved.jValLabName && !spec.str) {
    if (!result.valueLabels.has(saved.jValLabName))
      result.valueLabels.set(saved.jValLabName, new Map(saved.jValLab ?? []));
    j.valueLabel = saved.jValLabName;
    delete saved.jValLabName;
    delete saved.jValLab;
  }
  if (saved.jVarLab) {
    j.label = saved.jVarLab;
    delete saved.jVarLab;
  }
  for (const name of spec.vans)
    if (saved.xij[name] !== undefined) {
      result.get(name).label = saved.xij[name];
      delete saved.xij[name];
    }
}

function reshapeWide(session, ctx) {
  describeResults(session);
  const data = session.data,
    before = { n: data.n, k: data.variables.length },
    spec = reshapeMacros(session);
  if (!data.has(spec.j)) {
    ctx.out("(data are already wide)");
    return;
  }
  for (const name of [spec.j, ...spec.vans, ...spec.i, ...(spec.xi ?? [])])
    data.get(name);
  if (data.has("_merge"))
    throw new StataError(
      "cannot reshape data containing variable _merge\n    Either drop or rename variable _merge.",
      110,
    );
  saveCharsForLong(data, spec);
  const { levels, xi } = reshapeLevels(session, ctx, spec),
    work = workingCopy(data),
    i = spec.i.join(" ");
  // Veruniq: i and j identify the observations, and the other variables
  // are constant within i.
  work.sort([...spec.i, spec.j]);
  if (runsOf(work, [...spec.i, spec.j]).some((group) => group.count > 1))
    throw new StataError(
      [
        `values of variable ${spec.j} not unique within ${i}`,
        paragraph(
          session,
          `Your data are currently long. You are performing a reshape wide. You specified i(${i}) and j(${spec.j}). There are observations within i(${i}) with the same value of j(${spec.j}). In the long data, variables i() and j() together must uniquely identify the observations.`,
        ),
        "",
        ...reshapePicture(false),
        paragraph(
          session,
          "Type reshape error for a list of the problem variables.",
        ),
      ].join("\n"),
      9,
    );
  const groups = runsOf(work, spec.i),
    varying = xi.filter((name) =>
      groups.some((group) => {
        const column = work.get(name).data;
        for (let r = group.start + 1; r < group.start + group.count; r++)
          if (column[r] !== column[group.start]) return true;
        return false;
      }),
    );
  if (varying.length)
    throw new StataError(
      [
        ...varying.map((name) => `variable ${name} not constant within ${i}`),
        paragraph(
          session,
          "Your data are currently long. You are performing a reshape wide. You typed something like",
        ),
        "",
        `        . reshape wide a b, i(${i}) j(${spec.j})`,
        "",
        paragraph(
          session,
          `There are variables other than a, b, ${i}, ${spec.j} in your data. They must be constant within ${i} because that is the only way they can fit into wide data without loss of information.`,
        ),
        "",
        paragraph(
          session,
          `The variable or variables listed above are not constant within ${i}. Perhaps the values are in error. Type reshape error for a list of the problem observations.`,
        ),
        "",
        paragraph(
          session,
          "Either that, or the values vary because they should vary, in which case you must either add the variables to the list of xij variables to be reshaped, or drop them.",
        ),
      ].join("\n"),
      9,
    );
  const result = new Dataset({ defaultType: data.defaultType });
  result.valueLabels = data.valueLabels;
  result.label = data.label;
  result.chars = data.chars;
  result.reshapeChars = data.reshapeChars;
  result.n = groups.length;
  const copy = (variable, values, name = variable.name) => {
    result.generate(name, values, {
      type: variable.type,
      string: isStringType(variable.type),
    });
    Object.assign(result.get(name), {
      format: variable.format,
      label: variable.label,
      valueLabel: variable.valueLabel,
    });
  };
  for (const id of spec.i)
    copy(
      work.get(id),
      groups.map((group) => work.get(id).data[group.start]),
    );
  const jColumn = work.get(spec.j).data,
    // The stubs go in the order of the data, as Widefix renames them.
    stubs = data.names.filter((name) => spec.vans.includes(name)),
    shown = [];
  for (const level of levels) {
    const match = spec.str ? level : Number(level),
      at = groups.map((group) => {
        for (let r = group.start; r < group.start + group.count; r++)
          if (jColumn[r] === match) return r;
        return -1;
      });
    if (at.every((r) => r < 0)) {
      ctx.out(`(no data for ${spec.j} == ${level})`);
      continue;
    }
    shown.push(level);
    for (const van of stubs) {
      const stub = spec.xij[spec.vans.indexOf(van)],
        name = subname(stub, level),
        source = work.get(van),
        text = isStringType(source.type);
      if (result.has(name))
        throw new StataError(`variable ${name} already defined`, 110);
      if (!isName(name))
        throw new StataError(`${name} invalid variable name`, 198);
      copy(
        source,
        at.map((r) => (r < 0 ? (text ? "" : MISSING) : source.data[r])),
        name,
      );
      result.get(name).label = `${level} ${van}`;
    }
  }
  for (const name of xi)
    copy(
      work.get(name),
      groups.map((group) => work.get(name).data[group.start]),
    );
  result.sortedBy = [...spec.i];
  rebuilt(session, result);
  // reshape.ado builds wide data in a file it then uses, so without
  // variables constant within i Stata counts them as unchanged since saved.
  if (!xi.length) {
    result.clean = fingerprint(result);
    result.dirty = false;
  }
  describeResults(session);
  reshapeReport(
    ctx,
    "wide",
    before,
    { n: result.n, k: result.variables.length },
    spec.j,
    shown.length,
    spec.xij.map((stub, k) => [
      spec.vans[k],
      someNames(shown.map((level) => subname(stub, level))),
    ]),
  );
}

function reshapeLong(session, ctx) {
  describeResults(session);
  const data = session.data,
    before = { n: data.n, k: data.variables.length },
    spec = reshapeMacros(session);
  for (const name of [...spec.i, ...(spec.xi ?? [])]) data.get(name);
  if (data.has(spec.j)) {
    ctx.out("(data are already long)");
    return;
  }
  const { levels, xi } = reshapeLevels(session, ctx, spec),
    work = workingCopy(data);
  // Verluniq: i identifies the observations. reshape.ado names the
  // variable id whatever i is.
  work.sort(spec.i);
  if (runsOf(work, spec.i).some((group) => group.count > 1))
    throw new StataError(
      [
        "variable id does not uniquely identify the observations",
        paragraph(
          session,
          `Your data are currently wide. You are performing a reshape long. You specified i(${spec.i.join(" ")}) and j(${spec.j}). In the current wide form, variable ${spec.i.join(" ")} should uniquely identify the observations. Remember this picture:`,
        ),
        "",
        ...reshapePicture(false),
        paragraph(
          session,
          "Type reshape error for a list of the problem observations.",
        ),
      ].join("\n"),
      9,
    );
  // mkrtmpST: one storage type for each stub, wide enough for all of its
  // variables.
  const types = spec.xij.map((stub) => {
    let type = null;
    for (const level of levels) {
      const name = subname(stub, level);
      if (work.has(name)) {
        const next = type
          ? widerType(type, work.get(name).type)
          : work.get(name).type;
        if (!next)
          throw new StataError(
            `variable ${name} type mismatch with other ${stub} variables`,
            198,
          );
        type = next;
      } else if (name.length > 32)
        throw new StataError(`variable ${name} implied name too long`, 198);
    }
    return type ?? "byte";
  });
  const keep = new Set([...spec.i, ...xi]);
  for (const level of levels)
    spec.xij.forEach((stub, k) => {
      if (!work.has(subname(stub, level)))
        ctx.out(`(variable ${subname(stub, level)} not found)`);
      if (keep.has(spec.vans[k]))
        throw new StataError(`variable ${spec.vans[k]} already defined`, 110);
    });
  // The long data take the layout of the last value's data: i and j first,
  // then the kept variables in their order, each stub where its last wide
  // variable was, or at the end when that variable does not exist.
  const last = levels.at(-1),
    lastNames = new Map(spec.xij.map((stub, k) => [subname(stub, last), k])),
    order = [];
  for (const name of work.names)
    if (keep.has(name)) order.push({ name });
    else if (lastNames.has(name)) order.push({ stub: lastNames.get(name) });
  spec.xij.forEach((stub, k) => {
    if (!order.some((entry) => entry.stub === k)) order.push({ stub: k });
  });
  // The long data are sorted on i and j.
  const front = [...spec.i, spec.j],
    sortedLevels = [...levels].sort((a, b) =>
      spec.str ? (a < b ? -1 : a > b ? 1 : 0) : Number(a) - Number(b),
    ),
    rows = [];
  for (let r = 0; r < work.n; r++)
    for (const level of sortedLevels) rows.push([r, level]);
  const result = new Dataset({ defaultType: data.defaultType });
  result.valueLabels = data.valueLabels;
  result.label = data.label;
  result.chars = data.chars;
  result.reshapeChars = data.reshapeChars;
  result.n = rows.length;
  const jValues = rows.map(([, level]) => (spec.str ? level : Number(level)));
  const columns = new Map();
  columns.set(spec.j, () => {
    if (spec.str) {
      const width = Math.max(1, ...jValues.map(byteLength));
      result.generate(spec.j, jValues, { type: `str${width}`, string: true });
      result.get(spec.j).format = defaultFormat(`str${width}`);
    } else {
      result.generate(spec.j, jValues, { type: inferType(jValues) });
      result.get(spec.j).format = "%10.0g";
    }
  });
  for (const entry of order) {
    if (entry.name !== undefined) {
      const variable = work.get(entry.name);
      columns.set(entry.name, () => {
        result.generate(
          entry.name,
          rows.map(([r]) => variable.data[r]),
          { type: variable.type, string: isStringType(variable.type) },
        );
        Object.assign(result.get(entry.name), {
          format: variable.format,
          label: variable.label,
          valueLabel: variable.valueLabel,
        });
      });
    } else {
      const stub = spec.xij[entry.stub],
        name = spec.vans[entry.stub],
        type = types[entry.stub],
        text = isStringType(type),
        lastWide = work.has(subname(stub, last))
          ? work.get(subname(stub, last))
          : null;
      columns.set(name, () => {
        result.generate(
          name,
          rows.map(([r, level]) => {
            const wide = subname(stub, level);
            return work.has(wide)
              ? work.get(wide).data[r]
              : text
                ? ""
                : MISSING;
          }),
          { type, string: text },
        );
        Object.assign(result.get(name), {
          format: lastWide?.format ?? defaultFormat(type),
          label: "",
          valueLabel: lastWide?.valueLabel ?? "",
        });
      });
    }
  }
  for (const name of [
    ...front,
    ...[...columns.keys()].filter((n) => !front.includes(n)),
  ])
    columns.get(name)();
  result.sortedBy = [...front];
  applyCharsForLong(result, spec);
  rebuilt(session, result);
  describeResults(session);
  reshapeReport(
    ctx,
    "long",
    before,
    { n: result.n, k: result.variables.length },
    spec.j,
    levels.length,
    spec.xij.map((stub, k) => [
      someNames(levels.map((level) => subname(stub, level))),
      spec.vans[k],
    ]),
  );
}

/** reshape error: Qerror, QerrorW and QerrorL list the problem rows. */
function reshapeError(session, ctx) {
  const spec = reshapeMacros(session),
    data = session.data,
    { xi } = reshapeLevels(session, ctx, spec),
    i = spec.i.join(" "),
    show = (names, rows) => {
      const flag = "__000000";
      data.generate(
        flag,
        Array.from({ length: data.n }, (_, r) => (rows.has(r) ? 1 : 0)),
        { type: "byte" },
      );
      // list ends with a blank line; reshape.ado puts its own after it.
      const lines = [];
      try {
        list(session, `${names.join(" ")} if ${flag}`, {
          ...ctx,
          out: (line) => lines.push(line),
        });
        while (lines.at(-1) === "") lines.pop();
        lines.forEach((line) => ctx.out(line));
      } finally {
        data.variables = data.variables.filter((v) => v.name !== flag);
      }
    },
    intro = () => {
      ctx.out("");
      ctx.out(`i (${i}) indicates the top-level grouping such as subject id.`);
    };
  if (!data.has(spec.j)) {
    // QerrorL: the data are wide, so i should identify the observations.
    data.sort(spec.i);
    const bad = new Set();
    for (const group of runsOf(data, spec.i))
      if (group.count > 1)
        for (let r = group.start; r < group.start + group.count; r++)
          bad.add(r);
    if (!bad.size) {
      ctx.out(`${i} is unique; there is no problem on this score`);
      return;
    }
    intro();
    ctx.out("");
    ctx.out(
      "The data are currently in the wide form; there should be a single",
    );
    ctx.out("observation per i.");
    ctx.out("");
    ctx.out(`${bad.size} of ${data.n} observations have duplicate i values:`);
    show(spec.i, bad);
    ctx.out("");
    ctx.out(`(data now sorted by ${i})`);
    return;
  }
  // QerrorW: the data are long, so i and j should identify them.
  for (const name of [spec.j, ...spec.vans, ...spec.i, ...xi]) data.get(name);
  const keys = [...spec.i, spec.j],
    message = () => {
      intro();
      ctx.out(`j (${spec.j}) indicates the subgrouping such as time.`);
    };
  data.sort(keys);
  const repeated = new Set();
  for (const group of runsOf(data, keys))
    if (group.count > 1)
      for (let r = group.start; r < group.start + group.count; r++)
        repeated.add(r);
  if (repeated.size) {
    message();
    ctx.out("The data are in the long form; j should be unique within i.");
    ctx.out("");
    ctx.out(
      `There are multiple observations on the same ${spec.j} within ${i}.`,
    );
    ctx.out("");
    ctx.out(
      `The following ${repeated.size} of ${data.n} observations have repeated ${spec.j} values:`,
    );
    show(keys, repeated);
    ctx.out("");
    ctx.out(`(data now sorted by ${keys.join(" ")})`);
    return;
  }
  if (!xi.length) {
    ctx.out(`${spec.j} is unique within ${i};`);
    ctx.out('there is no error with which "reshape error" can help.');
    return;
  }
  const groups = runsOf(data, spec.i),
    varying = (name) =>
      groups.filter((group) => {
        const column = data.get(name).data;
        for (let r = group.start + 1; r < group.start + group.count; r++)
          if (column[r] !== column[group.start]) return true;
        return false;
      });
  if (xi.every((name) => !varying(name).length)) {
    ctx.out(`${spec.j} is unique within ${i} and`);
    ctx.out(
      'all the "reshape xi" variables are constant within ' + `${spec.j};`,
    );
    ctx.out('there is no error with which "reshape error" can help.');
    return;
  }
  message();
  ctx.out(
    spec.xij.length === 1
      ? `xij variable is ${spec.xij[0]}.`
      : `xij variables are ${spec.xij.join(" ")}.`,
  );
  ctx.out("Thus, the following variable(s) should be constant within i:");
  ctx.out(`      ${xi.join(" ")}`);
  for (const name of xi) {
    const bad = varying(name);
    if (!bad.length) continue;
    ctx.out("");
    ctx.out(
      `${name} not constant within i (${i}) for ${bad.length} value${bad.length === 1 ? "" : "s"} of i:`,
    );
    const rows = new Set();
    for (const group of bad)
      for (let r = group.start; r < group.start + group.count; r++) rows.add(r);
    show([...keys, name], rows);
  }
  ctx.out("");
  ctx.out(`(data now sorted by ${keys.join(" ")})`);
}

function reshape(session, text, ctx) {
  const trimmed = text.trim(),
    word = /^\S*/.exec(trimmed)[0],
    rest = trimmed.slice(word.length);
  if (word === "clear") {
    if (session.data.reshapeChars) delete session.data.reshapeChars.reshape;
    return;
  }
  if (word === "long" || word === "wide") {
    if (rest.trim()) reshapeSimple(session, word, rest);
    if (word === "long") reshapeLong(session, ctx);
    else reshapeWide(session, ctx);
    return;
  }
  if (word.length >= 3 && "error".startsWith(word)) {
    // reshape.ado runs Qerror under capture noisily and exits without its
    // return code: a failure is shown, but reshape error itself succeeds.
    try {
      reshapeError(session, ctx);
    } catch (error) {
      if (!(error instanceof StataError)) throw error;
      for (const line of error.message.split("\n")) ctx.out(line);
    }
    return;
  }
  if (!word || "query".startsWith(word) || /^(i|j|xij|xi|favor)$/.test(word))
    throw invalid(
      `reshape ${word || "query"} is not available in the browser yet\n    Type reshape long or reshape wide with i() and j(); reshape alone repeats the last one.`,
    );
  throw new StataError(
    [
      "invalid syntax",
      paragraph(
        session,
        "In the reshape command that you typed, you omitted the word wide or long, or substituted some other word for it. You should have typed",
      ),
      "",
      "        . reshape wide varlist, ...",
      "    or",
      "        . reshape long varlist, ...",
      "",
      paragraph(
        session,
        "You might have omitted varlist, too. The basic syntax of reshape is",
      ),
      "",
      ...reshapePicture(true),
    ].join("\n"),
    198,
  );
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
  const chars = data.chars.get(name);
  data.drop([name]);
  data.rename(temporary, name);
  data.order(position);
  data.get(name).label = label;
  if (chars) data.chars.set(name, chars);
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
      "[varlist] [, Generate(string) replace force IGnore(string) PERCENT float | DPcomma]",
      text,
    ),
    names = targets(parsed, "destring"),
    data = session.data,
    options = parsed.options,
    genrep = names ? "generate" : "replace";
  // destring.ado removes each character of ignore() in turn, and % as well
  // under percent; the variable is then read with real() into a double, or
  // a float under float, and compressed.
  let ignore = options.ignore?.replace(/^"([\s\S]*)"$/, "$1") ?? "";
  if (options.percent && !ignore.includes("%")) ignore += "%";
  const characters = [...ignore],
    base = options.float ? "float" : "double";
  parsed.varlist.forEach((name, k) => {
    const variable = data.get(name);
    if (!isStringType(variable.type)) {
      ctx.out(`${name} already numeric; no ${genrep}`);
      return;
    }
    let cells = variable.data.slice(),
      percentCells = 0;
    const removed = [];
    for (const c of characters) {
      if (cells.some((cell) => cell.includes(c)))
        removed.push(c === " " ? "space" : c);
      if (c === "%" && options.percent)
        percentCells = cells.filter((cell) => cell.includes(c)).length;
      cells = cells.map((cell) => cell.split(c).join(""));
    }
    cells = cells.map((cell) => cell.trim().replace(/^0+/, "0"));
    const wasMissing = cells.filter(
        (cell) => cell === "" || cell === "." || /^\.[a-z]$/.test(cell),
      ).length,
      read = (cell) => {
        const value = parseNumber(cell);
        if (value === undefined) return MISSING;
        return options.float && !isMissing(value) ? Math.fround(value) : value;
      };
    let values = cells.map(read);
    const missing = values.filter(isMissing).length,
      flag = missing !== wasMissing;
    if (flag && !options.force) {
      ctx.out(
        ignore
          ? `${name}: contains characters not specified in ignore(); no ${genrep}`
          : `${name}: contains nonnumeric characters; no ${genrep}`,
      );
      return;
    }
    if (percentCells)
      values = values.map((v) =>
        isMissing(v) ? v : options.float ? Math.fround(v / 100) : v / 100,
      );
    const smallest = inferType(values),
      type = ["byte", "int", "long"].includes(smallest) ? smallest : base,
      target = names ? names[k] : name,
      finalPrint = names ? `${target} ` : "";
    if (names) {
      data.generate(target, values, { type });
      placeAfter(data, target, name);
    } else {
      swapVariable(data, name, values, { type });
    }
    data.get(target).format = base === "float" ? "%9.0g" : "%10.0g";
    if (flag)
      ctx.out(
        `${name}: contains nonnumeric characters${ignore ? " not specified in ignore()" : ""}${removed.length ? "" : `; ${finalPrint}${genrep}d as ${type}`}`,
      );
    if (removed.length)
      ctx.out(
        `${name}: character${removed.length > 1 ? "s" : ""} ${removed.join(" ")} removed; ${finalPrint}${genrep}d as ${type}`,
      );
    else if (!flag)
      ctx.out(
        `${name}: all characters numeric; ${finalPrint}${genrep}d as ${type}`,
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
    if (!names && variable.valueLabel && !parsed.options.force) {
      ctx.out(`${name} has value label; no replace`);
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
    if (lossy)
      ctx.out(`${target} was forced to string; some loss of information`);
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
  if (parsed.options.extend === false && parsed.options.label === undefined)
    throw invalid("noextend option not allowed without label() option");
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
  // noextend refuses values the label does not already code.
  if (parsed.options.extend === false && fresh.length)
    throw new StataError(
      ["Unexpected values encountered:", ...fresh].join("\n"),
      459,
    );
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

// ----- recode -----
/**
 * Splits recode's text into the variables, the rules, and what follows them
 * (if, in and options). Rules are in parentheses, or, for one variable,
 * written after it without them. Quoted value labels may hold anything.
 */
function recodeParts(text) {
  const [head, options] = splitAtComma(text),
    tokens = [];
  let i = 0;
  while (i < head.length) {
    const c = head[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (head.startsWith('`"', i)) {
      const end = head.indexOf("\"'", i + 2);
      if (end < 0) throw invalid();
      tokens.push({ text: head.slice(i + 2, end), quoted: true, at: i });
      i = end + 2;
    } else if (c === '"') {
      const end = head.indexOf('"', i + 1);
      if (end < 0) throw invalid();
      tokens.push({ text: head.slice(i + 1, end), quoted: true, at: i });
      i = end + 1;
    } else if ("()/=".includes(c)) {
      tokens.push({ text: c, at: i });
      i++;
    } else {
      const m = /^[^\s()/="]+/.exec(head.slice(i));
      tokens.push({ text: m[0], at: i });
      i += m[0].length;
    }
  }
  let depth = 0,
    end = tokens.length;
  for (const [k, token] of tokens.entries()) {
    if (token.quoted) continue;
    if (token.text === "(") depth++;
    else if (token.text === ")") depth--;
    else if (!depth && (token.text === "if" || token.text === "in")) {
      end = k;
      break;
    }
  }
  const tail =
    (end < tokens.length ? head.slice(tokens[end].at) : "") +
    (options === null ? "" : "," + options);
  return { tokens: tokens.slice(0, end), tail };
}
const RECODE_KEYWORD = (word) =>
  word === "*" || word === "else"
    ? "else"
    : word.length >= 3 && "missing".startsWith(word)
      ? "missing"
      : word.length >= 4 && "nonmissing".startsWith(word)
        ? "nonmissing"
        : null;

function recode(session, text, ctx) {
  const { tokens, tail } = recodeParts(text);
  if (tokens[0]?.text === "(") throw new StataError("( expected", 102);
  const parens = tokens.findIndex((t) => t.text === "(" && !t.quoted);
  let names, rest;
  if (parens > 0) {
    names = session.varlist(
      tokens
        .slice(0, parens)
        .map((t) => t.text)
        .join(" "),
    );
    rest = tokens.slice(parens + 1);
  } else {
    if (!tokens.length) throw invalid();
    names = session.varlist(tokens[0].text);
    if (names.length !== 1)
      throw new StataError("too many variables specified", 103);
    rest = tokens.slice(1);
  }
  for (const name of names)
    if (isStringType(session.data.get(name).type))
      throw new StataError("recode only allows numeric variables", 108);
  if (!rest.length) throw invalid("rules expected");
  const parsed = session.parse(
      "[if] [in] [, COPYrest Generate(string) INto(string) Label(string) PREfix(string) Test]",
      tail,
    ),
    data = session.data,
    options = parsed.options;
  let made = null;
  if (options.prefix !== undefined) {
    if (options.generate !== undefined || options.into !== undefined)
      throw invalid(
        "option prefix() may not be combined with generate() or into()",
      );
    made = names.map((name) => {
      const target = options.prefix + name;
      if (!isName(target)) throw invalid(`${target} invalid variable name`);
      if (data.has(target))
        throw new StataError(`variable ${target} already exists`, 110);
      return target;
    });
  } else {
    if (options.generate !== undefined && options.into !== undefined)
      throw invalid("options generate() and into() are synonyms");
    const given = options.generate ?? options.into;
    if (given !== undefined) {
      made = given.trim().split(/\s+/).filter(Boolean);
      for (const target of made) {
        if (!isName(target)) throw invalid(`${target} invalid name`);
        if (data.has(target))
          throw new StataError(`variable ${target} already defined`, 110);
      }
      if (made.length !== names.length)
        throw invalid(
          "the number of new and transformed varnames should be the same",
        );
    }
  }
  // Rules that define value labels need a label to put them in: the one
  // label() names, or one named after the single new variable.
  let labelName = null,
    labelRule = 0;
  if (options.label !== undefined) {
    if (!made) throw invalid("option label() allowed only with generate()");
    labelName = options.label.trim();
    if (!isName(labelName)) throw invalid(`${labelName} invalid name`);
  } else if (made) {
    if (names.length === 1) labelName = made[0];
    else labelRule = 1;
  } else labelRule = 2;

  // A value is a number, a missing-value code, or min or max.
  let needsRange = false;
  const element = (word) => {
    if (word === "min" || word === "max") {
      needsRange = true;
      return word;
    }
    const value = word === undefined ? undefined : parseNumber(word);
    if (value === undefined) throw invalid(`unknown el ${word ?? ""} in rule`);
    return value;
  };
  const labelOk = (value) => {
    if (labelRule === 1)
      throw invalid(
        "Rules defining value labels not allowed\nwith labeled recode of multiple vars, option label() required",
      );
    if (labelRule === 2)
      throw invalid(
        "Rules defining value labels not allowed when overwriting a variable",
      );
    if (value === MISSING)
      throw invalid("Value label not allowed for missing value code .");
    if (
      typeof value === "number" &&
      !isMissing(value) &&
      !Number.isInteger(value)
    )
      throw invalid(
        `Value label not allowed for noninteger ${formatNumber(value)}`,
      );
  };
  // A label is a word, or quoted text that is not empty: recode.ado reads
  // "" as nothing, and then finds it where ) should be.
  const isRuleLabel = (token) =>
    token && (token.quoted ? token.text !== "" : token.text !== ")");
  const usingParens = parens > 0,
    closeRule = (k) => {
      // ) then ( or the end
      const a = rest[k]?.text,
        b = rest[k + 1];
      if (a !== ")" || rest[k]?.quoted)
        throw invalid(`) expected, "${a ?? ""}" found`);
      if (b && (b.text !== "(" || b.quoted))
        throw invalid(`( expected, "${b.text}" found`);
      return k + 2;
    };
  const conditions = [],
    targets = [];
  let k = 0,
    noLeft = true;
  while (k < rest.length && (rest[k].quoted || !RECODE_KEYWORD(rest[k].text))) {
    if (rest[k].text === "=" && !rest[k].quoted) {
      if (noLeft) throw invalid('transformation rule without "condition" part');
      const target = { value: element(rest[k + 1]?.text), label: null };
      k += 2;
      if (usingParens) {
        if (isRuleLabel(rest[k]) && rest[k + 1]?.text === ")") {
          labelOk(target.value);
          target.label = rest[k].text;
          k++;
        }
        k = closeRule(k);
      }
      targets.push(target);
      noLeft = true;
    } else {
      const low = element(rest[k].text);
      if (rest[k + 1]?.text === "/") {
        conditions.push({
          low,
          high: element(rest[k + 2]?.text),
          rule: targets.length,
        });
        k += 3;
      } else {
        conditions.push({ low, high: null, rule: targets.length });
        k++;
      }
      noLeft = false;
    }
  }
  if (!noLeft) throw invalid();
  // else (or *), missing and nonmissing: the rules for what is left.
  const otherwise = {};
  while (k < rest.length) {
    const key = rest[k].quoted ? null : RECODE_KEYWORD(rest[k].text);
    if (!key) throw invalid(`unknown keyword ${rest[k].text}`);
    if (otherwise[key])
      throw invalid(`multiple specification of keyword ${key}`);
    if (rest[k + 1]?.text !== "=") throw invalid("= expected");
    const target = { value: element(rest[k + 2]?.text), label: null };
    k += 3;
    if (usingParens) {
      if (isRuleLabel(rest[k]) && rest[k + 1]?.text === ")") {
        labelOk(target.value);
        target.label = rest[k].text;
        k++;
      }
      k = closeRule(k);
    }
    otherwise[key] = target;
  }
  if (otherwise.else && (otherwise.missing || otherwise.nonmissing))
    throw invalid("keywords else/* and missing/nonmissing may not be combined");

  const rows = session.rows(parsed, null),
    touse = new Set(rows),
    results = [];
  let overlapped = false,
    unused = false;
  for (const name of names) {
    const variable = data.get(name),
      column = variable.data,
      // Except for doubles and longs, rules compare at float precision.
      flt = !["double", "long"].includes(variable.type),
      f = (v) => (flt && !isMissing(v) ? Math.fround(v) : v),
      next = new Float64Array(data.n).fill(MISSING);
    for (const i of rows) next[i] = column[i];
    let low = MISSING,
      high = MISSING;
    if (needsRange) {
      const present = rows.map((i) => column[i]).filter((v) => !isMissing(v));
      if (!present.length) {
        results.push({ name, values: Array.from(column), changes: 0 });
        continue;
      }
      low = least(present);
      high = greatest(present);
    }
    const value = (v) => (v === "min" ? low : v === "max" ? high : v),
      open = new Set(rows),
      used = conditions.map(() => false);
    conditions.forEach((condition, c) => {
      const a = f(value(condition.low)),
        b = condition.high === null ? null : f(value(condition.high)),
        hit = (i) => {
          const v = f(column[i]);
          return b === null ? v === a : v >= a && v <= b;
        },
        to = value(targets[condition.rule].value);
      if (options.test) {
        if (rows.some((i) => !open.has(i) && hit(i))) {
          overlapped = true;
          used[c] = true;
        } else if (rows.some((i) => open.has(i) && hit(i))) used[c] = true;
      }
      for (const i of rows)
        if (open.has(i) && hit(i)) {
          next[i] = to;
          open.delete(i);
        }
    });
    if (options.test && used.some((u) => !u)) unused = true;
    for (const i of open) {
      if (otherwise.else) next[i] = value(otherwise.else.value);
      else if (otherwise.missing && isMissing(column[i]))
        next[i] = value(otherwise.missing.value);
      else if (otherwise.nonmissing && !isMissing(column[i]))
        next[i] = value(otherwise.nonmissing.value);
    }
    let changes = 0;
    for (const i of rows) if (f(column[i]) !== f(next[i])) changes++;
    if (options.copyrest || !made)
      for (let i = 0; i < data.n; i++) if (!touse.has(i)) next[i] = column[i];
    results.push({ name, values: Array.from(next), changes });
  }
  results.forEach(({ name, changes }, k) =>
    ctx.out(
      made
        ? `(${count(changes)} differences between ${name} and ${made[k]})`
        : `(${count(changes)} changes made to ${name})`,
    ),
  );
  if (options.test) {
    if (overlapped) ctx.out('(transformation rules "overlapped")');
    if (unused)
      ctx.out("(one or more transformation rules did not match any values)");
  }

  // The value labels the rules define.
  const labelled = [
    ...targets,
    ...["else", "missing", "nonmissing"]
      .map((key) => otherwise[key])
      .filter(Boolean),
  ].filter((target) => target.label !== null);
  if (labelled.length) {
    const map = data.valueLabels.get(labelName) ?? new Map();
    for (const target of labelled) map.set(target.value, target.label);
    data.valueLabels.set(labelName, map);
  }
  const sorted = [...data.sortedBy];
  results.forEach(({ name, values }, k) => {
    const variable = data.get(name);
    if (!made) {
      data.replace(name, values);
      return;
    }
    // generate makes the new variable in the default type, then recasts it
    // to the old variable's type when that keeps every value.
    const kind = data.defaultType,
      stored = values.map((v) =>
        kind === "float" && !isMissing(v) ? Math.fround(v) : v,
      ),
      fits = stored.every(
        (v) => isMissing(v) || coerce(variable.type, v) === v,
      ),
      type = fits ? variable.type : kind;
    data.generate(made[k], stored, { type });
    let format = defaultFormat(kind);
    // Attaching a value label widens a numeric format to its longest label.
    if (labelled.length) {
      const longest = greatest(
        [...data.valueLabels.get(labelName).values()].map(byteLength),
      );
      format = format.replace(
        /^%(\d+)/,
        (m, w) => `%${Math.max(Number(w), longest)}`,
      );
    }
    Object.assign(data.get(made[k]), {
      format,
      label:
        `RECODE of ${name}${variable.label ? ` (${variable.label})` : ""}`.slice(
          0,
          80,
        ),
      valueLabel: labelled.length ? labelName : "",
    });
  });
  data.sortedBy = made
    ? sorted
    : sorted.filter((name) => !names.includes(name));
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
