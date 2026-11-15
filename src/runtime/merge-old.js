// merge as Stata wrote it before version 11, merge [varlist] using file,
// which Stata 19 still runs after a note. Without a varlist observations
// are joined one to one in turn; with one, both datasets must already be
// sorted on it, and observations are matched in order within each key: a
// key with more observations on one side pairs the extra ones with the
// last observation of the other side, and those pairs, and the using
// observations that match nothing, follow the master observations. No
// table of results is shown.
import { StataError } from "./errors.js";
import { Dataset } from "./store.js";
import { fileName, load, reconcile, remade } from "./data-commands.js";
import { MISSING, isMissing, isStringType } from "./values.js";
import { splitAtComma } from "./syntax.js";

const OPTIONS = [
  ["unique", /^uniq(ue?)?$/],
  ["uniqmaster", /^uniqm(a(s(t(er?)?)?)?)?$/],
  ["uniqusing", /^uniqu(s(i(ng?)?)?)?$/],
  ["nokeep", /^nokeep$/],
  ["nolabel", /^nol(a(b(el?)?)?)?$/],
  ["update", /^upd(a(te?)?)?$/],
  ["replace", /^replace$/],
  ["keep", /^keep\(/],
  ["merge", /^_merge\(/],
];
/** The using data's variables keep() names, each whole or abbreviated. */
function namesIn(set, text) {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (set.has(word)) return word;
      const hits = set.names.filter((name) => name.startsWith(word));
      if (hits.length !== 1)
        throw new StataError(`variable ${word} not found`, 111);
      return hits[0];
    });
}
// Options of the old merge the browser does not take.
const UNAVAILABLE = /^(nonotes|nosummary|sort|_merge|fillin)$/;

