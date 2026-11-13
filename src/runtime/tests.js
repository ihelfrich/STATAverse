// Classical tests: prtest, sdtest, ranksum, signrank, oneway, kwallis and
// tabi. Layouts follow Stata's Results window; tests/runtime-output.test.mjs
// compares them with text recorded from installed Stata.
import { StataError } from "./errors.js";
import { applyFormat, displayValue } from "./format.js";
import { Ftail, chi2tail, invttail } from "./distributions.js";
import { invnormal, normal } from "./functions-normal.js";
import { FUNCTIONS } from "./functions.js";
import { ranks } from "./everyday.js";
import {
  count,
  labelled,
  moments,
  percentile,
  perGroup,
  tabulate,
} from "./reports.js";
import { Dataset } from "./store.js";
import { splitAtComma } from "./syntax.js";
import { MISSING, isMissing, isStringType } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const four = (value) => applyFormat(value, "%6.4f");
const RULE = "-".repeat(78);
/** Three alternative hypotheses, each centred on its column as Stata sets them. */
function alternatives(...items) {
  let line = "";
  items.forEach((item, k) => {
    const start = Math.ceil([10, 39, 69][k] - item.length / 2);
    line = line.padEnd(start) + item;
  });
  return line;
}

/**
 * The by-group a command runs in under the by prefix, as session.rows and
 * session.select take it, or null for the whole dataset.
 */
const scope = (ctx) => (ctx?.group ? { groups: [ctx.group] } : null);
/**
 * session.parse, with Stata's message for an option it does not take that
 * was typed with an argument: "option by() not allowed".
 */
function parseOptions(session, declaration, text) {
  try {
    return session.parse(declaration, text);
  } catch (error) {
    const m =
      error instanceof StataError &&
      error.code === 198 &&
      /^option ([A-Za-z_]\w*) not allowed$/.exec(error.message);
    if (m && new RegExp(`(^|[\\s,])${m[1]}\\s*\\(`).test(text))
      throw new StataError(`option ${m[1]}() not allowed`, 198);
    throw error;
  }
}

/** The values of a numeric variable in the rows given, without missings. */
const values = (variable, rows) =>
  rows.map((i) => variable.data[i]).filter((v) => !isMissing(v));
