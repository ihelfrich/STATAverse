// The dataset in memory: typed columns, the recorded sort order and the
// operations on variables and observations that Stata's data commands share.
// Commands sit on top of this; nothing here parses command text.
import { StataError } from "./errors.js";
import { greatest } from "./extremes.js";
import {
  MISSING,
  byteLength,
  coerce,
  defaultFormat,
  inferType,
  isMissing,
  isName,
  isNumericType,
  isReserved,
  isStringType,
  MAX_STRING_WIDTH,
  promote,
  stringWidth,
  truncateBytes,
} from "./values.js";

// The narrowest string type that holds every value. greatest() loops rather
// than spreading one argument per observation into Math.max, which overflowed
// the call stack once a variable had about 150,000 observations.
const widthType = (values) => {
  const width = Math.max(1, greatest(values.map(byteLength)));
  return width > MAX_STRING_WIDTH ? "strL" : "str" + width;
};
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// gsort -x: numbers descending, then missing values, themselves descending.
const descending = (a, b) =>
  typeof a === "number" && isMissing(a) !== isMissing(b)
    ? isMissing(a)
      ? 1
      : -1
    : compare(b, a);

/**
 * The characteristics of _dta or of a variable as Stata lists them, newest
 * first, as [name, text] pairs. Notes are characteristics too: note1, note2,
 * ... hold the notes and note0 the number of the last one, which a gap left
 * by a dropped note does not change.
 */
export function characteristicsOf(data, owner) {
  return [...(data.chars?.get(owner) ?? [])];
}

/**
 * Defines a characteristic, or deletes it when the text is empty. A new or
 * changed one becomes the newest; one given the text it has keeps its
 * place, as in Stata.
 */
export function defineCharacteristic(data, owner, name, text) {
  const chars = (data.chars ??= new Map()),
    own = chars.get(owner) ?? new Map();
  if (own.get(name) === text) return;
  own.delete(name);
  if (text !== "") chars.set(owner, new Map([[name, text], ...own]));
  else if (own.size) chars.set(owner, own);
  else chars.delete(owner);
}

const copyChars = (from) => ({
  chars: new Map(
    [...(from.chars ?? [])].map(([name, map]) => [name, new Map(map)]),
  ),
});

export class Dataset {
  constructor({ defaultType = "float" } = {}) {
    this.n = 0;
    this.variables = [];
    this.sortedBy = [];
    this.defaultType = defaultType;
    this.label = "";
    // Value labels: label name to a Map from number to text.
    this.valueLabels = new Map();
    // Characteristics, notes among them: owner (_dta or a variable) to a
    // Map from characteristic to text, newest first.
    this.chars = new Map();
  }

  get names() {
    return this.variables.map((v) => v.name);
  }
  has(name) {
    return this.variables.some((v) => v.name === name);
  }
  get(name) {
    const variable = this.variables.find((v) => v.name === name);
    if (!variable) throw new StataError(`variable ${name} not found`, 111);
    return variable;
  }
  value(name, i) {
    return this.get(name).data[i];
  }
  isString(name) {
    return isStringType(this.get(name).type);
  }

  setObservations(n) {
    if (!Number.isInteger(n) || n < this.n)
      throw new StataError(
        "obs must be greater than or equal to the current number of observations",
        198,
      );
    for (const v of this.variables) {
      if (isStringType(v.type))
        v.data = v.data.concat(Array(n - this.n).fill(""));
      else {
        const data = new Float64Array(n).fill(MISSING);
        data.set(v.data);
        v.data = data;
      }
    }
    this.n = n;
  }

