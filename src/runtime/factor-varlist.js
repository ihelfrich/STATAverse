// Factor variables in the varlist of summarize, list and mean.
//
// Stata reads i.g, ibn.g, ib2.g, 1.g, c.x and interactions such as i.g#c.x
// or c.x#c.x there: each level of g, or the product, is a variable of its
// own. As tsrevar does for time-series operators, each one is made here as
// a temporary variable, carrying under ts the name Stata shows for it, and
// the command runs on those; they are gone when it ends.
import { StataError } from "./errors.js";
import { isStringType, isMissing, MISSING } from "./values.js";
import { resolveVariable } from "./varlist.js";
import { parseNumlist } from "./numlist.js";

// One factor-variable term: an operator and a variable name.
const TERM =
  /^(?:(i|ibn|ib(?:\d+|n|first|last|freq)|b\d+)|(\d+)(?:bn|b|o)?|(c|co|o))\.([\p{L}_][\w\u0080-\u{10FFFF}]*)$/u;

/** Whether a varlist word holds a factor-variable operator. */
export const isFactorWord = (word) =>
  /^(?:i\w*|b\d+|\d+(?:bn|b|o)?|c|co|o)\.[\p{L}_(]/u.test(word) ||
  (/#/.test(word) && /(?:^|#)(?:i\w*|\d+\w*|c|co|o)\./u.test(word));

function words(text) {
  const out = [];
  let current = "",
    depth = 0;
  for (const ch of text.trim()) {
    if (/\s/.test(ch) && !depth) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function varlistEnd(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (!depth && (c === "," || c === "[")) return i;
    else if (
      !depth &&
      (i === 0 || /\s/.test(text[i - 1])) &&
      /^(?:if|in)(?![\w.])/.test(text.slice(i))
    )
      return i;
  }
  return text.length;
}

const unsupported = (word) =>
  new StataError(
    `${word}: this form of factor variable is not available in the browser yet`,
    198,
    "Write each level as its own term, as 1.g 2.g, or make the variables with generate.",
  );

/**
 * The distinct levels of a factor variable in the observations the command
 * uses (all when rows is null), checked as Stata checks them.
 */
function levelsOf(variable, rows = null) {
  const levels = new Set();
  for (const v of rows ? rows.map((i) => variable.data[i]) : variable.data) {
    if (isMissing(v)) continue;
    if (v < 0)
      throw new StataError(
        `${variable.name}:  factor variables may not contain negative values`,
        452,
      );
    if (!Number.isInteger(v))
      throw new StataError(
        `${variable.name}:  factor variables may not contain noninteger values`,
        452,
      );
    levels.add(v);
  }
  return [...levels].sort((a, b) => a - b);
}

// A level's value label, or null when it has none.
const valueText = (session, variable, level) =>
  session.data.valueLabels.get(variable.valueLabel)?.get(level) ?? null;

/**
 * The columns a factor-variable word stands for: { name, label, base,
 * values }, where base names the group a column belongs to (g for the
 * levels of i.g) and label its row in that group; a column with no base
 * stands alone under its name, as 1.g or c.x#c.x. A plain variable (c.x)
 * is { variable } instead.
 */
function columnsOf(session, word, rows) {
  const data = session.data,
    parts = word.split("#");
  if (parts.some((part) => part === "") || word.includes("##"))
    throw unsupported(word);
  const terms = parts.map((part) => {
    const m = TERM.exec(part);
    if (!m) {
      // A bare name in an interaction is continuous; anything else, such
      // as i.(g h), is not read here.
      if (parts.length > 1 && /^[\p{L}_][\w\u0080-\u{10FFFF}]*$/u.test(part))
        return { kind: "c", name: part };
      throw unsupported(word);
    }
    const kind = m[1] ? "i" : m[2] !== undefined ? "level" : "c";
    if (m[3] === "co" || m[3] === "o") throw unsupported(word);
    return {
      kind,
      operator: m[1],
      level: m[2] === undefined ? null : Number(m[2]),
      name: m[4],
    };
  });
  for (const term of terms) {
    term.variable = data.get(resolveVariable(term.name, data.names));
    if (isStringType(term.variable.type))
      throw new StataError(
        `${term.variable.name}:  string variables may not be used as factor variables`,
        109,
      );
    if (term.kind !== "c") levelsOf(term.variable, rows);
  }
  const factors = terms.filter((term) => term.kind !== "c");
  if (
    new Set(factors.map((term) => term.variable.name)).size < factors.length ||
    terms.filter((term) => term.kind === "i").length > 1
  )
    throw unsupported(word);
  // c.x alone is x itself.
  if (terms.length === 1 && terms[0].kind === "c")
    return [{ variable: terms[0].variable.name }];
  const spelled = (term, level) =>
      term.kind === "c"
        ? `c.${term.variable.name}`
        : `${level ?? term.level}.${term.variable.name}`,
    product = (levelOf) =>
      Array.from({ length: data.n }, (_, i) => {
        let value = 1;
        for (const term of terms) {
          const v = term.variable.data[i];
          if (isMissing(v)) return MISSING;
          value *=
            term.kind === "c" ? v : Number(v === (levelOf(term) ?? term.level));
        }
        return value;
      }),
    free = terms.find((term) => term.kind === "i");
  if (!free) {
    // A level of one variable, as 1.g, joins the levels of g beside it
    // under g's name; alone it is shown as 1.g.
    if (terms.length === 1)
      return [
        {
          name: spelled(terms[0]),
          base: terms[0].variable.name,
          label: `${terms[0].level} `,
          shown: valueText(session, terms[0].variable, terms[0].level),
          single: true,
          values: product(() => null),
        },
      ];
    return [
      {
        name: terms.map((term) => spelled(term)).join("#"),
        values: product(() => null),
      },
    ];
  }
  // i.g, or i.g#c.x: one column for each level, grouped under g or g#c.x.
  const base = terms
    .map((term) => (term === free ? term.variable.name : spelled(term)))
    .join("#");
  // ib#. leaves out level #; i. and ibn. show every level.
  const omitted = /^ib(\d+)$/.exec(free.operator)?.[1];
  if (/^ib(?!n$|\d)|^b/.test(free.operator)) throw unsupported(word);
  const all = levelsOf(free.variable, rows),
    levels = all.filter(
      (level) => omitted === undefined || level !== Number(omitted),
    );
  // One level left is shown under its own name, as 1.g.
  const columns = levels.map((level) => ({
    single: levels.length === 1 && terms.length === 1,
    name: terms
      .map((term) => (term === free ? spelled(term, level) : spelled(term)))
      .join("#"),
    base,
    label: `${level} `,
    // The level's value label, which the table shows in its place.
    shown: terms.length === 1 ? valueText(session, free.variable, level) : null,
    level,
    values: product((term) => (term === free ? level : null)),
  }));
  // The base ib#. leaves out, where its level falls: mean and total post
  // it in e(b) as 2b.g, zero.
  if (omitted !== undefined && terms.length === 1 && all.length > levels.length)
    columns.splice(all.indexOf(Number(omitted)), 0, {
      omittedBase: true,
      name: `${omitted}b.${free.variable.name}`,
    });
  return columns;
}

/**
 * Runs a command with its factor-variable words made into temporary
 * variables. options.refuse gives the message of a command that takes none,
 * as correlate refuses them.
 */
export function factorVariables(run, options = {}) {
  return (session, text, ctx) => {
    // Parentheses in the varlist group names, as a varlist of factor
    // variables reads them, or are refused with the command's message.
    session.varlistParentheses = options.refuse ?? "factor";
    const end = varlistEnd(text),
      // i.(g h) is i.g i.h.
      listed = words(text.slice(0, end)).flatMap((word) => {
        // i(1 3).g is the levels 1.g and 3.g.
        const levels =
          /^i\(([^()]*)\)\.([\p{L}_][\w\u0080-\u{10FFFF}]*)$/u.exec(word);
        if (levels)
          return parseNumlist(levels[1]).map((n) => `${n}.${levels[2]}`);
        const m = /^(i\w*|c)\.\(([^()#]+)\)$/.exec(word);
        return m
          ? m[2]
              .trim()
              .split(/\s+/)
              .map((name) => `${m[1]}.${name}`)
          : [word];
      });
    if (!listed.some(isFactorWord)) return run(session, text, ctx);
    if (options.refuse) {
      // A level, as 1.g, is an operator such a command does not know.
      const level = listed.find((word) => /^\d+\./.test(word));
      if (level)
        throw new StataError(
          `${/^\d+/.exec(level)[0]}:  operator invalid`,
          198,
        );
      throw new StataError(options.refuse, 101);
    }
    // The levels of i.g are those in the observations if and in select.
    let selected;
    const rows = () => {
      if (selected === undefined)
        try {
          selected = session.rows(
            session.parse(
              "[if] [in] [fweight aweight pweight iweight] [, *]",
              text.slice(end),
            ),
            null,
          );
        } catch {
          selected = null;
        }
      return selected;
    };
    const data = session.data,
      names = [],
      made = [];
    try {
      let serial = 0;
      for (const word of listed) {
        if (!isFactorWord(word)) {
          names.push(word);
          continue;
        }
        for (const column of columnsOf(session, word, rows())) {
          if (column.omittedBase) {
            (ctx.factorBases ??= []).push({
              index: names.length,
              name: column.name,
            });
            continue;
          }
          if (column.variable) {
            names.push(column.variable);
            continue;
          }
          let name;
          do name = `__fv${String(++serial).padStart(4, "0")}`;
          while (data.has(name));
          data.generate(name, column.values, { type: "double" });
          const variable = data.get(name);
          variable.format = "%9.0g";
          // As an operated variable carries ts: grouped levels under their
          // base with the level as the row's label; a column alone shows
          // its own name.
          // list heads a column with its name broken after the level's
          // period or the last #: 1. over g, c.x# over c.x.
          const [, prefix = "", rest] = column.name.includes("#")
            ? /^(.*#)(.*)$/.exec(column.name)
            : /^(\d+\.)?(.*)$/.exec(column.name);
          variable.ts = column.base
            ? {
                variable: column.base,
                base: column.base,
                name: column.name,
                label: column.label,
                shown: column.shown ?? null,
                prefix,
                single: column.single,
                factor: true,
              }
            : {
                variable: rest,
                name: column.name,
                prefix,
                alone: true,
                factor: true,
              };
          made.push(variable);
          names.push(name);
        }
      }
      // A level standing alone, not beside others of its variable, is
      // shown under its own name.
      made.forEach((variable, k) => {
        if (!variable.ts.single) return;
        const near = (j) =>
          made[j]?.ts.base === variable.ts.base &&
          names.indexOf(made[j].name) ===
            names.indexOf(variable.name) + (j - k);
        if (!near(k - 1) && !near(k + 1)) variable.ts.alone = true;
      });
      // The command as typed, for e(cmdline).
      ctx.commandText ??= text;
      return run(session, `${names.join(" ")} ${text.slice(end)}`, ctx);
    } finally {
      if (ctx.commandText === text) delete ctx.commandText;
      delete ctx.factorBases;
      if (made.length)
        data.variables = data.variables.filter((v) => !made.includes(v));
    }
  };
}