function numericVariable(session, name) {
  const variable = session.data.get(session.varlist(name)[0]);
  if (isStringType(variable.type))
    throw new StataError(
      `string variables not allowed in varlist;\n${variable.name} is a string variable`,
      109,
    );
  return variable;
}
/** Splits observations into the two groups of a by() variable. */
function twoGroups(session, parsed, variable) {
  const by = session.data.get(parsed.options.by[0]),
    rows = session
      .rows(parsed, null)
      .filter(
        (i) =>
          !isMissing(variable.data[i]) &&
          (typeof by.data[i] === "string"
            ? by.data[i] !== ""
            : !isMissing(by.data[i])),
      ),
    levels = [...new Set(rows.map((i) => by.data[i]))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
  if (levels.length !== 2)
    throw new StataError(
      `${levels.length} values of ${by.name} found; 2 expected`,
      420,
    );
  return {
    by,
    levels,
    labels: levels.map((level) => labelled(session, by, level)),
    groups: levels.map((level) => rows.filter((i) => by.data[i] === level)),
    rows,
  };
}
/** "varname == #", "varname = #" or "varname" before if, in and options. */
function target(text) {
  const m = /^\s*(\S+?)\s*(?:==?\s*([^\s,]+))?(\s[\s\S]*|,[\s\S]*)?$/.exec(
    text,
  );
  if (!m) throw new StataError("invalid syntax", 198);
  return { name: m[1], value: m[2], rest: m[3] ?? "" };
}

/** A number as a Stata macro holds it, as in "`p1' not in [0,1]". */
const macroNumber = (value) =>
  isMissing(value) ? "." : applyFormat(value, "%18.0g").trim();
/**
 * A number after a trip through a macro, as prtest.ado passes its counts and
 * proportions to prtesti: kept to the digits %18.0g shows.
 */
const viaMacro = (value) =>
  isMissing(value) ? value : Number(macroNumber(value));
/** The number an argument spells, as confirm number reads it, or undefined. */
function literal(token) {
  return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(token)
    ? Number(token)
    : undefined;
}
/**
 * confirm number, or with integer true confirm integer number, which takes
 * only digits: 50.0, 5e1 and 1e3 are not integers to it.
 */
function confirmNumber(token, integer) {
  const value = literal(token);
  if (value === undefined || (integer && !/^[+-]?\d+$/.test(token)))
    throw new StataError(
      `'${token}' found where ${integer ? "integer" : "number"} expected`,
      7,
    );
  return value;
}
/**
 * Stata's abbrev(s, 12), which drops a leading period first: the group .5
 * is labelled 5.
 */
function abbreviate(text) {
  return abbrev(text.startsWith(".") ? text.slice(1) : text, 12);
}
/** Stata's abbrev(name, n): the first n - 2 characters, ~ and the last. */
const abbrev = (name, n) =>
  name.length > n ? `${name.slice(0, n - 2)}~${name.at(-1)}` : name;
/** The first n characters of a string, as udsubstr(s, 1, n) takes them. */
const leading = (text, n) => Array.from(text).slice(0, n).join("");
/**
 * A {p indent indent right} paragraph, {p 0 0 2} unless said: words
 * wrapped right columns short of the line, each line indented.
 */
function paragraph(session, text, indent = 0, right = 2) {
  const width = (session.settings.linesize ?? 80) - right - indent,
    lines = [""];
  for (const word of text.split(" ")) {
    const last = lines.at(-1);
    if (last && last.length + 1 + word.length > width) lines.push(word);
    else lines[lines.length - 1] = last ? `${last} ${word}` : word;
  }
  return lines.map((line) => " ".repeat(indent) + line).join("\n");
}
/**
 * The hypothesised proportion as prtest and prtesti print it: six decimals
 * with trailing zeros dropped.
 */
function hypothesised(p0) {
  if (p0 < 1e-6) return applyFormat(p0, "%8.0g").trim();
  if (p0 > 1 - 1e-6) return "0.999999";
  let shown = applyFormat(p0, "%8.6f");
  for (let i = 0; i <= 5 && shown[7 - i] === "0"; i++)
    shown = shown.slice(0, 7 - i);
  return shown.trim();
}

// Stata arithmetic for the proportion tests: arithmetic on a missing value,
// division by zero and the root of a negative number are all missing.
// Inside the formulas NaN stands for missing; stata() turns it back.
const nan = (value) => (isMissing(value) ? NaN : value);
const over = (a, b) => (b === 0 ? NaN : a / b);
const stata = (value) => (Number.isFinite(value) ? value : MISSING);
/** The heading of a table, with [level% conf. interval] at 61 - its width. */
const heading = (left, level) =>
  `${left.padEnd(60 - g(level).length)}[${g(level)}% conf. interval]`;

/** The rows and tails prtest and prtesti print. */
function proportionPrinters(ctx, level) {
  // The interval in the table uses invnorm(vval); the one returned in r()
  // uses invnormal((100+level)/200), as prtesti.ado computes them.
  const shown = invnormal((100 - (100 - level) / 2) / 100),
    critical = invnormal((100 + level) / 200),
    row = (label, p, se) =>
      `${label.padStart(12)} |${g(p).padStart(11)}${g(se).padStart(11)}${" ".repeat(17)}${g(stata(nan(p) - shown * nan(se))).padStart(13)}${g(stata(nan(p) + shown * nan(se))).padStart(12)}`,
    tails = (z) => {
      // As prtesti.ado: the smaller tail is half the two-sided probability,
      // and a missing z leaves all three missing.
      const p = isMissing(z) ? MISSING : 2 * normal(-Math.abs(z)),
        half = isMissing(p) ? MISSING : p / 2,
        rest = isMissing(p) ? MISSING : 1 - half,
        [p_l, p_u] = z < 0 ? [half, rest] : [rest, half];
      ctx.out(
        isMissing(z)
          ? " Pr(Z < z) =      .         Pr(|Z| > |z|) =      .          Pr(Z > z) =      ."
          : ` Pr(Z < z) = ${four(p_l)}         Pr(|Z| > |z|) = ${four(p)}          Pr(Z > z) = ${four(p_u)}`,
      );
      ctx.out("");
      return { p_l, p, p_u };
    },
    // The z line: prtesti.ado's "z = " and %8.4f at column 67, which turns
    // to e-notation when z does not fit.
    statistic = (left, z) => `${left.padEnd(66)}z = ${applyFormat(z, "%8.4f")}`;
  return { critical, row, tails, statistic };
}

/**
 * The two-sample test from counts and proportions, as prtesti.ado runs it
 * after reading its arguments. texts are the proportions as the messages
 * spell them; xname and yname label the samples; xorig, the name prtest
 * passed, decides the heading of the label column.
 */
function twoProportions(ctx, session, sample) {
  const { n1, p1, n2, p2, level, count: counted } = sample,
    range = (p, text, n) => {
      // A missing proportion is larger than 1.
      if (p > 1 || p < 0)
        throw new StataError(
          counted ? `${text} not less than ${n}` : `${text} not in [0,1]`,
          198,
        );
    };
  range(p1, sample.texts[0], sample.counts?.[0]);
  range(p2, sample.texts[1], sample.counts?.[1]);
  if (n1 <= 1) throw new StataError("insufficient observations", 2001);
  ctx.out("");
  const name = (text, fallback) =>
      text ? leading(text.trim(), 12).trim() : fallback,
    x = name(sample.xname, "x"),
    y = name(sample.yname, "y"),
    { critical, row, tails, statistic } = proportionPrinters(ctx, level),
    // With n2 = 0 (an empty second sample) the standard errors are missing.
    pooled = over(n1 * p1 + n2 * p2, n1 + n2),
    s1 = stata(Math.sqrt(over(p1 * (1 - p1), n1))),
    s2 = stata(Math.sqrt(over(p2 * (1 - p2), n2))),
    se = stata(Math.sqrt(over(p1 * (1 - p1), n1) + over(p2 * (1 - p2), n2))),
    se0 = stata(
      Math.sqrt(
        over(pooled * (1 - pooled), n1) + over(pooled * (1 - pooled), n2),
      ),
    ),
    difference = p1 - p2,
    z = stata(over(difference, nan(se0))),
    // tnew's P>|z| under H0, 2 * (1 - normprob(abs(z))).
    underH0 = isMissing(z) ? MISSING : 2 * (1 - normal(Math.abs(z))),
    // The table shows no standard error for a sample of one.
    shownSe = (n, s) => (n === 1 || isMissing(n) ? MISSING : s),
    original = abbreviate(sample.xorig ?? ""),
    label = !original
      ? ""
      : isVariableName(session, original)
        ? "Variable"
        : "Group",
    width = (text) => Array.from(text).length,
    bound = (p, sign, s) => stata(p + sign * critical * nan(s));
  ctx.out(
    `${"Two-sample test of proportions".padEnd(52 - width(x))}${x}: Number of obs = ${applyFormat(n1, "%8.0g")}`,
  );
  ctx.out(
    `${" ".repeat(52 - width(y))}${y}: Number of obs = ${applyFormat(n2, "%8.0g")}`,
  );
  ctx.out(RULE);
  ctx.out(
    heading(
      `${label.padStart(12)} |       Mean   Std. err.      z    P>|z|`,
      level,
    ),
  );
  ctx.out(
    "-------------+----------------------------------------------------------------",
  );
  ctx.out(row(abbreviate(x), p1, shownSe(n1, s1)));
  ctx.out(row(abbreviate(y), p2, shownSe(n2, s2)));
  ctx.out(
    "-------------+----------------------------------------------------------------",
  );
  ctx.out(row("diff", difference, se));
  ctx.out(
    `             |  under H0:${g(se0).padStart(11)}${applyFormat(z, "%9.2f")}${applyFormat(underH0, "%8.3f")}`,
  );
  ctx.out(RULE);
  ctx.out(statistic(`        diff = prop(${x}) - prop(${y})`, z));
  ctx.out("    H0: diff = 0");
  ctx.out("");
  ctx.out(alternatives("Ha: diff < 0", "Ha: diff != 0", "Ha: diff > 0"));
  const { p_l, p, p_u } = tails(z);
  // In the order return list shows them, which reverses the order
  // prtesti.ado stores them.
  session.results.r = {
    N1: n1,
    N2: n2,
    P1: p1,
    P2: p2,
    P_diff: difference,
    se1: s1,
    se2: s2,
    se_diff0: se0,
    se_diff: se,
    lb1: bound(p1, -1, s1),
    ub1: bound(p1, 1, s1),
    lb2: bound(p2, -1, s2),
    ub2: bound(p2, 1, s2),
    lb_diff: bound(difference, -1, se),
    ub_diff: bound(difference, 1, se),
    z,
    p_l,
    p,
    p_u,
    level,
  };
}
/**
 * Whether confirm variable accepts every word of a label: each must be a
 * plain name, without the ~ of an abbreviated one, naming one variable.
 */
function isVariableName(session, text) {
  try {
    return text
      .split(/\s+/)
      .filter(Boolean)
      .every(
        (word) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(word) &&
          session.varlist(word).length === 1,
      );
  } catch {
    return false;
  }
}

/**
 * The one-sample table. prtest heads the label column Variable and gives
 * the count on its own line; prtesti, immediate, as the two-sample table
 * does.
 */
function oneProportion(ctx, session, one, name, p0, level, immediate) {
  const { critical, row, tails, statistic } = proportionPrinters(ctx, level),
    // An empty sample has a missing proportion, and at p0 = 0 or 1 the
    // statistic divides by zero: z is missing either way.
    se = stata(Math.sqrt(over(nan(one.p) * (1 - nan(one.p)), one.n))),
    z = stata(over(nan(one.p) - p0, Math.sqrt(over(p0 * (1 - p0), one.n)))),
    shown = hypothesised(p0),
    label = abbreviate(name);
  ctx.out(
    immediate
      ? `${"One-sample test of proportion".padEnd(51)}${name}: Number of obs = ${applyFormat(one.n, "%8.0g")}`
      : `${"One-sample test of proportion".padEnd(48)}Number of obs      = ${applyFormat(one.n, "%9.0g")}`,
  );
  if (!immediate) ctx.out("");
  ctx.out(RULE);
  ctx.out(
    heading(
      `${(immediate ? "" : "Variable").padStart(12)} |       Mean   Std. err.`,
      level,
    ),
  );
  ctx.out(
    "-------------+----------------------------------------------------------------",
  );
  // prtest.ado's _ttest1 shows no standard error for one observation.
  ctx.out(row(label, one.p, one.n === 1 ? MISSING : se));
  ctx.out(RULE);
  ctx.out(statistic(`    p = proportion(${label})`, z));
  ctx.out(`H0: p = ${shown}`);
  ctx.out("");
  ctx.out(
    alternatives(`Ha: p < ${shown}`, `Ha: p != ${shown}`, `Ha: p > ${shown}`),
  );
  const { p_l, p, p_u } = tails(z);
  session.results.r = {
    N: one.n,
    P: one.p,
    se,
    ub: stata(nan(one.p) + critical * nan(se)),
    lb: stata(nan(one.p) - critical * nan(se)),
    z,
    p_l,
    p,
    p_u,
    level,
  };
}

/** The count and mean of a variable's nonmissing values in the rows given. */
function countAndMean(variable, rows) {
  // summarize finds no observations in a string variable.
  const v = isStringType(variable.type) ? [] : values(variable, rows);
  return {
    n: v.length,
    p: v.length ? v.reduce((a, b) => a + b, 0) / v.length : MISSING,
  };
}
const notBinary = (text) =>
  new StataError(`${text} is not a 0/1 variable`, 450);
/** Whether a variable holds anything but 0, 1 and missing in the rows. */
const notZeroOne = (variable, rows) =>
  isStringType(variable.type) ||
  values(variable, rows).some((x) => x !== 0 && x !== 1);

/**
 * prtest's arguments as prtest.ado reads them: the variable, then after =
 * or == the expression, which runs to if, in or the comma outside quotes
 * and parentheses, then the rest.
 */
function prtestArguments(text) {
  const head = /^\s*([^\s=,]+)\s*/.exec(text);
  if (!head) throw new StataError("varlist required", 100);
  let rest = text.slice(head[0].length);
  const equals = /^==?/.exec(rest);
  if (!equals) return { name: head[1], rest: rest ? ` ${rest}` : "" };
  rest = rest.slice(equals[0].length);
  let depth = 0,
    quoted = false,
    end = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '"') quoted = !quoted;
    if (quoted) continue;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth <= 0 && c === ",") {
      end = i;
      break;
    } else if (depth <= 0 && /^\s(if|in)(\s|$)/.test(rest.slice(i))) {
      end = i;
      break;
    }
  }
  const expression = rest.slice(0, end).trim();
  if (!expression) throw new StataError("invalid syntax", 198);
  return { name: head[1], expression, rest: rest.slice(end) };
}
/**
 * The check syntax makes of =exp before prtest.ado runs: the expression must
 * compile and be numeric. Returns the compiled expression.
 */
function checkedExpression(session, expression) {
  let compiled;
  try {
    compiled = session.compile(expression);
  } catch (error) {
    if (!(error instanceof StataError)) throw error;
    if (error.code === 132)
      throw new StataError(
        /many/.test(error.message)
          ? "too many ')' or ']'"
          : "too few ')' or ']'",
        132,
      );
    if (error.code === 198) {
      // A second word is reported by itself; any other fault is syntax.
      const extra = /^(\S+) found where an operator was expected$/.exec(
        error.message,
      );
      throw new StataError(
        extra && expression.split(/\s+/).includes(extra[1])
          ? `invalid '${extra[1]}' `
          : "invalid syntax",
        198,
      );
    }
    throw error;
  }
  if (compiled.type !== "numeric") throw new StataError("type mismatch", 109);
  return compiled;
}
/**
 * unab exp : exp, max(1), as prtest.ado names the second variable: one
 * variable, perhaps in one pair of parentheses; an operator or a number is
 * an invalid name.
 */