  /**
   * Creates a variable from one value per observation. Values are numbers
   * (missing values in Stata's coding) or strings. Returns the storage type
   * and how many values are missing.
   */
  generate(name, values, { type, string } = {}) {
    if (!isName(name) || isReserved(name))
      throw new StataError(`${name} invalid name`, 198);
    if (this.has(name))
      throw new StataError(`variable ${name} already defined`, 110);
    if (values.length !== this.n)
      throw new Error("generate needs one value per observation");
    const text = string ?? typeof values[0] === "string";
    if (type && text !== isStringType(type))
      throw new StataError("type mismatch", 109);
    let data, stored;
    if (text) {
      stored = type ?? widthType(values);
      const width = stringWidth(stored);
      data = values.map((v) => truncateBytes(v, width));
    } else {
      stored = type ?? this.defaultType;
      data = Float64Array.from(values, (v) => coerce(stored, v));
    }
    this.variables.push({
      name,
      type: stored,
      format: defaultFormat(stored),
      label: "",
      valueLabel: "",
      data,
    });
    return {
      type: stored,
      missing: text
        ? data.filter((v) => v === "").length
        : data.filter(isMissing).length,
    };
  }

  /**
   * Assigns values[i] to each selected observation. Selection is an optional
   * list of zero-based observation numbers; all observations by default.
   * Storage widens the way Stata's replace widens it.
   */
  replace(name, values, selection) {
    const variable = this.get(name),
      text = isStringType(variable.type),
      rows = selection ?? Array.from({ length: this.n }, (_, i) => i);
    if (rows.length && text !== (typeof values[rows[0]] === "string"))
      throw new StataError("type mismatch", 109);
    const from = variable.type,
      assigned = rows.map((i) => values[i]);
    let changed = 0;
    if (text) {
      const needed = widthType(assigned);
      if (stringWidth(needed) > stringWidth(from))
        this.retype(variable, needed);
      for (const i of rows)
        if (variable.data[i] !== values[i]) {
          variable.data[i] = values[i];
          changed++;
        }
    } else {
      variable.type = promote(from, assigned);
      for (const i of rows) {
        const next = coerce(variable.type, values[i]);
        if (variable.data[i] !== next) {
          variable.data[i] = next;
          changed++;
        }
      }
    }
    // The data stay sorted on a key that replace did not actually change.
    if (changed) this.unsortFrom(name);
    return { changed, from, to: variable.type };
  }

  /**
   * Changes a storage type. Without force, a change that would alter any
   * value is not made, and the count of affected values is returned.
   */
  recast(name, type, { force = false } = {}) {
    const variable = this.get(name),
      text = isStringType(variable.type);
    if (text !== isStringType(type) || (!text && !isNumericType(type)))
      throw new StataError("type mismatch", 109);
    const next = text
      ? variable.data.map((v) => truncateBytes(v, stringWidth(type)))
      : Float64Array.from(variable.data, (v) => coerce(type, v));
    let wouldChange = 0;
    for (let i = 0; i < this.n; i++)
      if (next[i] !== variable.data[i]) wouldChange++;
    if (wouldChange && !force) return { recast: false, wouldChange };
    variable.data = next;
    this.retype(variable, type);
    return { recast: true, wouldChange };
  }

  // A string variable still showing its default format follows its width.
  retype(variable, type) {
    if (
      isStringType(type) &&
      isStringType(variable.type) &&
      variable.format === defaultFormat(variable.type)
    )
      variable.format = defaultFormat(type);
    variable.type = type;
  }

  /** Stable sort. Each key is a name, or { name, descending }. */
  sort(keys) {
    const columns = keys.map((key) => {
      const k = typeof key === "string" ? { name: key } : key;
      return {
        data: this.get(k.name).data,
        order: k.descending ? descending : compare,
      };
    });
    const index = Array.from({ length: this.n }, (_, i) => i);
    index.sort((a, b) => {
      for (const { data, order } of columns) {
        const c = order(data[a], data[b]);
        if (c) return c;
      }
      return a - b;
    });
    this.reorder(index);
    // The data are recorded as sorted on the leading ascending keys.
    const ascending = [];
    for (const key of keys) {
      if (typeof key !== "string" && key.descending) break;
      const name = typeof key === "string" ? key : key.name;
      if (!ascending.includes(name)) ascending.push(name);
    }
    this.sortedBy = ascending;
  }