export function oldMerge(session, text, ctx) {
  ctx.out("(you are using old merge syntax; see [D] merge for new syntax)");
  const [head, tail] = splitAtComma(text),
    at = /(^|\s)using(\s|$)/.exec(head),
    keysText = head.slice(0, at.index).trim(),
    files = head.slice(at.index + at[0].length).match(/`"[^"]*"'|"[^"]*"|\S+/g);
  if (!files?.length) throw new StataError("invalid file specification", 198);
  const options = {};
  for (const word of (tail ?? "").match(/[A-Za-z_]+(\([^)]*\))?/g) ?? []) {
    const found = OPTIONS.find(([, pattern]) => pattern.test(word));
    if (!found) {
      const name = word.replace(/\(.*$/, "");
      if (UNAVAILABLE.test(name))
        throw new StataError(
          `option ${name} of the old merge is not available in the browser; use the new syntax, merge 1:1 varlist using file`,
          198,
        );
      throw new StataError(
        `option ${name}${word.includes("(") ? "()" : ""} not allowed`,
        198,
      );
    }
    options[found[0]] = /\(([^)]*)\)/.exec(word)?.[1]?.trim() ?? true;
  }
  if (files.length > 1)
    throw new StataError(
      "the old merge of several using files at once is not available in the browser; merge them one at a time",
      198,
    );
  const data = session.data,
    keys = keysText ? session.varlist(keysText) : [],
    marker = options.merge || "_merge";
  if (data.has(marker))
    throw new StataError(`variable ${marker} already defined`, 110);
  if (options.replace && !options.update)
    throw new StataError("option replace requires option update", 198);
  const sortedOn = (set) => keys.every((key, k) => set.sortedBy[k] === key);
  if (keys.length && !sortedOn(data))
    throw new StataError("master data not sorted", 5);
  const name = fileName(files[0]),
    other = load(session, name);
  for (const key of keys)
    if (!other.has(key)) throw new StataError(`variable ${key} not found`, 111);
  if (keys.length && !sortedOn(other))
    throw new StataError("using data not sorted", 5);
  // The observations of each key, in order.
  const keyOf = (set, i) =>
      JSON.stringify(keys.map((key) => set.get(key).data[i])),
    groups = (set) => {
      const map = new Map();
      for (let i = 0; i < set.n; i++) {
        const key = keys.length ? keyOf(set, i) : String(i);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(i);
      }
      return map;
    },
    master = groups(data),
    using = groups(other),
    repeated = (map) => [...map.values()].some((rows) => rows.length > 1),
    list = keys.join(" "),
    plural = keys.length > 1;
  const notUnique = (where) =>
    `variable${plural ? "s" : ""} ${list} do${plural ? "" : "es"} not uniquely identify observations in ${where}`;
  if (keys.length) {
    if ((options.unique || options.uniqusing) && repeated(using))
      throw new StataError(notUnique("the using data"), 459);
    if ((options.unique || options.uniqmaster) && repeated(master))
      throw new StataError(notUnique("the master data"), 459);
    if (repeated(master)) ctx.out(notUnique("the master data"));
    if (repeated(using)) ctx.out(notUnique(name));
  }
  const wanted = options.keep
      ? [...new Set([...keys, ...namesIn(other, options.keep)])]
      : other.names,
    shared = wanted.filter((v) => data.has(v)),
    brought = wanted.filter((v) => !data.has(v));
  const ignored = reconcile(
    session,
    "merge",
    data,
    other,
    wanted,
    { force: false, label: !options.nolabel },
    ctx,
  );
  // Master observations in order, each with its match; then the pairs a
  // longer using group adds, and the using observations matching nothing,
  // in the using data's order.
  const rows = [],
    extra = [];
  for (let i = 0; i < data.n; i++) {
    const key = keys.length ? keyOf(data, i) : String(i),
      mine = master.get(key),
      theirs = using.get(key) ?? [],
      k = mine.indexOf(i);
    rows.push({
      master: i,
      using: theirs.length ? theirs[Math.min(k, theirs.length - 1)] : null,
    });
  }
  for (let j = 0; j < other.n; j++) {
    const key = keys.length ? keyOf(other, j) : String(j),
      mine = master.get(key),
      k = using.get(key).indexOf(j);
    if (!mine) extra.push({ master: null, using: j });
    else if (k >= mine.length) extra.push({ master: mine.at(-1), using: j });
  }
  let all = [...rows, ...extra];
  const updated = options.update
      ? shared.filter((v) => !keys.includes(v) && !ignored.has(v))
      : [],
    empty = (value) =>
      typeof value === "string" ? value === "" : isMissing(value);
  for (const row of all) {
    row.code = row.master === null ? 2 : row.using === null ? 1 : 3;
    if (row.code !== 3 || !updated.length) continue;
    row.take = [];
    let filled = false,
      conflict = false;
    for (const v of updated) {
      const mine = data.get(v).data[row.master],
        theirs = other.get(v).data[row.using];
      if (empty(mine)) {
        if (mine === theirs) continue;
        filled = true;
        row.take.push(v);
      } else if (empty(theirs)) continue;
      else if (mine !== theirs) {
        conflict = true;
        if (options.replace) row.take.push(v);
      }
    }
    row.code = conflict ? 5 : filled ? 4 : 3;
  }
  if (options.nokeep) all = all.filter((row) => row.code !== 2);
  const result = new Dataset({ defaultType: data.defaultType });
  result.n = all.length;
  result.label = data.label;
  result.valueLabels = data.valueLabels;
  for (const variable of data.variables) {
    const text = isStringType(variable.type),
      theirs =
        shared.includes(variable.name) && !ignored.has(variable.name)
          ? other.get(variable.name)
          : null;
    result.generate(
      variable.name,
      all.map((row) =>
        row.master !== null && !row.take?.includes(variable.name)
          ? variable.data[row.master]
          : theirs && row.using !== null
            ? theirs.data[row.using]
            : text
              ? ""
              : MISSING,
      ),
      { type: variable.type, string: text },
    );
    Object.assign(result.get(variable.name), {
      format: variable.format,
      label: variable.label,
      valueLabel: variable.valueLabel,
    });
  }
  for (const v of brought) {
    const theirs = other.get(v),
      text = isStringType(theirs.type);
    result.generate(
      v,
      all.map((row) =>
        row.using === null ? (text ? "" : MISSING) : theirs.data[row.using],
      ),
      { type: theirs.type, string: text },
    );
    Object.assign(result.get(v), {
      format: theirs.format,
      label: theirs.label,
      valueLabel: theirs.valueLabel,
    });
  }
  result.generate(
    marker,
    all.map((row) => row.code),
    { type: "byte" },
  );
  result.sortedBy = [];
  remade(session, result);
}