function unabOne(session, expression) {
  const tokens = expression.match(/==|!=|~=|>=|<=|[A-Za-z0-9_.*?~]+|\S/g) ?? [];
  const names = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "(") {
      if (depth) throw new StataError("( not allowed", 101);
      depth = 1;
    } else if (token === ")") depth = 0;
    else if (token === "-") {
      // A range a-b: its end must be a name.
      const end = tokens[i + 1] ?? "";
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(end))
        throw new StataError(`${end} invalid name`, 198);
      names.push(...session.varlist(`${names.pop()}-${end}`));
      i++;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token))
      names.push(...session.varlist(token));
    else if (/^[A-Za-z0-9_]*[*?~][A-Za-z0-9_*?~]*$/.test(token)) {
      let found = [];
      try {
        found = session.varlist(token);
      } catch {
        // Reported below as not found.
      }
      if (!found.length)
        throw new StataError(`variable ${token} not found`, 111);
      names.push(...found);
    } else throw new StataError(`${token} invalid name`, 198);
  }
  if (names.length > 1)
    throw new StataError("too many variables specified", 103);
  if (!names.length) throw new StataError("too few variables specified", 102);
  return session.data.get(names[0]);
}
/** by(varname): one variable, with by()'s note when it is not found. */
function byVariable(session, text) {
  if (text === undefined) return undefined;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1)
    throw new StataError("by():  too many variables specified", 103);
  if (!words.length)
    throw new StataError("by():  too few variables specified", 102);
  let names;
  try {
    names = session.varlist(words[0]);
  } catch (error) {
    if (error instanceof StataError)
      throw new StataError(
        `${error.message}\n(error in option by())`,
        error.code,
      );
    throw error;
  }
  if (names.length > 1)
    throw new StataError("by():  too many variables specified", 103);
  return names[0];
}

/**
 * prtest var == #p, prtest var1 == var2 and prtest var, by(group), as
 * prtest.ado tells them apart: a number after == is the one-sample test,
 * any other expression names the second variable.
 */
function prtest(session, text, ctx) {
  const t = prtestArguments(text),
    parsed = session.parse("[if] [in] [, BY(string) Level(cilevel)]", t.rest),
    level = parsed.options.level,
    variable = session.data.get(session.varlist(t.name)[0]),
    by = byVariable(session, parsed.options.by),
    rows = session.rows(parsed, scope(ctx));
  if (t.expression !== undefined) {
    const compiled = checkedExpression(session, t.expression);
    if (by) throw new StataError("may not combine == and option by()", 198);
    const p0 = literal(t.expression);
    if (p0 === undefined)
      return twoVariables(session, ctx, variable, t.expression, compiled, {
        rows,
        level,
      });
    if (notZeroOne(variable, rows)) throw notBinary(variable.name);
    const one = countAndMean(variable, rows);
    if (one.n && !(p0 > 0 && p0 < 1))
      throw new StataError(`${t.expression} is not in (0,1)`, 450);
    ctx.out("");
    return oneProportion(ctx, session, one, variable.name, p0, level, false);
  }
  if (!by) throw new StataError("option by() required", 100);
  byGroups(session, ctx, variable, by, rows, level);
}

/**
 * prtest var1 == var2: each variable's own nonmissing values. The second
 * proportion is checked as an expression, then must name one variable.
 */
function twoVariables(session, ctx, variable, expression, compiled, sample) {
  const { rows, level } = sample;
  if (notZeroOne(variable, rows)) throw notBinary(variable.name);
  const env = { start: 0, count: session.data.n, sums: [] };
  if (
    rows.some((i) => {
      const v = compiled.evaluate(i, env);
      return !isMissing(v) && v !== 0 && v !== 1;
    })
  )
    throw notBinary(expression);
  const other = unabOne(session, expression);
  passToPrtesti(session, ctx, [variable, other], {
    rows: [rows, rows],
    level,
    names: [variable.name, other.name],
  });
}
/**
 * prtest.ado's call of prtesti with each sample's count and mean as macros
 * hold them; an empty sample passes a missing mean, ".", which prtesti then
 * reads as it reads any argument.
 */
function passToPrtesti(session, ctx, variables, sample) {
  const [a, b] = variables.map((variable, k) =>
    countAndMean(variable, sample.rows[k]),
  );
  immediateTest(
    session,
    ctx,
    [String(a.n), macroNumber(a.p), String(b.n), macroNumber(b.p)],
    () => ({ level: sample.level, count: false }),
    { xname: sample.names[0], yname: sample.names[1] },
  );
}

/**
 * prtest var, by(group). The outcome and the group must each take two
 * values in the if/in sample. A numeric group compares its smallest and
 * largest values; a string group compares the value of the first
 * observation with the first value that differs from it, which may be the
 * empty string, as prtest.ado finds them.
 */
function byGroups(session, ctx, variable, byName, rows, level) {
  const by = session.data.get(byName),
    distinct = (v) =>
      new Set(
        rows
          .map((i) => v.data[i])
          .filter((x) => (isStringType(v.type) ? x !== "" : !isMissing(x))),
      ).size,
    outcomes = distinct(variable);
  if (outcomes !== 2)
    throw new StataError(
      `${variable.name} takes on ${outcomes} values, not 2`,
      450,
    );
  const string = isStringType(by.type),
    present = rows
      .map((i) => by.data[i])
      .filter((v) => (string ? v !== "" : !isMissing(v)));
  if (new Set(present).size !== 2)
    throw new StataError(
      `${by.name} takes on ${new Set(present).size} values, not 2`,
      450,
    );
  let levels, names;
  if (string) {
    // prtest.ado numbers the sample with generate, which reports the
    // observations outside it.
    const outside = session.data.n - rows.length;
    if (outside)
      ctx.out(
        `(${count(outside)} missing value${outside === 1 ? "" : "s"} generated)`,
      );
    const first = by.data[rows[0]],
      second = by.data[rows.find((i) => by.data[i] !== first)];
    levels = first < second ? [first, second] : [second, first];
    names = levels.map((level) => leading(level, 8));
  } else {
    levels = [
      present.reduce((a, b) => Math.min(a, b)),
      present.reduce((a, b) => Math.max(a, b)),
    ];
    const map = session.data.valueLabels.get(by.valueLabel);
    names = levels.map(
      (level) => (map?.get(level) || undefined) ?? macroNumber(level),
    );
  }
  passToPrtesti(session, ctx, [variable, variable], {
    rows: levels.map((level) => rows.filter((i) => by.data[i] === level)),
    level,
    names,
  });
}

/**
 * prtesti n p p0, and prtesti n1 p1 n2 p2, from summary statistics; with
 * count the proportions are given as counts of successes.
 */
function prtesti(session, text, ctx) {
  const [head, optionText] = splitAtComma(text);
  immediateTest(
    session,
    ctx,
    head.trim().split(/\s+/).filter(Boolean),
    () => prtestiOptions(session, optionText),
    {},
  );
}
/**
 * prtesti.ado's reading of its arguments, in its order and with its
 * messages: tokens are the arguments before the comma, readOptions parses
 * the options when prtesti.ado does, and names carries the labels prtest
 * passes in xname() and yname().
 */
function immediateTest(session, ctx, tokens, readOptions, names) {
  if (tokens.length < 3 || tokens.length > 4)
    throw new StataError(
      paragraph(
        session,
        "either three arguments for a one-sample test or four arguments for a two-sample test must be specified",
      ),
      198,
    );
  const two = tokens.length === 4 && literal(tokens[3]) !== undefined,
    n1 = confirmNumber(tokens[0], true),
    // local p = p/n: division by zero is missing.
    share = (p, n) => viaMacro(stata(over(p, n)));
  let p1 = confirmNumber(tokens[1], false);
  if (two) {
    const n2 = confirmNumber(tokens[2], true);
    let p2 = confirmNumber(tokens[3], false);
    const options = readOptions(),
      texts = [tokens[1], tokens[3]];
    if (options.count) {
      confirmNumber(tokens[1], true);
      confirmNumber(tokens[3], true);
      if (p1 <= n1) texts[0] = macroNumber((p1 = share(p1, n1)));
      if (p2 <= n2) texts[1] = macroNumber((p2 = share(p2, n2)));
    }
    const xname = names.xname ?? options.xname,
      yname = names.yname ?? options.yname;
    return twoProportions(ctx, session, {
      n1,
      p1,
      n2,
      p2,
      texts,
      counts: [tokens[0], tokens[2]],
      count: options.count,
      level: options.level,
      xname,
      yname,
      xorig: xname,
    });
  }
  const p0 = confirmNumber(tokens[2], false),
    outside = (p) => p > 1 || p < 0;
  if (outside(p0)) throw new StataError(`${tokens[2]} not in [0,1]`, 198);
  // A fourth argument that is not a number is a varlist to the parse of
  // the options.
  if (tokens.length === 4) throw new StataError("varlist not allowed", 101);
  const options = readOptions();
  let shown = tokens[1];
  if (options.count) {
    confirmNumber(tokens[1], true);
    if (p1 <= n1) shown = macroNumber((p1 = share(p1, n1)));
    if (outside(p1))
      throw new StataError(`${shown} not less than ${tokens[0]}`, 198);
  } else if (outside(p1)) throw new StataError(`${shown} not in [0,1]`, 198);
  if (n1 <= 1) throw new StataError("insufficient observations", 2001);
  ctx.out("");
  oneProportion(
    ctx,
    session,
    { n: n1, p: p1 },
    "x",
    // Under count the successes are a count; the hypothesis stays a share.
    p0,
    options.level,
    true,
  );
}
const prtestiOptions = (session, optionText) =>
  session.parse(
    "[, Level(cilevel) Count Xname(string) Yname(string)]",
    optionText ? "," + optionText : "",
  ).options;