  /** Keeps the listed zero-based observations, in the order given. */
  reorder(index) {
    for (const v of this.variables)
      v.data = isStringType(v.type)
        ? index.map((i) => v.data[i])
        : Float64Array.from(index, (i) => v.data[i]);
    this.n = index.length;
  }
  /** drop in first/last, with one-based inclusive bounds as Stata counts. */
  dropRange(first, last) {
    if (!(first >= 1 && first <= last && last <= this.n))
      throw new StataError("observation numbers out of range", 198);
    this.reorder(
      Array.from({ length: this.n }, (_, i) => i).filter(
        (i) => i < first - 1 || i > last - 1,
      ),
    );
  }

  drop(names) {
    for (const name of names) this.get(name);
    for (const name of names) this.unsortFrom(name);
    this.variables = this.variables.filter((v) => !names.includes(v.name));
    for (const name of names) this.chars?.delete(name);
    // Stata has no observations without variables, and dropping the last
    // variable clears the dataset's characteristics and notes too.
    if (!this.variables.length) {
      this.n = 0;
      this.chars?.clear();
    }
  }
  keep(names) {
    for (const name of names) this.get(name);
    this.drop(this.names.filter((name) => !names.includes(name)));
  }
  rename(from, to) {
    const variable = this.get(from);
    if (!isName(to) || isReserved(to))
      throw new StataError(`${to} invalid name`, 198);
    if (this.has(to))
      throw new StataError(`variable ${to} already defined`, 110);
    variable.name = to;
    this.sortedBy = this.sortedBy.map((name) => (name === from ? to : name));
    // Its notes and characteristics go with it.
    if (this.chars?.has(from)) {
      this.chars.set(to, this.chars.get(from));
      this.chars.delete(from);
    }
  }
  /** Moves the listed variables to the front, in the order given. */
  order(names) {
    const front = names.map((name) => this.get(name));
    this.variables = [
      ...front,
      ...this.variables.filter((v) => !front.includes(v)),
    ];
  }

  // A change to a sort key leaves the data sorted only on the keys before it.
  unsortFrom(name) {
    const at = this.sortedBy.indexOf(name);
    if (at >= 0) this.sortedBy = this.sortedBy.slice(0, at);
  }

  /** A copy that later changes to this dataset cannot reach. */
  snapshot() {
    return {
      n: this.n,
      sortedBy: [...this.sortedBy],
      defaultType: this.defaultType,
      label: this.label,
      valueLabels: new Map(
        [...this.valueLabels].map(([name, map]) => [name, new Map(map)]),
      ),
      ...copyChars(this),
      variables: this.variables.map((v) => ({ ...v, data: v.data.slice() })),
      // Characteristics, such as the settings reshape keeps with the data.
      ...(this.chars ? { chars: structuredClone(this.chars) } : {}),
    };
  }
  restore(snapshot) {
    delete this.chars;
    Object.assign(this, {
      ...snapshot,
      ...(snapshot.chars ? { chars: structuredClone(snapshot.chars) } : {}),
      sortedBy: [...snapshot.sortedBy],
      valueLabels: new Map(
        [...snapshot.valueLabels].map(([name, map]) => [name, new Map(map)]),
      ),
      ...copyChars(snapshot),
      variables: snapshot.variables.map((v) => ({
        ...v,
        data: v.data.slice(),
      })),
    });
  }

  /**
   * Reads the site's existing dataset shape: columns with a name, label and
   * "numeric" or "string" type, rows as objects, null for missing.
   */
  static fromRows({ columns, rows }) {
    const dataset = new Dataset();
    dataset.n = rows.length;
    for (const column of columns) {
      const text = column.type === "string",
        values = rows.map((row) =>
          text ? (row[column.name] ?? "") : (row[column.name] ?? MISSING),
        );
      dataset.generate(column.name, values, {
        string: text,
        type: text ? undefined : inferType(values),
      });
      dataset.get(column.name).label = column.label ?? "";
    }
    return dataset;
  }
  toRows() {
    return {
      columns: this.variables.map((v) => ({
        name: v.name,
        label: v.label,
        type: isStringType(v.type) ? "string" : "numeric",
      })),
      rows: Array.from({ length: this.n }, (_, i) =>
        Object.fromEntries(
          this.variables.map((v) => [
            v.name,
            typeof v.data[i] === "number" && isMissing(v.data[i])
              ? null
              : v.data[i],
          ]),
        ),
      ),
    };
  }
}