function sdtest(session, text, ctx) {
  const t = target(text),
    parsed = session.parse("[if] [in] [, BY(varlist) Level(cilevel)]", t.rest),
    level = parsed.options.level,
    variable = numericVariable(session, t.name),
    row = (label, m) => {
      const se = m.sd / Math.sqrt(m.n),
        critical = invttail(m.n - 1, (1 - level / 100) / 2);
      return `${label.padStart(8)} |${count(m.n).padStart(8)}${g(m.mean).padStart(12)}${g(se).padStart(12)}${g(m.sd).padStart(12)}${g(m.mean - critical * se).padStart(12)}${g(m.mean + critical * se).padStart(12)}`;
    },
    head = (first) =>
      `${first.padStart(8)} |     Obs        Mean    Std. err.   Std. dev.   [${g(level)}% conf. interval]`,
    middle =
      "---------+--------------------------------------------------------------------";
  ctx.out("");
  if (parsed.options.by) {
    const two = twoGroups(session, parsed, variable),
      [a, b] = two.groups.map((rows) => moments(values(variable, rows))),
      all = moments(values(variable, two.rows)),
      f = a.variance / b.variance,
      lower = 1 - Ftail(a.n - 1, b.n - 1, f),
      upper = 1 - lower,
      p = 2 * Math.min(lower, upper);
    ctx.out("Variance ratio test");
    ctx.out(RULE);
    ctx.out(head("Group"));
    ctx.out(middle);
    ctx.out(row(two.labels[0], a));
    ctx.out(row(two.labels[1], b));
    ctx.out(middle);
    ctx.out(row("Combined", all));
    ctx.out(RULE);
    ctx.out(
      `${`    ratio = sd(${two.labels[0]}) / sd(${two.labels[1]})`.padEnd(66)}f =${applyFormat(f, "%9.4f")}`,
    );
    ctx.out(
      `${"H0: ratio = 1".padEnd(49)}Degrees of freedom =${`${a.n - 1}, ${b.n - 1}`.padStart(9)}`,
    );
    ctx.out("");
    ctx.out(alternatives("Ha: ratio < 1", "Ha: ratio != 1", "Ha: ratio > 1"));
    ctx.out(
      `  Pr(F < f) = ${four(lower)}         2*Pr(F ${lower <= upper ? "<" : ">"} f) = ${four(p)}           Pr(F > f) = ${four(upper)}`,
    );
    ctx.out("");
    session.results.r = {
      sd: all.sd,
      p,
      p_l: lower,
      p_u: upper,
      sd_2: b.sd,
      sd_1: a.sd,
      F: f,
      df_2: b.n - 1,
      df_1: a.n - 1,
      N: all.n,
    };
    return;
  }
  if (t.value === undefined) throw new StataError("invalid syntax", 198);
  const sd0 = session.scalar(t.value),
    m = moments(values(variable, session.rows(parsed, null))),
    df = m.n - 1,
    chi2 = (df * m.variance) / (sd0 * sd0),
    upper = chi2tail(df, chi2),
    lower = 1 - upper,
    p = 2 * Math.min(lower, upper),
    shown = g(sd0);
  ctx.out("One-sample test of variance");
  ctx.out(RULE);
  ctx.out(head("Variable"));
  ctx.out(middle);
  ctx.out(row(variable.name, m));
  ctx.out(RULE);
  ctx.out(
    `${`    sd = sd(${variable.name})`.padEnd(59)}c = chi2 =${applyFormat(chi2, "%9.4f")}`,
  );
  ctx.out(
    `${`H0: sd = ${shown}`.padEnd(49)}Degrees of freedom =${count(df).padStart(9)}`,
  );
  ctx.out("");
  ctx.out(
    alternatives(
      `Ha: sd < ${shown}`,
      `Ha: sd != ${shown}`,
      `Ha: sd > ${shown}`,
    ),
  );
  ctx.out(
    `  Pr(C < c) = ${four(lower)}         2*Pr(C ${lower <= upper ? "<" : ">"} c) = ${four(p)}           Pr(C > c) = ${four(upper)}`,
  );
  ctx.out("");
  session.results.r = { p, p_l: lower, p_u: upper, sd: m.sd, chi2, df, N: m.n };
}

/**
 * The distribution of the sum of `size` of the given integer weights, as
 * counts by sum. With size null, every subset counts (signed-rank).
 */
function subsetSums(weights, size) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (size === null) {
    let ways = new Float64Array(total + 1);
    ways[0] = 1;
    for (const w of weights) {
      const next = ways.slice();
      for (let s = 0; s + w <= total; s++) next[s + w] += ways[s];
      ways = next;
    }
    return ways;
  }
  // ways[k][s]: subsets of k weights summing to s.
  const ways = Array.from(
    { length: size + 1 },
    () => new Float64Array(total + 1),
  );
  ways[0][0] = 1;
  for (const w of weights)
    for (let k = size; k >= 1; k--)
      for (let s = total; s >= w; s--) ways[k][s] += ways[k - 1][s - w];
  return ways[size];
}
function exactTails(ways, observed) {
  let all = 0,
    lower = 0,
    upper = 0;
  ways.forEach((n, s) => {
    all += n;
    if (s <= observed) lower += n;
    if (s >= observed) upper += n;
  });
  return { lower: lower / all, upper: upper / all };
}
const varianceLines = (ctx, rows) => {
  rows.forEach(([label, value], k) => {
    if (k === rows.length - 1) ctx.out("                     ----------");
    ctx.out(`${label.padEnd(21)}${applyFormat(value + 0, "%10.2f")}`);
  });
};

function ranksum(session, text, ctx) {
  const parsed = session.parse(
      "varname [if] [in] , BY(varlist) [| EXact POrder]",
      text,
    ),
    variable = numericVariable(session, parsed.varlist[0]),
    two = twoGroups(session, parsed, variable),
    all = ranks(two.rows.map((i) => variable.data[i])),
    position = new Map(two.rows.map((i, k) => [i, k])),
    n = two.rows.length,
    [n1, n2] = two.groups.map((group) => group.length),
    sum1 = two.groups[0].reduce((t, i) => t + all[position.get(i)], 0),
    expected1 = (n1 * (n + 1)) / 2,
    unadjusted = (n1 * n2 * (n + 1)) / 12,
    adjusted = (n1 * n2 * moments(all).variance) / n,
    z = (sum1 - expected1) / Math.sqrt(adjusted),
    p = 2 * normal(-Math.abs(z)),
    row = (label, obs, rank, expect) =>
      `${label.padStart(12)} |${count(obs).padStart(9)}${g(rank).padStart(12)}${g(expect).padStart(12)}`,
    rule = "-------------+---------------------------------",
    name = two.by.name;
  ctx.out("");
  ctx.out("Two-sample Wilcoxon rank-sum (Mann–Whitney) test");
  ctx.out("");
  ctx.out(`${name.padStart(12)} |      Obs    Rank sum    Expected`);
  ctx.out(rule);
  ctx.out(row(two.labels[0], n1, sum1, expected1));
  ctx.out(row(two.labels[1], n2, (n * (n + 1)) / 2 - sum1, (n2 * (n + 1)) / 2));
  ctx.out(rule);
  ctx.out(row("Combined", n, (n * (n + 1)) / 2, (n * (n + 1)) / 2));
  ctx.out("");
  varianceLines(ctx, [
    ["Unadjusted variance", unadjusted],
    ["Adjustment for ties", adjusted - unadjusted],
    ["Adjusted variance", adjusted],
  ]);
  ctx.out("");
  ctx.out(
    `H0: ${variable.name}(${name}==${two.labels[0]}) = ${variable.name}(${name}==${two.labels[1]})`,
  );
  ctx.out(`         z = ${applyFormat(z, "%6.3f")}`);
  ctx.out(`Prob > |z| = ${four(p)}`);
  session.results.r = {
    N: n,
    N_1: n1,
    N_2: n2,
    group1: typeof two.levels[0] === "number" ? two.levels[0] : 1,
    sum_obs: sum1,
    sum_exp: expected1,
    Var_a: adjusted,
    z,
    p,
    p_l: normal(z),
    p_u: 1 - normal(z),
  };
  if (n <= 200) {
    // Ranks are whole or half numbers; doubled, they are integers.
    const doubled = all.map((r) => Math.round(2 * r)),
      exact = exactTails(subsetSums(doubled, n1), Math.round(2 * sum1)),
      pExact = Math.min(1, 2 * Math.min(exact.lower, exact.upper));
    ctx.out(`Exact prob = ${four(pExact)}`);
    Object.assign(session.results.r, {
      p_exact: pExact,
      p_l_exact: exact.lower,
      p_u_exact: exact.upper,
    });
  }
  ctx.out("");
}

function signrank(session, text, ctx) {
  const m = /^\s*(\S+?)\s*=\s*([^,]+?)(\s+(?:if|in)\s[\s\S]*|,[\s\S]*)?$/.exec(
    text,
  );
  if (!m) throw new StataError("invalid syntax", 198);
  const parsed = session.parse("[if] [in] [, | EXact]", m[3] ?? ""),
    variable = numericVariable(session, m[1]),
    other = session.compile(m[2]),
    env = { start: 0, count: session.data.n, sums: [] },
    differences = session
      .rows(parsed, null)
      .map((i) => {
        const a = variable.data[i],
          b = other.evaluate(i, env);
        return isMissing(a) || isMissing(b) ? null : a - b;
      })
      .filter((d) => d !== null),
    n = differences.length;
  if (!n) throw new StataError("no observations", 2000);
  const rank = ranks(differences.map(Math.abs)),
    sum = (keep) =>
      differences.reduce((t, d, k) => t + (keep(d) ? rank[k] : 0), 0),
    number = (keep) => differences.filter(keep).length,
    positive = sum((d) => d > 0),
    negative = sum((d) => d < 0),
    zeroSum = sum((d) => d === 0),
    zeros = number((d) => d === 0),
    expected = (n * (n + 1)) / 4 - zeroSum / 2,
    unadjusted = (n * (n + 1) * (2 * n + 1)) / 24,
    zeroAdjustment = 0 - (zeros * (zeros + 1) * (2 * zeros + 1)) / 24,
    adjusted =
      differences.reduce(
        (t, d, k) => t + (d === 0 ? 0 : rank[k] * rank[k]),
        0,
      ) / 4,
    z = (positive - expected) / Math.sqrt(adjusted),
    p = 2 * normal(-Math.abs(z)),
    row = (label, obs, ranksum, expect) =>
      `${label.padStart(12)} |${count(obs).padStart(9)}${g(ranksum).padStart(12)}${g(expect).padStart(12)}`,
    rule = "-------------+---------------------------------",
    total = (n * (n + 1)) / 2;
  ctx.out("");
  ctx.out("Wilcoxon signed-rank test");
  ctx.out("");
  ctx.out("        Sign |      Obs   Sum ranks    Expected");
  ctx.out(rule);
  ctx.out(
    row(
      "Positive",
      number((d) => d > 0),
      positive,
      expected,
    ),
  );
  ctx.out(
    row(
      "Negative",
      number((d) => d < 0),
      negative,
      expected,
    ),
  );
  ctx.out(row("Zero", zeros, zeroSum, zeroSum));
  ctx.out(rule);
  ctx.out(row("All", n, total, total));
  ctx.out("");
  varianceLines(ctx, [
    ["Unadjusted variance", unadjusted],
    ["Adjustment for ties", adjusted - unadjusted - zeroAdjustment],
    ["Adjustment for zeros", zeroAdjustment],
    ["Adjusted variance", adjusted],
  ]);
  ctx.out("");
  ctx.out(`H0: ${variable.name} = ${m[2].trim()}`);
  ctx.out(`         z = ${applyFormat(z, "%6.3f")}`);
  ctx.out(`Prob > |z| = ${four(p)}`);
  session.results.r = {
    N: n,
    N_pos: number((d) => d > 0),
    N_neg: number((d) => d < 0),
    N_tie: zeros,
    sum_pos: positive,
    sum_neg: negative,
    Var_a: adjusted,
    z,
    p,
    p_l: normal(z),
    p_u: 1 - normal(z),
  };
  if (n <= 200) {
    const doubled = differences
        .map((d, k) => (d === 0 ? null : Math.round(2 * rank[k])))
        .filter((w) => w !== null),
      exact = exactTails(subsetSums(doubled, null), Math.round(2 * positive)),
      pExact = Math.min(1, 2 * Math.min(exact.lower, exact.upper));
    ctx.out(`Exact prob = ${four(pExact)}`);
    Object.assign(session.results.r, {
      p_exact: pExact,
      p_l_exact: exact.lower,
      p_u_exact: exact.upper,
    });
  }
  ctx.out("");
}

/** The observations of a response grouped by the levels of a factor. */
function grouped(session, parsed, within = null) {
  const variable = numericVariable(session, parsed.varlist[0]),
    by = session.data.get(parsed.options?.by?.[0] ?? parsed.varlist[1]),
    rows = session
      .rows(parsed, within)
      .filter(
        (i) =>
          !isMissing(variable.data[i]) &&
          (typeof by.data[i] === "string"
            ? by.data[i] !== ""
            : !isMissing(by.data[i])),
      ),
    levels = [...new Set(rows.map((i) => by.data[i]))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
  return {
    variable,
    by,
    rows,
    levels,
    groups: levels.map((level) => rows.filter((i) => by.data[i] === level)),
  };
}

// Binomial probabilities by Loader's saddle-point method (Loader 2000, "Fast
// and accurate computation of binomial probabilities"), which keeps each
// term's relative error near machine precision for any number of trials.
// Adding up log-factorials instead loses digits as n grows: at n = 1e6 the
// tails were wrong in the seventh digit.
const LN_2PI = 1.837877066409345483560659472811;
// stirlerr(n) = ln n! - (n + 1/2) ln n + n - ln sqrt(2 pi), for n = 0..15.
const STIRLING_ERRORS = [
  0, 0.0810614667953272582196702, 0.0413406959554092940938221,
  0.02767792568499833914878929, 0.02079067210376509311152277,
  0.01664469118982119216319487, 0.01387612882307074799874573,
  0.01189670994589177009505572, 0.010411265261972096497478567,
  0.009255462182712732917728637, 0.008330563433362871256469318,
  0.007573675487951840794972024, 0.006942840107209529865664152,
  0.006408994188004207068439631, 0.005951370112758847735624416,
  0.00555473355196280137103869,
];
function stirlingError(n) {
  if (n <= 15) return STIRLING_ERRORS[n];
  const nn = n * n,
    [s0, s1, s2, s3, s4] = [1 / 12, 1 / 360, 1 / 1260, 1 / 1680, 1 / 1188];
  if (n > 500) return (s0 - s1 / nn) / n;
  if (n > 80) return (s0 - (s1 - s2 / nn) / nn) / n;
  if (n > 35) return (s0 - (s1 - (s2 - s3 / nn) / nn) / nn) / n;
  return (s0 - (s1 - (s2 - (s3 - s4 / nn) / nn) / nn) / nn) / n;
}
/** x ln(x / m) + m - x, without cancellation when x is near m. */
function deviance(x, m) {
  if (Math.abs(x - m) < 0.1 * (x + m)) {
    let v = (x - m) / (x + m),
      s = (x - m) * v,
      term = 2 * x * v;
    v *= v;
    for (let j = 1; j < 1000; j++) {
      term *= v;
      const next = s + term / (2 * j + 1);
      if (next === s) break;
      s = next;
    }
    return s;
  }
  return x * Math.log(x / m) + m - x;
}
/** ln Pr(X = x) for X binomial(n, p); q is 1 - p. */
function logBinomial(n, x, p, q) {
  if (x < 0 || x > n) return -Infinity;
  if (x === 0) return p < 0.1 ? -deviance(n, n * q) - n * p : n * Math.log(q);
  if (x === n) return q < 0.1 ? -deviance(n, n * p) - n * q : n * Math.log(p);
  return (
    stirlingError(n) -
    stirlingError(x) -
    stirlingError(n - x) -
    deviance(x, n * p) -
    deviance(n - x, n * q) -
    // ln((n - x) / n): log1p(-x / n) loses digits when x is near n, since
    // 1 - x / n then keeps only its absolute precision.
    0.5 * (LN_2PI + Math.log(x) + Math.log((n - x) / n))
  );
}
/**
 * Pr(X >= k), Stata's Binomial(n, k, p). A tail beyond the mode is summed
 * from k outward until the terms no longer count; otherwise it is one less
 * the opposite tail, which is then the small one.
 */
function binomialUpper(n, k, p, q = 1 - p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  const mode = Math.floor((n + 1) * p),
    sum = (from, step) => {
      // Neumaier's compensated sum of decreasing terms.
      let total = 0,
        carry = 0;
      for (let j = from; j >= 0 && j <= n; j += step) {
        const term = Math.exp(logBinomial(n, j, p, q)),
          next = total + term;
        carry +=
          Math.abs(total) >= term ? total - next + term : term - next + total;
        total = next;
        if (term <= total * 1e-17) break;
      }
      return total + carry;
    };
  return k > mode ? Math.min(1, sum(k, 1)) : Math.max(0, 1 - sum(k - 1, -1));
}
/**
 * Pr(X <= k), as bitesti.ado writes it: Binomial(n, n - k, 1 - p). The
 * success probability of that call is 1 - p rounded to a double, and its
 * complement 1 - (1 - p) is what Stata works with, so it is used here too:
 * for p near 0 it moves the result in the ninth digit.
 */
const binomialLower = (n, k, p) => binomialUpper(n, n - k, 1 - p);
const lnfact = FUNCTIONS.lnfactorial.fn;

/**
 * bitesti.ado's OppoTail: the k on the other side of n p whose probability
 * is no larger than that of the observed k while the next one in is, found
 * by its interpolating search on -ln Pr(X = k). -1 or n + 1 mean the
 * opposite tail is empty.
 */
function oppositeTail(n, observed, assumed) {
  const eps = 1e-7;
  if (Math.abs(assumed - 0.5) < eps) return n - observed;
  // -ln Pr(X = k) as bitesti.ado's LnBiDens computes it from lnfact();
  // outside 0..n it is missing, larger than every number. Where two
  // probabilities lie within peps of each other, the k chosen depends on
  // the rounding of lnfact, so the search uses Stata's formula.
  const minusLog = (k, p) =>
      k < 0 || k > n
        ? Infinity
        : -lnfact(n) +
          lnfact(k) +
          lnfact(n - k) -
          k * Math.log(p) -
          (n - k) * Math.log1p(-p),
    pobs = minusLog(observed, assumed),
    peps = pobs * eps,
    flip = observed > n * assumed,
    p = flip ? 1 - assumed : assumed,
    k = flip ? n - observed : observed,
    back = (kopp) => (flip ? n - kopp : kopp);
  let lo = Math.trunc(n * p + eps);
  if (k === lo) {
    if (minusLog(k + 1, p) >= pobs - peps) return back(k + 1);
    lo = k + 1;
  }
  let hi = n,
    kopp = Math.round(2 * n * p - k),
    popp = 2,
    p1 = 0,
    first = true;
  for (let i = 0; i <= 100; i++) {
    // Step: p1 is -ln Pr(X = kopp - 1) and popp is -ln Pr(X = kopp).
    let next;
    if (first) next = kopp;
    else {
      const slope = popp - p1;
      // Arithmetic on a missing value, or division by zero, is missing.
      next =
        Number.isFinite(popp) && Number.isFinite(p1) && slope !== 0
          ? Math.floor(kopp - (popp - pobs) / slope + 0.5)
          : Infinity;
    }
    first = false;
    if (next < lo) next = lo;
    else if (next > hi) next = hi;
    p1 = minusLog(next, p);
    if (p1 < pobs) {
      kopp = next + 1;
      lo = kopp;
      popp = minusLog(kopp, p);
    } else {
      kopp = next;
      hi = kopp - 1;
      popp = p1;
      p1 = minusLog(kopp - 1, p);
    }
    if (p1 < pobs && popp >= pobs - peps) return back(kopp);
  }
  return MISSING;
}

/**
 * bitesti.ado's BiDens: Pr(X = j) as the difference of two tail
 * probabilities, the upper ones above n p and the lower ones below it.
 */
function binomialDensity(n, j, p) {
  if (j < 0 || j > n) return 0;
  if (j > n * p)
    return binomialUpper(n, j, p) - (j < n ? binomialUpper(n, j + 1, p) : 0);
  return (
    binomialUpper(n, n - j, 1 - p) -
    (j > 0 ? binomialUpper(n, n - j + 1, 1 - p) : 0)
  );
}

/**
 * The exact binomial test of k successes in n trials against p, as
 * bitesti.ado prints it once its arguments are checked. The two-sided
 * probability adds the tail on the other side of n p that starts at
 * bitesti.ado's opposite k. name is bitest's variable; with detail the
 * probabilities of the observed k, the opposite k and the k next to it
 * follow.
 */
function binomialTest(ctx, session, test) {
  const { n, k, p, name, detail } = test,
    kopp = oppositeTail(n, k, p),
    upper = binomialUpper(n, k, p),
    lower = binomialLower(n, k, p),
    commas = (v) => applyFormat(v, "%12.0fc").trim(),
    six = (v) => applyFormat(v, "%8.6f"),
    lead = name === undefined ? "" : `${abbrev(name, 12).padStart(12)} |`,
    shown = commas(k),
    // Each line's = sits at column coleq, as bitesti.ado places it; a
    // label that reaches it is followed directly by the =.
    line = (label, coleq, value, note) =>
      `${`  ${label}`.padEnd(coleq - 1)}= ${six(value)}${note ? `  (${note})` : ""}`,
    empty = kopp === -1 || kopp === n + 1;
  ctx.out("");
  ctx.out("Binomial probability test");
  ctx.out("");
  ctx.out(
    `${name === undefined ? "" : "    Variable |"}            N   Observed k   Expected k   Assumed p   Observed p`,
  );
  ctx.out(`${name === undefined ? "" : "-------------+"}${"-".repeat(64)}`);
  ctx.out(
    `${lead}${applyFormat(n, "%13.0fc")} ${applyFormat(k, "%12.0fc")} ${applyFormat(n * p, "%12.0gc")} ${applyFormat(p, "%11.5f")} ${applyFormat(k / n, "%12.5f")}`,
  );
  ctx.out("");
  let coleq, results;
  if (empty) {
    // Nothing on the other side is as unlikely: the two-sided probability is
    // the observed tail, and Stata notes that the other tail is empty.
    coleq = 3 + shown.length + 10;
    const high = k > n * p,
      both = high ? upper : lower;
    ctx.out(line(`Pr(k >= ${shown})`, coleq, upper, "one-sided test"));
    ctx.out(line(`Pr(k <= ${shown})`, coleq, lower, "one-sided test"));
    ctx.out(
      line(
        `Pr(k ${high ? ">" : "<"}= ${shown})`,
        coleq,
        both,
        "two-sided test",
      ),
    );
    ctx.out("");
    ctx.out(
      `  note: ${high ? "lower" : "upper"} tail of two-sided p-value is empty`,
    );
    ctx.out("");
    // In the order return list shows them.
    results = {
      p: both,
      k_opp: MISSING,
      k,
      P_p: p,
      N: n,
      p_l: lower,
      p_u: upper,
    };
  } else {
    const k1 = Math.min(k, kopp),
      k2 = Math.max(k, kopp),
      twoSided = Math.min(1, binomialUpper(n, k2, p) + binomialLower(n, k1, p));
    coleq = 3 + commas(k1).length + commas(k2).length + 19;
    ctx.out(line(`Pr(k >= ${shown})`, coleq, upper, "one-sided test"));
    ctx.out(line(`Pr(k <= ${shown})`, coleq, lower, "one-sided test"));
    ctx.out(
      line(
        `Pr(k <= ${commas(k1)} or k >= ${commas(k2)})`,
        coleq,
        twoSided,
        "two-sided test",
      ),
    );
    ctx.out("");
    results = {
      k_opp: kopp,
      p: twoSided,
      k,
      P_p: p,
      N: n,
      p_l: lower,
      p_u: upper,
    };
  }
  if (detail) {
    // The k next to the opposite one, toward k; with an empty opposite
    // tail, the end of the range on that side.
    let next;
    if (!empty) {
      const k1 = kopp - Math.sign(kopp - k);
      if (k1 !== k && k1 !== kopp) next = k1;
    } else next = kopp === -1 ? 0 : n;
    const added = {},
      observed = binomialDensity(n, k, p);
    ctx.out(line(`Pr(k == ${shown})`, coleq, observed, "observed"));
    if (next !== undefined) {
      const density = binomialDensity(n, next, p);
      ctx.out(line(`Pr(k == ${commas(next)})`, coleq, density));
      added.P_noppk = density;
      added.k_nopp = next;
    }
    if (!empty) {
      const density = binomialDensity(n, kopp, p);
      ctx.out(
        line(`Pr(k == ${commas(kopp)})`, coleq, density, "opposite extreme"),
      );
      added.P_oppk = density;
    }
    added.P_k = observed;
    ctx.out("");
    results = { ...reorderDetail(added), ...results };
  }
  session.results.r = results;
}
/** The detail results in the order return list shows them. */
const reorderDetail = (added) =>
  Object.fromEntries(
    ["P_oppk", "P_noppk", "k_nopp", "P_k"]
      .filter((key) => key in added)
      .map((key) => [key, added[key]]),
  );

/**
 * bitest var == p: the test of a 0/1 variable's count of ones, which
 * bitest.ado passes to bitesti with the variable's name.
 */
function bitest(session, text, ctx) {
  const t = target(text);
  if (t.value === undefined) throw new StataError("invalid syntax", 198);
  const parsed = parseOptions(session, "[if] [in] [, Detail]", t.rest),
    variable = session.data.get(session.varlist(t.name)[0]),
    rows = session.rows(parsed, scope(ctx)),
    // markout drops every observation of a string variable.
    v = isStringType(variable.type) ? [] : values(variable, rows);
  if (!v.length) throw new StataError("no observations", 2000);
  if (v.some((x) => x !== 0 && x !== 1))
    throw new StataError(`${variable.name} is not a 0/1 variable`, 450);
  const p = session.scalar(t.value);
  if (!(p > 0 && p < 1))
    throw new StataError("success probability #p must be in (0,1)", 450);
  binomialTest(ctx, session, {
    n: v.length,
    k: v.reduce((a, b) => a + b, 0),
    p,
    name: variable.name,
    detail: parsed.options.detail,
  });
}

const BITESTI_SYNTAX = "syntax is bitesti #N #succ #p";
/**
 * bitesti #N #succ #p: the same test from the counts, read as bitesti.ado
 * reads them. Each argument is an expression; a number of successes that
 * is not an integer is a proportion of the trials.
 */
function bitesti(session, text, ctx) {
  if (!text.trim())
    throw new StataError(
      paragraph(
        session,
        `you must specify number of trials, number of successes, and success probability; ${BITESTI_SYNTAX}`,
        0,
        0,
      ),
      198,
    );
  // parse "`*'", parse(", "): words, each comma a word of its own.
  const words = [],
    pattern = /,|[^\s,]+/g;
  let m;
  while (words.length < 3 && (m = pattern.exec(text)))
    words.push({ word: m[0], end: pattern.lastIndex });
  const evaluate = (item) => {
    if (item === undefined) return undefined;
    if (item.word === ",") throw new StataError("invalid syntax", 198);
    return session.scalar(item.word);
  };
  let n = evaluate(words[0]),
    k = evaluate(words[1]);
  if (words.length < 3) throw new StataError("invalid syntax", 198);
  const p = evaluate(words[2]),
    rest = text.slice(words[2].end);
  if (rest.trim() && !rest.trim().startsWith(","))
    throw new StataError("varlist not allowed", 101);
  const options = parseOptions(
      session,
      "[, XName(string) Detail]",
      rest.trim(),
    ).options,
    // confirm integer number, on the number as its macro holds it.
    integer = (value) => /^[+-]?\d+$/.test(macroNumber(value));
  const trials = !integer(n) ? 7 : n < 0 ? 198 : n < 1 ? 2001 : 0;
  if (trials)
    throw new StataError(
      `invalid number of trials\n${paragraph(session, `Number of trials #N must be a positive integer greater than 1; ${BITESTI_SYNTAX}`, 4)}`,
      trials,
    );
  if (!integer(k)) k = isMissing(k) ? MISSING : Math.floor(k * n + 0.5);
  if (k < 0 || k > n)
    throw new StataError(
      `invalid number of successes\n${paragraph(session, `Number of successes #succ must be a positive integer no larger than the number of trials #N; ${BITESTI_SYNTAX}`, 4)}`,
      450,
    );
  if (!(p > 0 && p < 1))
    throw new StataError(
      options.xname
        ? "success probability #p must be in (0,1)"
        : `invalid success probability\n${paragraph(session, `Success probability #p must be in (0,1); ${BITESTI_SYNTAX}`, 4)}`,
      450,
    );
  binomialTest(ctx, session, {
    n,
    k,
    p,
    name: options.xname || undefined,
    detail: options.detail,
  });
}

/** P(X >= x) for X binomial with n trials and probability one half. */
function halfTail(n, x) {
  if (x <= 0) return 1;
  if (x > n) return 0;
  let logFactorial = 0;
  const logs = [0];
  for (let j = 1; j <= n; j++) logs[j] = logFactorial += Math.log(j);
  let t = 0;
  for (let j = x; j <= n; j++)
    t += Math.exp(logs[n] - logs[j] - logs[n - j] - n * Math.LN2);
  return Math.min(1, t);
}

/**
 * signtest var = exp: the sign test that the median of var - exp is zero,
 * with Stata's table and its one- and two-sided binomial probabilities.
 */
function signtest(session, text, ctx) {
  // Stata prints the expression as typed up to if or in, the space before
  // them included: signtest a = b if a > 2 shows "a - b  = 0".
  const m =
    /^\s*([^\s=]+)\s*=\s*([\s\S]*?)(?:(\s+)((?:if|in)\s[\s\S]*))?$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  const variable = session.data.get(session.varlist(m[1])[0]),
    expression = m[2].trim(),
    typed = `${m[2]}${m[3] ?? ""}`,
    parsed = session.parse("[if] [in]", m[4] ? ` ${m[4]}` : ""),
    compiled = session.compile(expression);
  // signtest.ado's sign(var - (exp)) of a string.
  if (compiled.type !== "numeric" || isStringType(variable.type))
    throw new StataError("type mismatch", 109);
  let positive = 0,
    negative = 0,
    zero = 0;
  session.select(parsed, scope(ctx), (i, env) => {
    const a = variable.data[i],
      b = compiled.evaluate(i, env);
    if (isMissing(a) || isMissing(b)) return;
    if (a > b) positive++;
    else if (a < b) negative++;
    else zero++;
  });
  const n = positive + negative,
    all = n + zero,
    expected = n / 2,
    shown = (v) => g(v).padStart(12),
    four = (v) => applyFormat(v, "%6.4f"),
    // signtest.ado names the variable in ten characters, and leaves out
    // " - 0" when the expression is exactly 0 as typed.
    difference =
      typed === "0"
        ? abbrev(variable.name, 10)
        : `${abbrev(variable.name, 10)} - ${typed}`,
    upper = halfTail(n, positive),
    lower = halfTail(n, negative),
    most = Math.max(positive, negative),
    two = Math.min(1, 2 * halfTail(n, most));
  ctx.out("");
  ctx.out("Sign test");
  ctx.out("");
  ctx.out("        Sign |    Observed    Expected");
  ctx.out("-------------+------------------------");
  ctx.out(`    Positive |${shown(positive)}${shown(expected)}`);
  ctx.out(`    Negative |${shown(negative)}${shown(expected)}`);
  ctx.out(`        Zero |${shown(zero)}${shown(zero)}`);
  ctx.out("-------------+------------------------");
  ctx.out(`         All |${shown(all)}${shown(all)}`);
  ctx.out("");
  ctx.out("One-sided tests:");
  for (const [sign, count_, p, side] of [
    ["positive", positive, upper, ">"],
    ["negative", negative, lower, "<"],
  ]) {
    ctx.out(`  H0: median of ${difference} = 0 vs.`);
    ctx.out(`  Ha: median of ${difference} ${side} 0`);
    ctx.out(`      Pr(#${sign} >= ${count_}) =`);
    ctx.out(
      `         Binomial(n = ${n}, x >= ${count_}, p = 0.5) = ${four(p)}`,
    );
    ctx.out("");
  }
  ctx.out("Two-sided test:");
  ctx.out(`  H0: median of ${difference} = 0 vs.`);
  ctx.out(`  Ha: median of ${difference} != 0`);
  ctx.out(`      Pr(#positive >= ${most} or #negative >= ${most}) =`);
  ctx.out(
    `         min(1, 2*Binomial(n = ${n}, x >= ${most}, p = 0.5)) = ${four(two)}`,
  );
  ctx.out("");
  session.results.r = {
    N: all,
    N_pos: positive,
    N_neg: negative,
    N_tie: zero,
    p: two,
    p_l: lower,
    p_u: upper,
  };
}

/**
 * robvar: Levene's test of equal variances across groups (W0) and Brown and
 * Forsythe's versions with the median (W50) and the 10 percent trimmed mean
 * (W10): each is the one-way F test of the absolute deviations from the
 * group's centre. The trimmed mean is the mean of the values between the
 * group's 10th and 90th percentiles. As in robvar.ado, Stata's arithmetic
 * makes the statistics missing with fewer than two groups or no
 * observations, and the command still succeeds.
 */
function robvar(session, text, ctx) {
  const parsed = parseOptions(session, "varname [if] [in] , BY(varlist)", text);
  if (parsed.options.by.length > 1)
    throw new StataError("by():  too many variables specified", 103);
  // robvar.ado's egen mean() of a string variable.
  session.rows(parsed, scope(ctx));
  if (isStringType(session.data.get(parsed.varlist[0]).type))
    throw new StataError("type mismatch", 109);
  const f = grouped(session, parsed, scope(ctx)),
    groups = f.groups.map((rows) => values(f.variable, rows)),
    n = groups.reduce((t, v) => t + v.length, 0),
    k = groups.length;
  const condition = [
    parsed.if ? `if ${parsed.if}` : "",
    parsed.in ? `in ${parsed.in[0]}/${parsed.in[1]}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  let last;
  tabulate(
    session,
    `${f.by.name} ${condition}, summarize(${f.variable.name})`,
    {
      ...ctx,
      out: (line) => {
        last = line;
        ctx.out(line);
      },
    },
  );
  // Each statistic follows a blank line, which a table already ends with.
  if (last !== "") ctx.out("");
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length,
    sorted = (v) => [...v].sort((a, b) => a - b),
    centres = {
      w0: mean,
      w50: (v) => percentile(sorted(v), 50),
      w10: (v) => {
        const s = sorted(v),
          low = percentile(s, 10),
          high = percentile(s, 90);
        return mean(s.filter((x) => x >= low && x <= high));
      },
    },
    // robvar.ado's DoCal and the ratio it forms; division by zero and
    // arithmetic on a missing value are missing (NaN here).
    test = (centre) => {
      const deviations = groups.map((v) => {
          const c = centre(v);
          return v.map((x) => Math.abs(x - c));
        }),
        all = n ? mean(deviations.flat()) : NaN,
        between = over(
          deviations.reduce((t, d) => t + d.length * (mean(d) - all) ** 2, 0),
          k - 1,
        ),
        within = over(
          deviations.reduce((t, d) => {
            const m = mean(d);
            return t + d.reduce((u, x) => u + (x - m) ** 2, 0);
          }, 0),
          n - k,
        ),
        F = stata(over(between, within));
      return { F, p: isMissing(F) ? MISSING : Ftail(k - 1, n - k, F) };
    },
    found = Object.fromEntries(
      Object.entries(centres).map(([name, centre]) => [name, test(centre)]),
    ),
    // robvar.ado shows the three statistics in one %w.df format, w and d
    // the widest and longest-decimalled of their displayed forms; with no
    // decimals the format is invalid and display's own form is used.
    shown = Object.values(found).map(({ F }) => displayValue(F)),
    width =
      1 + Math.max(...shown.map((v) => v.length + (v[0] === "." ? 1 : 0))),
    decimals = Math.max(
      ...shown.map((v) => [...v].reverse().join("").indexOf(".")),
    ),
    statistic = (F) =>
      decimals >= 0
        ? applyFormat(F, `%${width}.${decimals}f`)
        : displayValue(F),
    // A probability keeps the digits display gives it, with a leading
    // zero: %0w.df, as robvar.ado builds it.
    probability = (p) => {
      if (p === 0) return displayValue(p);
      const digits = displayValue(p).length - 1;
      return applyFormat(p, `%0${digits + 2}.${digits}f`);
    };
  for (const [name, label] of [
    ["w0", "W0 "],
    ["w50", "W50"],
    ["w10", "W10"],
  ]) {
    const { F, p } = found[name];
    if (name !== "w0") ctx.out("");
    ctx.out(
      `${label} = ${statistic(F)}   df(${displayValue(k - 1)}, ${displayValue(n - k)})     Pr > F = ${probability(p)}`,
    );
  }
  ctx.out("");
  // In the order return list shows them.
  session.results.r = {
    N: n,
    w10: found.w10.F,
    p_w10: found.w10.p,
    w50: found.w50.F,
    p_w50: found.w50.p,
    w0: found.w0.F,
    p_w0: found.w0.p,
    df_1: k - 1,
    df_2: n - k,
  };
}

function oneway(session, text, ctx) {
  const parsed = session.parse(
      "varlist(min=2 max=2) [if] [in] [, Tabulate | Bonferroni SCHeffe SIdak Means STandard Freq Obs noAnova noLabel Wrap Missing]",
      text,
    ),
    f = grouped(session, parsed);
  // Stata says so and returns 0, leaving r() empty, even with tabulate.
  if (!f.rows.length) {
    ctx.out("no observations");
    session.results.r = {};
    return;
  }
  const stats = f.groups.map((rows) => moments(values(f.variable, rows))),
    all = moments(values(f.variable, f.rows)),
    n = all.n,
    k = f.levels.length,
    between = stats.reduce((t, m) => t + m.n * (m.mean - all.mean) ** 2, 0),
    total = all.variance * (n - 1),
    within = total - between,
    dfWithin = n - k,
    F = between / (k - 1) / (within / dfWithin),
    pooled = within / dfWithin,
    usable = stats.filter((m) => m.n > 1),
    correction =
      1 +
      (usable.reduce((t, m) => t + 1 / (m.n - 1), 0) - 1 / dfWithin) /
        (3 * (k - 1)),
    bartlett =
      (dfWithin * Math.log(pooled) -
        usable.reduce((t, m) => t + (m.n - 1) * Math.log(m.variance), 0)) /
      correction,
    wide = (value) => g(value, "%11.0g"),
    rule = "-".repeat(72);
  if (parsed.options.tabulate) {
    const condition = [
      parsed.if ? `if ${parsed.if}` : "",
      parsed.in ? `in ${parsed.in[0]}/${parsed.in[1]}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    tabulate(
      session,
      `${f.by.name} ${condition}, summarize(${f.variable.name})`,
      ctx,
    );
  } else ctx.out("");
  ctx.out("                        Analysis of variance");
  ctx.out(
    "    Source              SS         df      MS            F     Prob > F",
  );
  ctx.out(rule);
  ctx.out(
    `Between groups${wide(between).padStart(16)}${count(k - 1).padStart(7)}${wide(between / (k - 1)).padStart(13)}${applyFormat(F, "%10.2f")}${applyFormat(Ftail(k - 1, dfWithin, F), "%11.4f")}`,
  );
  ctx.out(
    ` Within groups${wide(within).padStart(16)}${count(dfWithin).padStart(7)}${wide(pooled).padStart(13)}`,
  );
  ctx.out(rule);
  ctx.out(
    `    Total     ${wide(total).padStart(16)}${count(n - 1).padStart(7)}${wide(all.variance).padStart(13)}`,
  );
  ctx.out("");
  ctx.out(
    `Bartlett's equal-variances test: chi2(${k - 1}) = ${applyFormat(bartlett, "%8.4f")}    Prob>chi2 = ${applyFormat(chi2tail(k - 1, bartlett), "%5.3f")}`,
  );
  ctx.out("");
  session.results.r = {
    N: n,
    mss: between,
    df_m: k - 1,
    rss: within,
    df_r: dfWithin,
    F,
    chi2bart: bartlett,
    df_bart: k - 1,
  };
}

function kwallis(session, text, ctx) {
  const parsed = session.parse("varname [if] [in] , BY(varlist)", text),
    f = grouped(session, parsed),
    all = ranks(f.rows.map((i) => f.variable.data[i])),
    position = new Map(f.rows.map((i, k) => [i, k])),
    n = f.rows.length,
    sums = f.groups.map((rows) =>
      rows.reduce((t, i) => t + all[position.get(i)], 0),
    ),
    // Stata keeps this running total in a single-precision variable.
    chi2 =
      (12 / (n * (n + 1))) *
        Math.fround(
          sums.reduce((t, s, k) => t + (s * s) / f.groups[k].length, 0),
        ) -
      3 * (n + 1),
    counts = new Map();
  for (const r of all) counts.set(r, (counts.get(r) ?? 0) + 1);
  const ties = [...counts.values()].reduce((t, c) => t + c ** 3 - c, 0),
    adjusted = chi2 / (1 - ties / (n ** 3 - n)),
    df = f.levels.length - 1,
    labels = f.levels.map((level) => labelled(session, f.by, level)),
    first = Math.max(f.by.name.length, ...labels.map((l) => l.length)),
    obs = f.groups.map((rows) => count(rows.length)),
    second = Math.max(3, ...obs.map((o) => o.length)),
    sumsText = sums.map((s) => applyFormat(s, "%8.2f").trim()),
    third = Math.max(8, ...sumsText.map((s) => s.length)),
    inner = first + second + third + 8;
  ctx.out("");
  ctx.out("Kruskal–Wallis equality-of-populations rank test");
  ctx.out("");
  ctx.out(`  +${"-".repeat(inner)}+`);
  ctx.out(
    `  | ${f.by.name.padStart(first)} | ${"Obs".padStart(second)} | ${"Rank sum".padStart(third)} |`,
  );
  ctx.out(
    `  |${"-".repeat(first + 2)}+${"-".repeat(second + 2)}+${"-".repeat(third + 2)}|`,
  );
  labels.forEach((label, k) =>
    ctx.out(
      `  | ${label.padStart(first)} | ${obs[k].padStart(second)} | ${sumsText[k].padStart(third)} |`,
    ),
  );
  ctx.out(`  +${"-".repeat(inner)}+`);
  ctx.out("");
  ctx.out(`  chi2(${df}) = ${applyFormat(chi2, "%6.3f")}`);
  ctx.out(`     Prob = ${four(chi2tail(df, chi2))}`);
  ctx.out("");
  ctx.out(`  chi2(${df}) with ties = ${applyFormat(adjusted, "%6.3f")}`);
  ctx.out(`               Prob = ${four(chi2tail(df, adjusted))}`);
  ctx.out("");
  session.results.r = {
    p_adj: chi2tail(df, adjusted),
    p: chi2tail(df, chi2),
    chi2_adj: adjusted,
    df,
    chi2,
  };
}

/** tabi: a two-way table typed as counts, rows separated by \. */
function tabi(session, text, ctx) {
  const [head, options] = splitAtComma(text),
    table = head
      .split("\\")
      .map((row) => row.trim().split(/\s+/).filter(Boolean).map(Number));
  if (
    table.length < 2 ||
    table.some(
      (row) =>
        row.length !== table[0].length ||
        row.length < 2 ||
        row.some((n) => !Number.isInteger(n) || n < 0),
    )
  )
    throw new StataError("invalid syntax", 198);
  const rows = [];
  table.forEach((row, r) =>
    row.forEach((n, c) => rows.push({ row: r + 1, col: c + 1, pop: n })),
  );
  // The typed counts become a small dataset tabulated by frequency weight.
  const kept = session.data,
    two = table.length === 2 && table[0].length === 2;
  session.data = Dataset.fromRows({
    columns: ["row", "col", "pop"].map((name) => ({ name, type: "numeric" })),
    rows,
  });
  try {
    tabulate(
      session,
      `row col [fweight=pop], ${options ?? (two ? "exact" : "")}`,
      ctx,
    );
  } finally {
    session.data = kept;
  }
}

export const TEST_COMMANDS = [
  // Stata's prtest, bitest, signtest and robvar are byable(recall): under
  // the by prefix each runs once per group, under the group's heading.
  { name: "prtest", minimum: 6, run: perGroup(prtest), byable: true },
  { name: "bitest", minimum: 6, run: perGroup(bitest), byable: true },
  { name: "bitesti", minimum: 7, run: bitesti },
  { name: "signtest", minimum: 8, run: perGroup(signtest), byable: true },
  { name: "robvar", minimum: 6, run: perGroup(robvar), byable: true },
  { name: "prtesti", minimum: 7, run: prtesti },
  { name: "sdtest", minimum: 6, run: sdtest },
  { name: "ranksum", minimum: 7, run: ranksum },
  { name: "signrank", minimum: 8, run: signrank },
  { name: "oneway", minimum: 6, run: oneway },
  { name: "kwallis", minimum: 7, run: kwallis },
  { name: "tabi", minimum: 4, run: tabi },
];
