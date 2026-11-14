// Smaller commands: levelsof, ds, unab and ttest.
import { StataError } from "./errors.js";
import { greatest } from "./extremes.js";
import {
  abbreviateName,
  applyFormat,
  displayWidth,
  truncateColumns,
} from "./format.js";
import { splitAtComma } from "./syntax.js";
import { invttail, ttail } from "./distributions.js";
import { FUNCTIONS } from "./functions.js";
import { count, moments, percentile, perGroup } from "./reports.js";
import {
  formatNumber,
  isMissing,
  isStringType,
  missingName,
  MISSING,
  padDisplay,
} from "./values.js";

const g = (value) => applyFormat(value, "%9.0g").trim();

function levelsof(session, text, ctx) {
  const parsed = session.parse(
      "varname [if] [in] [, Local(name) Missing Separate(string) Clean]",
      text,
    ),
    variable = session.data.get(parsed.varlist[0]),
    string = isStringType(variable.type),
    values = [
      ...new Set(
        session
          .rows(parsed, null)
          .map((i) => variable.data[i])
          .filter(
            (v) =>
              parsed.options.missing || (string ? v !== "" : !isMissing(v)),
          ),
      ),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    levels = values
      .map((v) =>
        string
          ? parsed.options.clean
            ? v
            : '`"' + v + "\"'"
          : formatNumber(v),
      )
      .join(parsed.options.separate ?? " ");
  ctx.out(levels);
  if (parsed.options.local) ctx.frame.locals.set(parsed.options.local, levels);
  session.results.r = { levels, r: values.length };
}

/**
 * abbrev() for a variable name, as Stata 19 abbreviates one: the first
 * characters, ~ and the end of the name from its last run of digits (or
 * its last character when there are none, or when the digits leave no room
 * before the ~), with more of the end kept until the abbreviation matches
 * no other variable in the data. Never shorter than five characters.
 */
export function abbreviateVariable(data, name, width) {
  const n = Math.max(5, Math.min(32, width));
  if (name.length <= n) return name;
  const digits = /\d+\D*$/.exec(name);
  let k = digits && n - 1 - digits[0].length >= 1 ? digits[0].length : 1;
  for (;;) {
    const head = name.slice(0, n - 1 - k),
      tail = name.slice(-k),
      matches = data.names.filter(
        (other) =>
          other.length >= head.length + tail.length &&
          other.startsWith(head) &&
          other.endsWith(tail),
      );
    if (matches.length <= 1 || n - 1 - k <= 1) return `${head}~${tail}`;
    k++;
  }
}

/**
 * ds_util.ado's DisplayInCols: items in as many columns of equal width as
 * the line holds, filled down each column in turn.
 */
export function displayInColumns(session, items, ctx, skip = 2) {
  if (!items.length) return;
  const width = greatest(items.map((item) => item.length)) + skip,
    columns = Math.floor(((session.settings.linesize ?? 80) + 1) / width);
  if (columns < 2) {
    items.forEach((item) => ctx.out(item));
    return;
  }
  const lines = Math.ceil(items.length / columns);
  for (let row = 0; row < lines; row++) {
    let line = "";
    for (let k = row; k < items.length; k += lines)
      line = line.padEnd(Math.floor((k - row) / lines) * width) + items[k];
    ctx.out(line);
  }
}

function ds(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [, HAS(string) NOT(string) Alpha Varwidth(integer 12) Skip(integer 2) | Detail]",
      text,
    ),
    filter = (spec, keep) => (variable) => {
      const m = /^type\s+(\w+)$/.exec(spec.trim());
      if (!m) throw new StataError(`has(${spec}) is not available yet`, 198);
      const match =
        m[1] === "string"
          ? isStringType(variable.type)
          : m[1] === "numeric"
            ? !isStringType(variable.type)
            : variable.type === m[1];
      return match === keep;
    };
  const { varwidth, skip } = parsed.options;
  if (varwidth < 5 || varwidth > 32)
    throw new StataError("varwidth() should be in the range 5..32", 198);
  if (skip < 1 || skip > 10)
    throw new StataError("skip() should be in the range 1..10", 198);
  let variables = parsed.varlist.map((name) => session.data.get(name));
  if (parsed.options.has)
    variables = variables.filter(filter(parsed.options.has, true));
  if (parsed.options.not)
    variables = variables.filter(filter(parsed.options.not, false));
  let names = variables.map((v) => v.name);
  if (parsed.options.alpha) names = [...names].sort();
  displayInColumns(
    session,
    names.map((name) => abbreviateVariable(session.data, name, varwidth)),
    ctx,
    skip,
  );
  session.results.r = { varlist: names.join(" ") };
}

function unab(session, text, ctx) {
  const m = /^\s*(\w+)\s*:\s*([^,]*)(?:,(.*))?$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  const names = session.varlist(m[2]);
  if (!names.length) throw new StataError("varlist required", 100);
  ctx.frame.locals.set(m[1], names.join(" "));
}

// Inside the t tests a missing value is NaN, so that it passes through the
// arithmetic as Stata's missing does; stored() turns it back into Stata's
// missing value (and so does an infinite t when the standard error is 0).
const known = (value) =>
  Number.isFinite(value) && value < MISSING ? value : NaN;
const stored = (value) => (Number.isFinite(value) ? value : MISSING);
// The upper tail of Student's t, missing when t or the degrees of freedom are.
const upper = (df, t) =>
  Number.isFinite(t) && df > 0 ? known(ttail(df, t)) : NaN;

/**
 * One row of a t-test table from n, the mean and the standard deviation.
 * With one observation there is no standard deviation, whatever was given.
 */
function tSummary(n, mean, sd, level) {
  const spread = n > 1 ? known(sd) : NaN,
    se = spread / Math.sqrt(n),
    critical = known(invttail(n - 1, (1 - level / 100) / 2));
  return {
    n,
    mean,
    sd: spread,
    variance: spread * spread,
    se,
    lb: mean - critical * se,
    ub: mean + critical * se,
  };
}
const fromData = (values, level) => {
  const m = moments(values);
  return tSummary(m.n, m.mean, m.sd, level);
};

/**
 * abbrev(name, width) by columns of the screen, as Stata 19 abbreviates a
 * name or label of wide (CJK) characters: as much of its start as fits
 * before ~ and its last character. Other names abbreviate as names do.
 */
export function abbreviateColumns(name, width) {
  const columns = displayWidth(name);
  if (columns === name.length) return abbreviateName(name, width);
  if (columns <= width) return name;
  const last = Array.from(name).at(-1);
  return `${truncateColumns(name, width - 1 - displayWidth(last))}~${last}`;
}
const abbrev = abbreviateColumns;

/**
 * ttest and prtest read their qualifiers as Stata's syntax does, so they
 * may come between the variable and ==, as in ttest income in 1 / 5 == 0
 * or ttest income if female in 1/10 == 0. An in range runs to an if or
 * =, and an if expression to an in, so in ttest income in 1/5 if x == 0
 * the == belongs to the if. Returns the text with the qualifiers moved
 * after the hypothesis, before any options; an == with nothing after it
 * is invalid syntax.
 */
export function qualifierAfterHypothesis(text) {
  const [head, options] = splitAtComma(text),
    m = /^(\s*[^\s=,]+)\s+((?:if|in)\b[\s\S]*)$/.exec(head);
  if (!m) return text;
  let rest = m[2];
  const qualifiers = [];
  for (let q; (q = /^(if|in)\b\s*/.exec(rest)); rest = rest.trimStart()) {
    const after = rest.slice(q[0].length),
      end = after.search(q[1] === "in" ? /\bif\b|=/ : /\sin\b/),
      body = end < 0 ? after : after.slice(0, end);
    qualifiers.push(
      q[1] === "in" ? `in ${body.replace(/\s+/g, "")}` : `if ${body.trim()}`,
    );
    rest = end < 0 ? "" : after.slice(end);
  }
  if (!/^==?/.test(rest)) return text;
  const exp = rest.replace(/^==?/, "").trim();
  if (!exp) throw new StataError("invalid syntax", 198);
  return `${m[1]} == ${exp} ${qualifiers.join(" ")}${options === null ? "" : `,${options}`}`;
}

// Text placed at a column as display's _col() places it. A line already
// past the column goes on where it is.
const at = (line, column, text) =>
  line + " ".repeat(Math.max(0, column - 1 - displayWidth(line))) + text;

/**
 * Three pieces centred as _ttest center2 centres them: on columns 11, 40
 * and 70, the third further right when it is longer than 20 characters,
 * and each at least one blank after the one before. The length that moves
 * the third piece counts the two @ signs ttesti.ado marks a highlighted
 * number with, so marked tells whether the pieces carry them.
 */
function centred(pieces, marked) {
  const long = pieces[2].length + (marked ? 2 : 0),
    centres = [11, 40, long > 20 ? 79 - Math.floor(long / 2) : 70];
  let line = "";
  pieces.forEach((piece, k) => {
    const skip = Math.max(
      line ? 1 : 0,
      centres[k] - Math.floor(piece.length / 2) - 1 - line.length,
    );
    line += " ".repeat(skip) + piece;
  });
  return line;
}

// A number as confirm number accepts it, in decimal or in Stata's
// hexadecimal form, as 1.0x+0 for 1 or 1.4x+3 for 10, whose exponent of two
// is also hexadecimal. ttest echoes the hypothesised value as typed, in
// %8.0g only when it is longer than eight characters.
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i,
  HEXADECIMAL = /^([+-]?)([0-9a-f]+)(?:\.([0-9a-f]*))?x([+-][0-9a-f]+)$/i,
  NUMBER = { test: (text) => DECIMAL.test(text) || HEXADECIMAL.test(text) };
function numberOf(text) {
  const m = HEXADECIMAL.exec(text);
  if (!m) return Number(text);
  const fraction = m[3] ? parseInt(m[3], 16) / 16 ** m[3].length : 0;
  return (
    (m[1] === "-" ? -1 : 1) *
    (parseInt(m[2], 16) + fraction) *
    2 ** parseInt(m[4], 16)
  );
}
const echoed = (typed) =>
  typed.length > 8 ? applyFormat(numberOf(typed), "%8.0g").trim() : typed;

/**
 * Whether text names variables, as confirm variable decides it: each word a
 * variable's name or an abbreviation of one. confirm variable takes no
 * wildcard, range or _all, so a group labelled x* or _all is a Group.
 */
function namesVariables(session, text) {
  return text
    .trim()
    .split(/\s+/)
    .every((word) => {
      if (!/^[A-Za-z_]\w*$/.test(word) || word === "_all") return false;
      try {
        return session.varlist(word).length === 1;
      } catch {
        return false;
      }
    });
}

/**
 * The check ttest's syntax makes of the expression after ==. A [ opens a
 * weight, which ttest does not allow, and an operator with nothing after it
 * ends the expression too soon when nothing follows in the command. Then,
 * from the left: a variable, scalar or function that does not exist, two
 * values with nothing between them, and unbalanced parentheses. An operator
 * at the end with an if, in or options after it leaves the expression to
 * confirm variable. last tells whether the expression ends the command.
 */
function checkExpression(session, text, last) {
  if (text.includes("[")) throw new StataError("weights not allowed", 101);
  const trailing = /[-+*/^&|<>!~=]$/.test(text);
  if (trailing && last) throw new StataError("invalid syntax", 198);
  const token =
    /\s*(?:(==|!=|~=|>=|<=|[-+*/^&|<>!~=\]])|(\()|(\))|("[^"]*"|`"[\s\S]*?"')|(\d[0-9a-f]*(?:\.[0-9a-f]*)?x[+-][0-9a-f]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|\.[a-z]?)|([A-Za-z_]\w*))/iy;
  let depth = 0,
    operand = false,
    m;
  while (token.lastIndex < text.length && (m = token.exec(text))) {
    const [, op, open, close, , , name] = m;
    if (op || open) {
      if (open) depth++;
      operand = false;
      continue;
    }
    if (close) {
      if (!depth) throw new StataError("too many ')' or ']'", 132);
      depth--;
      operand = true;
      continue;
    }
    // Stata's message ends in a blank.
    if (operand) throw new StataError(`invalid '${m[0].trim()}' `, 198);
    operand = true;
    if (!name) continue;
    if (text[token.lastIndex] === "(") {
      if (!(name in FUNCTIONS) && !/^str(ing|ofreal)$/.test(name))
        throw new StataError(`unknown function ${name}()`, 133);
    } else if (!session.scalars.has(name) && !/^_(n|N|pi)$/.test(name))
      try {
        session.varlist(name);
      } catch (error) {
        if (/ambiguous/.test(error.message)) throw error;
        throw new StataError(`${name} not found`, 111);
      }
  }
  if (depth) throw new StataError("too few ')' or ']'", 132);
  if (trailing) throw notVariables(session, text);
}

/**
 * The error confirm variable gives, as ttest.ado runs it, for text that is
 * not one variable's name. Its words end at blanks and at + - ( ) and =, so
 * 2+1 is the invalid name 2 and b* is one word; a word before ( is taken
 * for an operator.
 */
function notVariables(session, text) {
  const number = /^\(?\s*(\d[^\s\-+()=]*)/.exec(text);
  if (number) return new StataError(`${number[1]} invalid name`, 198);
  for (const m of text.matchAll(/==|[-+()=]|[^\s\-+()=]+/g)) {
    const word = m[0];
    if (word === "_all") return new StataError("variable _all not found", 111);
    if (/^[A-Za-z_]\w*$/.test(word)) {
      if (text[m.index + word.length] === "(")
        return new StataError(
          "factor-variable and time-series operators not allowed",
          101,
        );
      try {
        session.varlist(word);
        continue;
      } catch {
        return new StataError(`variable ${word} not found`, 111);
      }
    }
    // A wildcard is an invalid name when it matches a variable.
    if (/^[A-Za-z_][\w*?]*$/.test(word)) {
      let found = false;
      try {
        found = session.varlist(word).length > 0;
      } catch {
        found = false;
      }
      return found
        ? new StataError(`${word} invalid name`, 198)
        : new StataError(`variable ${word} not found`, 111);
    }
    return new StataError(`${word} invalid name`, 198);
  }
  return new StataError("invalid syntax", 198);
}

/** The pieces ttest and ttesti print their tables with. */
function tPrinters(ctx, session) {
  const cell = (value) => applyFormat(stored(value), "%9.0g"),
    // A row: the name in eight columns, then Obs from column 12 and each
    // statistic in nine columns from columns 22, 34, 46, 58 and 70. The
    // difference row of a two-sample test leaves out Obs and Std. dev.
    row = (name, m) =>
      [
        [12, applyFormat(m.n, "%7.0fc")],
        [22, cell(m.mean)],
        [34, cell(m.se)],
        [46, cell(m.sd)],
        [58, cell(m.lb)],
        [70, cell(m.ub)],
      ].reduce(
        (line, [column, text]) => at(line, column, text),
        `${padDisplay(abbrev(name, 8), 8)} |`,
      ),
    rule = "-".repeat(78),
    middle = `---------+${"-".repeat(68)}`,
    // The first column is headed Variable when the first name names
    // variables, Group when it is a group's label, and not at all for
    // ttesti without xname(). A level of five characters leaves no blank
    // in its label.
    head = (xname, level) => {
      const variable = xname !== "" && namesVariables(session, xname),
        first = xname === "" ? "" : variable ? "Variable" : "   Group";
      // _ttest header asks capture confirm variable, which leaves its
      // return code in _rc after ttest.
      if (xname !== "")
        session.rc = variable ? 0 : notVariables(session, xname).code;
      const label = g(level),
        wide = label.length === 5;
      return at(
        `${first.padEnd(9)}|     Obs        Mean    Std. err.   Std. dev.`,
        61 - label.length + (wide ? 1 : 0),
        `[${label}% ${wide ? "conf.interval" : "conf. interval"}]`,
      );
    },
    // marked is true for the one-sample test, whose hypothesised value is
    // highlighted.
    tails = (t, df, what, value, marked = false) => {
      // Each tail is taken directly, never as one minus the other, so that
      // a tiny p-value keeps its digits instead of rounding to 0.
      const p_u = upper(df, t),
        p_l = upper(df, -t),
        p = 2 * upper(df, Math.abs(t)),
        four = (p) => applyFormat(stored(p), "%6.4f");
      ctx.out("");
      ctx.out(
        centred(
          [
            `Ha: ${what} < ${value}`,
            `Ha: ${what} != ${value}`,
            `Ha: ${what} > ${value}`,
          ],
          marked,
        ),
      );
      ctx.out(
        centred(
          [
            `Pr(T < t) = ${four(p_l)}`,
            `Pr(|T| > |t|) = ${four(p)}`,
            `Pr(T > t) = ${four(p_u)}`,
          ],
          true,
        ),
      );
      ctx.out("");
      return { p_u: stored(p_u), p_l: stored(p_l), p: stored(p) };
    },
    // The line naming the difference, with t from column 67, and the null
    // hypothesis with the degrees of freedom from the given column.
    finish = (left, t, hypothesis, column, label, df) => {
      ctx.out(at(left, 67, `t = ${applyFormat(stored(t), "%8.4f")}`));
      ctx.out(at(hypothesis, column, `${label} = ${df}`));
    };
  return { cell, row, rule, middle, head, tails, finish };
}

/**
 * The one-sample test, from data or from ttesti. xname is the variable,
 * or "" for ttesti, whose sample is called x; typed is the hypothesised
 * value as it was typed.
 */
function oneSample(ctx, session, printers, m, xname, typed, level) {
  const { row, rule, middle, head, tails, finish } = printers,
    value = numberOf(typed),
    name = xname || "x",
    t = (m.mean - value) / m.se,
    df = m.n - 1;
  ctx.out("");
  ctx.out("One-sample t test");
  ctx.out(rule);
  ctx.out(head(xname, level));
  ctx.out(middle);
  ctx.out(row(name, m));
  ctx.out(rule);
  finish(
    `    mean = mean(${name})`,
    t,
    `H0: mean = ${echoed(typed)}`,
    50,
    "Degrees of freedom",
    applyFormat(df, "%8.0f"),
  );
  const { p_u, p_l, p } = tails(t, df, "mean", echoed(typed), true);
  // In the order Stata stores them, which is the order return list shows.
  session.results.r = {
    ub_1: stored(m.ub),
    lb_1: stored(m.lb),
    level,
    sd_1: stored(m.sd),
    se: stored(m.se),
    p_u,
    p_l,
    p,
    t: stored(t),
    df_t: df,
    mu_1: m.mean,
    N_1: m.n,
  };
}

// The approximation to the degrees of freedom that unequal or welch asks
// for; welch wins when both are given, as in ttesti.ado.
const approximation = (options) =>
  options.welch ? "Welch's " : options.unequal ? "Satterthwaite's " : "";

/**
 * The variable by() names, refused as syntax refuses a by(varname) option
 * that names more or fewer than one variable or one that does not exist.
 */
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
 * Under by, a group with no observations does not end the run: its message
 * is printed under the group's heading and by goes on to the next group,
 * finishing with rc 0, as Stata's by does for r(2000). The failed group
 * clears r(), so a run whose last group is empty leaves r() empty. Every
 * other error still stops by at its group.
 */
const emptyGroups = (run) => (session, text, ctx) => {
  if (!ctx.group) return run(session, text, ctx);
  try {
    run(session, text, ctx);
  } catch (error) {
    if (!(error instanceof StataError) || error.code !== 2000) throw error;
    ctx.out(error.message);
    ctx.out("");
    session.results.r = {};
  }
};

function ttest(session, text, ctx) {
  text = qualifierAfterHypothesis(text);
  const paired = /^\s*([^\s=,]+)\s*==?\s*([^\s,][\s\S]*)$/.exec(text),
    data = session.data,
    printers = tPrinters(ctx, session),
    { row, rule, middle, head, tails, finish } = printers,
    // Under by, ttest sees one group's observations at a time.
    within = ctx.group ? { groups: [ctx.group] } : null;
  if (paired) {
    // The expression after == runs to the options or to an if or in.
    const [before, optionText] = splitAtComma(paired[2]),
      cut = /\s(?:if|in)\b/.exec(before),
      exp = (cut ? before.slice(0, cut.index) : before).trim(),
      after =
        (cut ? before.slice(cut.index) : "") +
        (optionText === null ? "" : "," + optionText);
    // Stata compares with a quoted string as a type mismatch, before it
    // reads any if, in or option, once the variable on the left exists.
    if (/^[`"]/.test(exp)) {
      session.varlist(paired[1]);
      throw new StataError("type mismatch", 109);
    }
    // syntax reads the variable, then the expression, then the rest.
    const first = data.get(session.varlist(paired[1])[0]);
    checkExpression(session, exp, !after.trim());
    const parsed = session.parse(
        "[if] [in] [, BY(string) UNPaired UNEqual Welch Level(cilevel) REVerse cate]",
        after,
      ),
      options = parsed.options,
      level = options.level,
      number = NUMBER.test(exp),
      second = /^[A-Za-z_]\w*$/.test(exp)
        ? data.get(session.varlist(exp)[0])
        : null;
    // A string variable after == is a type mismatch whatever the options.
    if (second && isStringType(second.type))
      throw new StataError("type mismatch", 109);
    const rows = session.rows(parsed, within);
    if (byVariable(session, options.by))
      throw new StataError("may not combine = and option by()", 198);
    if (options.reverse)
      throw new StataError("may not combine = and option reverse", 198);
    if (options.unpaired) {
      // Two samples, each of its own variable's nonmissing values.
      if (!second) throw notVariables(session, exp);
      const sample = (variable, which) => {
        const values = isStringType(variable.type)
          ? []
          : rows.map((i) => variable.data[i]).filter((v) => !isMissing(v));
        if (!values.length)
          throw new StataError(`${which} sample has no observations`, 2000);
        return fromData(values, level);
      };
      const a = sample(first, "first"),
        b = sample(second, "second");
      twoSampleTable(ctx, session, printers)(
        a,
        b,
        first.name,
        second.name,
        level,
        approximation(options),
      );
      return;
    }
    if (options.unequal)
      throw new StataError(
        "unequal option invalid for one-sample or paired tests",
        198,
      );
    if (options.welch)
      throw new StataError(
        "welch option invalid for one-sample or paired tests",
        198,
      );
    // ttest.ado's capture confirm number leaves 0 or 7 in _rc.
    session.rc = number ? 0 : 7;
    if (number) {
      // A string variable has no numeric observations to test.
      const values = isStringType(first.type)
        ? []
        : rows.map((i) => first.data[i]).filter((v) => !isMissing(v));
      if (!values.length) throw new StataError("no observations", 2000);
      oneSample(
        ctx,
        session,
        printers,
        fromData(values, level),
        first.name,
        exp,
        level,
      );
      return;
    }
    if (!second) throw notVariables(session, exp);
    // Stata refuses a string on either side of ==, even two strings.
    if (isStringType(first.type)) throw new StataError("type mismatch", 109);
    const both = rows.filter(
      (i) => !isMissing(first.data[i]) && !isMissing(second.data[i]),
    );
    if (!both.length) throw new StataError("no observations", 2000);
    const a = fromData(
        both.map((i) => first.data[i]),
        level,
      ),
      b = fromData(
        both.map((i) => second.data[i]),
        level,
      ),
      d = fromData(
        both.map((i) => first.data[i] - second.data[i]),
        level,
      ),
      t = d.mean / d.se,
      df = d.n - 1;
    ctx.out("");
    ctx.out("Paired t test");
    ctx.out(rule);
    ctx.out(head(first.name, level));
    ctx.out(middle);
    ctx.out(row(first.name, a));
    ctx.out(row(second.name, b));
    ctx.out(middle);
    ctx.out(row("diff", d));
    ctx.out(rule);
    finish(
      `     mean(diff) = mean(${abbrev(first.name, 16)} - ${abbrev(second.name, 16)})`,
      t,
      " H0: mean(diff) = 0",
      50,
      "Degrees of freedom",
      applyFormat(df, "%8.0f"),
    );
    const { p_u, p_l, p } = tails(t, df, "mean(diff)", "0");
    session.results.r = {
      ub_diff: stored(d.ub),
      lb_diff: stored(d.lb),
      sd_diff: stored(d.sd),
      mu_diff: d.mean,
      ub_2: stored(b.ub),
      lb_2: stored(b.lb),
      se_2: stored(b.se),
      ub_1: stored(a.ub),
      lb_1: stored(a.lb),
      se_1: stored(a.se),
      level,
      sd_2: stored(b.sd),
      sd_1: stored(a.sd),
      se: stored(d.se),
      p_u,
      p_l,
      p,
      t: stored(t),
      df_t: df,
      mu_2: b.mean,
      N_2: b.n,
      mu_1: a.mean,
      N_1: a.n,
    };
    return;
  }
  const parsed = session.parse(
      "varname [if] [in] [, BY(string) UNPaired UNEqual Welch Level(cilevel) REVerse cate]",
      text,
    ),
    options = parsed.options,
    level = options.level;
  if (!options.by) throw new StataError("by() option required", 100);
  const variable = data.get(parsed.varlist[0]),
    by = data.get(byVariable(session, options.by)),
    selected = session.rows(parsed, within),
    rows = isStringType(variable.type)
      ? []
      : selected.filter(
          (i) =>
            !isMissing(variable.data[i]) &&
            !(isStringType(by.type)
              ? by.data[i] === ""
              : isMissing(by.data[i])),
        ),
    levels = [...new Set(rows.map((i) => by.data[i]))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
  // _ttest by's capture confirm string variable leaves 0 or 7 in _rc.
  session.rc = isStringType(by.type) ? 0 : 7;
  if (!rows.length) throw new StataError("no observations", 2000);
  if (levels.length < 2) throw new StataError("1 group found, 2 required", 420);
  if (levels.length > 2)
    throw new StataError("more than 2 groups found, only 2 allowed", 420);
  // reverse puts the larger value first.
  if (options.reverse) levels.reverse();
  const [a, b] = levels.map((value) =>
      fromData(
        rows.filter((i) => by.data[i] === value).map((i) => variable.data[i]),
        level,
      ),
    ),
    // Each group is named by its first eight characters, without the
    // blanks around them. A number is written out in full, as a macro
    // holds it, whatever the variable's format, so 0.1 stored as a float
    // is .1000000 (shown as 1000000 once abbrev() drops the period) and
    // 1e10 is 10000000. Its value label stands in for it unless empty.
    map = isStringType(by.type)
      ? null
      : session.data.valueLabels.get(by.valueLabel),
    // A string group is cut to eight columns of the screen, a label to
    // eight characters.
    [xname, yname] = levels.map((value) =>
      (typeof value === "string"
        ? truncateColumns(value, 8)
        : Array.from(map?.get(value) || applyFormat(value, "%18.0g").trim())
            .slice(0, 8)
            .join("")
      ).trim(),
    );
  twoSampleTable(ctx, session, printers)(
    a,
    b,
    xname,
    yname,
    level,
    approximation(options),
    options.cate,
  );
}

/**
 * The two-sample table of ttest and ttesti. kind is "" for equal variances,
 * or the name of the approximation to the degrees of freedom. The combined
 * row is pooled from the two groups, as Stata pools it, so it is missing
 * when either group's standard deviation is. xname and yname are "" for
 * ttesti, whose samples are called x and y unless xname() and yname()
 * name them. classification is cate's title.
 */
function twoSampleTable(
  ctx,
  session,
  { cell, row, rule, middle, head, tails, finish },
) {
  return (a, b, xname, yname, level, kind, classification = false) => {
    const n = a.n + b.n,
      names = [xname || "x", yname || "y"],
      mean = (a.n * a.mean + b.n * b.mean) / n,
      all = tSummary(
        n,
        mean,
        Math.sqrt(
          ((a.n - 1) * a.variance +
            (b.n - 1) * b.variance +
            a.n * (a.mean - mean) ** 2 +
            b.n * (b.mean - mean) ** 2) /
            (n - 1),
        ),
        level,
      ),
      equal = !kind,
      va = a.variance / a.n,
      vb = b.variance / b.n,
      df = equal
        ? a.n + b.n - 2
        : kind === "Welch's "
          ? (va + vb) ** 2 / (va ** 2 / (a.n + 1) + vb ** 2 / (b.n + 1)) - 2
          : (va + vb) ** 2 / (va ** 2 / (a.n - 1) + vb ** 2 / (b.n - 1)),
      se = equal
        ? Math.sqrt(
            ((a.n - 1) * a.variance + (b.n - 1) * b.variance) / (a.n + b.n - 2),
          ) * Math.sqrt(1 / a.n + 1 / b.n)
        : Math.sqrt(va + vb),
      difference = a.mean - b.mean,
      t = difference / se,
      critical = Number.isFinite(df)
        ? known(invttail(df, (1 - level / 100) / 2))
        : NaN,
      lb = difference - critical * se,
      ub = difference + critical * se;
    ctx.out("");
    // The undocumented cate option only retitles the table.
    ctx.out(
      `${classification ? "Classification" : "Two-sample"} t test with ${equal ? "equal" : "unequal"} variances`,
    );
    ctx.out(rule);
    ctx.out(head(xname, level));
    ctx.out(middle);
    ctx.out(row(names[0], a));
    ctx.out(row(names[1], b));
    ctx.out(middle);
    ctx.out(row("Combined", all));
    ctx.out(middle);
    ctx.out(
      [
        [22, cell(difference)],
        [34, cell(se)],
        [58, cell(lb)],
        [70, cell(ub)],
      ].reduce(
        (line, [column, text]) => at(line, column, text),
        `${"diff".padStart(8)} |`,
      ),
    );
    ctx.out(rule);
    // The degrees of freedom end at column 78 whatever their label.
    finish(
      `    diff = mean(${abbrev(names[0], 16)}) - mean(${abbrev(names[1], 16)})`,
      t,
      "H0: diff = 0",
      { "": 50, "Satterthwaite's ": 34, "Welch's ": 42 }[kind],
      `${kind}${kind ? "d" : "D"}egrees of freedom`,
      applyFormat(stored(df), "%8.0g"),
    );
    const { p_u, p_l, p } = tails(t, df, "diff", "0");
    session.results.r = {
      ub_diff: stored(ub),
      lb_diff: stored(lb),
      mu_diff: difference,
      ub_combined: stored(all.ub),
      lb_combined: stored(all.lb),
      se_combined: stored(all.se),
      mu_combined: mean,
      N_combined: n,
      ub_2: stored(b.ub),
      lb_2: stored(b.lb),
      se_2: stored(b.se),
      ub_1: stored(a.ub),
      lb_1: stored(a.lb),
      se_1: stored(a.se),
      level,
      sd: stored(all.sd),
      sd_2: stored(b.sd),
      sd_1: stored(a.sd),
      se: stored(se),
      p_u,
      p_l,
      p,
      t: stored(t),
      df_t: stored(df),
      mu_2: b.mean,
      N_2: b.n,
      mu_1: a.mean,
      N_1: a.n,
    };
  };
}

/** A {p 0 0 2} paragraph: words wrapped two columns short of the line. */
function paragraph(session, text) {
  const width = (session.settings.linesize ?? 80) - 2,
    lines = [""];
  for (const word of text.split(" ")) {
    const last = lines.at(-1);
    if (last && last.length + 1 + word.length > width) lines.push(word);
    else lines[lines.length - 1] = last ? `${last} ${word}` : word;
  }
  return lines.join("\n");
}

/**
 * The checks _ttest check makes of ttesti's arguments, as typed: sample is
 * "one" for the one-sample test, whose hypothesised value is h, or "first"
 * or "second". One observation may have a missing standard deviation, and
 * then has none whatever was given.
 */
function checked(session, sample, n, m, s, h) {
  const one = sample === "one",
    of = one ? "" : ` of ${sample} sample`;
  if ((one && h === "") || (sample === "second" && s === ""))
    throw new StataError(
      paragraph(
        session,
        "either four arguments for a one-sample test or six arguments for a two-sample test must be specified",
      ),
      198,
    );
  if (n === ".")
    throw new StataError(`number of observations${of} is missing`, 416);
  if (!/^[+-]?\d+$/.test(n))
    throw new StataError(`'${n}' found where integer expected`, 7);
  const count = Number(n),
    number = (text) => {
      if (!NUMBER.test(text))
        throw new StataError(`'${text}' found where number expected`, 7);
      return numberOf(text);
    };
  if (count < 0)
    throw new StataError(`number of observations${of} is negative`, 411);
  if (count === 0)
    throw new StataError(
      one ? "no observations" : `${sample} sample has no observations`,
      2000,
    );
  if (m === ".")
    throw new StataError(one ? "mean is missing" : `mean${of} is missing`, 416);
  const mean = number(m);
  let sd = NaN;
  if (s === ".") {
    if (count !== 1)
      throw new StataError(`standard deviation${of} is missing`, 416);
  } else {
    sd = number(s);
    if (sd < 0)
      throw new StataError(
        one
          ? "standard deviation is negative"
          : `${sample} sample has a negative standard deviation`,
        411,
      );
    // One observation has no spread; Stata refuses a positive sd for it.
    if (count === 1 && sd !== 0)
      throw new StataError(
        `${one ? "only" : `${sample} sample has only`} one observation, but positive standard deviation`,
        499,
      );
  }
  if (one) {
    if (h === ".") throw new StataError("hypothesized value is missing", 416);
    number(h);
  }
  return { n: count, mean, sd };
}

/**
 * ttesti n mean sd value, and ttesti n1 mean1 sd1 n2 mean2 sd2: ttest from
 * summary statistics, the samples called x and y as Stata calls them unless
 * xname() and yname() name them. The arguments are read as ttesti.ado reads
 * them, a word at a time with a comma a word of its own, and four words
 * followed by nothing or a comma make the one-sample test, whose options
 * leave out unequal, welch and cate. reverse is accepted and changes
 * nothing.
 */
function ttesti(session, text, ctx) {
  let rest = text;
  const word = (take) => {
      const m = /^\s*(,|[^\s,]+)?/.exec(rest);
      if (take) rest = rest.slice(m[0].length);
      return m[1] ?? "";
    },
    args = [word(true), word(true), word(true), word(true)],
    next = word(false),
    one = next === "" || next === ",";
  if (!one) args.push(word(true), word(true));
  const options = session.parse(
      one
        ? "[, Xname(string) Yname(string) Level(cilevel) reverse]"
        : "[, Xname(string) Yname(string) UNEqual Welch Level(cilevel) cate REVerse]",
      rest,
    ).options,
    level = options.level,
    printers = tPrinters(ctx, session),
    summary = ({ n, mean, sd }) => tSummary(n, mean, sd, level);
  if (one) {
    const m = summary(checked(session, "one", ...args));
    oneSample(ctx, session, printers, m, options.xname ?? "", args[3], level);
    return;
  }
  const a = summary(checked(session, "first", ...args.slice(0, 3))),
    b = summary(checked(session, "second", ...args.slice(3)));
  twoSampleTable(ctx, session, printers)(
    a,
    b,
    options.xname ?? "",
    options.yname ?? "",
    level,
    approximation(options),
    options.cate,
  );
}

// codebook.ado's Units: the largest power of ten to which rounding leaves
// every value unchanged at float precision, so that a datetime in
// milliseconds has units of 100,000. A constant variable has units of 1.
function units(values) {
  const n = values.length,
    mean = values.reduce((t, v) => t + v, 0) / n;
  if (values.every((v) => v === mean)) return 1;
  const round = (x, p) => Math.floor(x / p + 0.5) * p,
    holds = (p) =>
      values.every((v) => Math.fround(v) === Math.fround(round(v, p)));
  let p = 1;
  if (holds(1)) {
    for (let k = 0; k < 400 && holds(p * 10); k++) p *= 10;
    return p;
  }
  for (let k = 0; k < 400 && !holds(p); k++) p /= 10;
  return p;
}
// Six significant digits, turning to scientific notation from a million up,
// which is how codebook prints means and percentiles.
const ten = (value) => applyFormat(value, "%10.0g").trim();
function six(value) {
  return applyFormat(value, "%8.0g").trim();
}
/**
 * The pieces Stata's `: piece # len of` gives: at most len characters each,
 * broken after the last blank when a word would run past the end, and cut
 * where it must when one word is longer than len. Blanks at a break go.
 */
function pieces(text, len) {
  const out = [];
  let rest = text.replace(/^ +/, "");
  while (rest) {
    if (rest.length <= len) {
      out.push(rest.trimEnd());
      break;
    }
    const cut = rest.slice(0, len),
      blank = cut.lastIndexOf(" ");
    if (rest[len] !== " " && blank > 0) {
      out.push(cut.slice(0, blank).trimEnd());
      rest = rest.slice(blank + 1);
    } else {
      out.push(cut.trimEnd());
      rest = rest.slice(len);
    }
    rest = rest.replace(/^ +/, "");
  }
  return out;
}

// codebook.ado's DoDate: a variable whose format starts %d or %t followed
// by d, w, m, q, h or y is described in that unit; %tc and %tC are not.
const DATE_UNITS = {
  d: ["daily", "days"],
  w: ["weekly", "weeks"],
  m: ["monthly", "months"],
  q: ["quarterly", "quarters"],
  h: ["halfyearly", "half years"],
  y: ["yearly", "years"],
};
function dateUnit(format) {
  const first = format?.[1],
    unit = first === "d" ? "d" : first === "t" ? format[2] : null;
  return unit && DATE_UNITS[unit] ? unit : null;
}
/**
 * What DoDate adds to a mean that is not a whole period: the hours, days or
 * months past the date shown, as "(+ 15 hours)". Its yearly case counts
 * six months to the year, as codebook.ado does.
 */
function pastDate(mean, unit) {
  let diff = mean - Math.trunc(mean),
    note;
  if (diff === 0) return "";
  const tenths = (x) => Number(applyFormat(x, "%9.1f").trim());
  if (unit === "d") {
    diff = Math.floor(24 * diff + 0.5);
    note = "hour";
  } else if (unit === "w") {
    diff = tenths(7 * diff);
    note = "day";
  } else if (unit === "m") {
    diff = Math.floor((365.25 / 12) * diff + 0.5);
    note = "day";
  } else {
    diff = tenths((unit === "q" ? 3 : 6) * diff);
    note = "month";
  }
  const shown = Number.isInteger(diff)
    ? String(diff)
    : applyFormat(diff, "%9.1f").trim();
  return `(+ ${shown} ${note}${shown === "1" ? "" : "s"})`;
}

function codebook(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [, Compact Tabulate(integer 9) | Header Notes Mv Problems Detail]",
      text,
    ),
    data = session.data,
    rows = session.rows(parsed, null),
    linesize = session.settings.linesize ?? 80,
    rule = "-".repeat(linesize),
    field = (label) => `${label.padStart(22)}: `;
  if (parsed.options.compact) {
    if (!rows.length) throw new StataError("no observations", 2000);
    const table = parsed.varlist.map((name) => {
        const v = data.get(name),
          string = isStringType(v.type),
          values = rows
            .map((i) => v.data[i])
            .filter((x) => (string ? x !== "" : !isMissing(x))),
          m = string ? null : moments(values);
        return {
          // abbrev(name, 12)
          name: name.length > 12 ? `${name.slice(0, 10)}~${name.at(-1)}` : name,
          obs: g(values.length),
          unique: g(new Set(values).size),
          mean: m && m.n ? g(m.mean) : ".",
          min: m && m.n ? g(m.min) : ".",
          max: m && m.n ? g(m.max) : ".",
          label: v.label.trim(),
        };
      }),
      // codebook.ado's SummCompact: each column is as wide as its longest
      // entry plus a margin, with a floor, and counts carry no separators.
      longest = (key) => greatest(table.map((r) => r[key].length)),
      margin = (key, floor, extra) =>
        longest(key) <= floor - extra ? floor : longest(key) + extra,
      w = {
        name: Math.max(9, longest("name")),
        obs: margin("obs", 5, 2),
        unique: margin("unique", 7, 1),
        mean: margin("mean", 6, 2),
        min: margin("min", 5, 2),
        max: margin("max", 5, 2),
      },
      total = w.name + w.obs + w.unique + w.mean + w.min + w.max + 2,
      // A label that would run past the line is cut, ending in "...".
      shorten = (label) =>
        total + label.length > linesize
          ? label.slice(0, linesize - total - 3) + "..."
          : label,
      line = (r, header) =>
        `${r.name.padEnd(w.name)}${r.obs.padStart(w.obs)}${r.unique.padStart(w.unique)}${r.mean.padStart(w.mean)}${r.min.padStart(w.min)}${r.max.padStart(w.max)}  ${header ? r.label : shorten(r.label)}`.trimEnd();
    ctx.out("");
    ctx.out(
      line(
        {
          name: "Variable",
          obs: "Obs",
          unique: "Unique",
          mean: "Mean",
          min: "Min",
          max: "Max",
          label: "Label",
        },
        true,
      ),
    );
    ctx.out(rule);
    table.forEach((r) => ctx.out(line(r)));
    ctx.out(rule);
    return;
  }
  for (const name of parsed.varlist) {
    const v = data.get(name),
      string = isStringType(v.type),
      all = rows.map((i) => v.data[i]),
      label = v.label || "(unlabeled)";
    ctx.out("");
    ctx.out(rule);
    ctx.out(`${v.name}${label.padStart(linesize - v.name.length)}`);
    ctx.out(rule);
    ctx.out("");
    if (string) {
      const present = all.filter((x) => x !== ""),
        // greatest() loops; spreading one length per observation into
        // Math.max overflowed the call stack at about 130,000 observations.
        longest = Math.max(
          1,
          greatest(present.map((x) => new TextEncoder().encode(x).length)),
        ),
        declared = Number(v.type.slice(3)),
        unique = [...new Set(present)].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
      ctx.out(
        `${field("Type")}String (${v.type})${declared > longest ? `, but longest is str${longest}` : ""}`,
      );
      ctx.out("");
      ctx.out(
        `${field("Unique values")}${count(unique.length).padEnd(26)}Missing "": ${count(all.length - present.length)}/${count(all.length)}`,
      );
      ctx.out("");
      if (unique.length <= parsed.options.tabulate) {
        ctx.out(`${field("Tabulation")}Freq.  Value`);
        const levels = all.length - present.length ? ["", ...unique] : unique;
        // Each value is shown as codebook.ado's Piece shows it: in quotes,
        // without its leading blanks, in pieces of 39 from column 32.
        for (const level of levels)
          pieces(`"${level.replace(/^ +/, "")}"`, 39).forEach((piece, j) =>
            ctx.out(
              `${j ? " ".repeat(29) : count(all.filter((x) => x === level).length).padStart(29)}  ${piece}`,
            ),
          );
      } else {
        // codebook.ado sorts the sample, empty strings included, and shows
        // the values at positions .2, .4, .6 and .8 of the way through,
        // truncated, repeats and all. Each is cut into pieces of 52, in
        // quotes and without its leading blanks.
        const sorted = [...all].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
          f = data.n - all.length;
        [0.2, 0.4, 0.6, 0.8].forEach((inc, k) => {
          const position = Math.trunc(f + inc * all.length) - f;
          pieces(
            `"${(sorted[position - 1] ?? "").replace(/^ +/, "")}"`,
            52,
          ).forEach((piece, j) =>
            ctx.out(
              `${j || k ? " ".repeat(24) : field("Examples")}${piece}`.trimEnd(),
            ),
          );
        });
      }
      // codebook.ado's checks: a value that starts with a blank, one that
      // ends with one, and a blank inside a value once those are trimmed.
      const blanks = [
        all.some((x) => x.startsWith(" ")) && "leading",
        all.some((x) => x.replace(/^ +| +$/g, "").includes(" ")) && "embedded",
        all.some((x) => x.endsWith(" ")) && "trailing",
      ].filter(Boolean);
      if (blanks.length) {
        ctx.out("");
        ctx.out(
          `${field("Warning")}Variable has ${blanks.length === 3 ? "leading, embedded, and trailing" : blanks.join(" and ")} blanks.`,
        );
      }
      continue;
    }
    const present = all.filter((x) => !isMissing(x)),
      system = all.filter((x) => isMissing(x) && missingName(x) === ".").length,
      extended = all.filter((x) => isMissing(x) && missingName(x) !== "."),
      unique = [...new Set(present)].sort((a, b) => a - b),
      map = data.valueLabels.get(v.valueLabel),
      unit = dateUnit(v.format),
      dateFormat = unit && `%t${unit}`,
      asDate = (x) => applyFormat(x, dateFormat).trim();
    ctx.out(
      `${field("Type")}Numeric ${unit ? `${DATE_UNITS[unit][0]} date ` : ""}(${v.type})`,
    );
    // The label line notes a missing label, or how many distinct
    // nonmissing values have no text in it.
    if (v.valueLabel) {
      const bare = map ? unique.filter((x) => !map.has(x)).length : 0;
      ctx.out(
        `${field("Label")}${v.valueLabel}${
          !map
            ? ", but label does not exist"
            : bare
              ? `, but ${count(bare)} nonmissing value${bare === 1 ? " is" : "s are"} not labeled`
              : ""
        }`,
      );
    }
    ctx.out("");
    ctx.out(
      present.length
        ? `${field("Range")}${`[${ten(unique[0])},${ten(unique.at(-1))}]`.padEnd(30)}Units: ${ten(units(present))}`
        : `${field("Range")}${"[.,.]".padEnd(30)}Units: .`,
    );
    if (unit)
      ctx.out(
        `${field("Or equivalently")}${`[${present.length ? asDate(unique[0]) : "."},${present.length ? asDate(unique.at(-1)) : "."}]`.padEnd(30)}Units: ${DATE_UNITS[unit][1]}`,
      );
    ctx.out(
      `${field("Unique values")}${count(unique.length).padEnd(26)}Missing .: ${count(system)}/${count(all.length)}`,
    );
    // codebook.ado prints these counts with %10.0fc.
    if (extended.length)
      ctx.out(
        `${field("Unique mv codes")}${count(new Set(extended).size + (system ? 1 : 0)).padEnd(25)}Missing .*: ${count(extended.length)}/${count(all.length)}`,
      );
    ctx.out("");
    if (unique.length <= parsed.options.tabulate) {
      const levels = [
          ...unique,
          ...[...new Set(all.filter(isMissing))].sort((a, b) => a - b),
        ],
        show = (x) => (isMissing(x) ? missingName(x) : ten(x));
      if (unit) {
        // FullTab's date form: the value, then the date from column 39.
        ctx.out(`${field("Tabulation")}Freq.  Value`);
        for (const level of levels)
          ctx.out(
            `${count(all.filter((x) => x === level).length).padStart(29)}  ${show(level)}`.padEnd(
              38,
            ) + applyFormat(level, dateFormat),
          );
        continue;
      }
      ctx.out(
        `${field("Tabulation")}Freq.  ${map ? " Numeric  Label" : "Value"}`,
      );
      for (const level of levels) {
        const n = count(all.filter((x) => x === level).length).padStart(29);
        ctx.out(
          map
            ? `${n}${show(level).padStart(10)}  ${map.get(level) ?? ""}`.trimEnd()
            : `${n}  ${show(level)}`,
        );
      }
      continue;
    }
    const m = moments(present),
      sorted = unique.length ? [...present].sort((a, b) => a - b) : [],
      mean = six(m.mean),
      sd = six(m.sd),
      // The first percentile shares the column of the mean and deviation.
      width = Math.max(
        mean.length,
        sd.length,
        six(percentile(sorted, 10)).length,
      ),
      quantiles = [10, 25, 50, 75, 90],
      cell = (text, k) => text.padStart(k ? 10 : width);
    if (unit && !map) {
      // DoDate: the mean as a date, and a second row of percentiles.
      const most = Math.max(mean.length, sd.length),
        p10 = six(percentile(sorted, 10)),
        p10date = asDate(percentile(sorted, 10)),
        first = Math.max(p10.length, displayWidth(p10date)),
        place = (text, k) => text.padStart(k ? 11 : first);
      ctx.out(
        `${field("Mean")}${mean.padStart(most)} = ${asDate(m.mean)}${pastDate(m.mean, unit)}`,
      );
      ctx.out(`${field("Std. dev.")}${sd.padStart(most)}`);
      ctx.out(
        `${field("Percentiles")}${quantiles.map((q, k) => place(q + "%", k)).join("")}`,
      );
      ctx.out(
        `${" ".repeat(24)}${quantiles.map((q, k) => place(k ? applyFormat(percentile(sorted, q), "%8.0g") : p10, k)).join("")}`,
      );
      ctx.out(
        `${" ".repeat(24)}${quantiles.map((q, k) => place(asDate(percentile(sorted, q)), k)).join("")}`,
      );
      continue;
    }
    ctx.out(`${field("Mean")}${mean.padStart(width)}`);
    ctx.out(`${field("Std. dev.")}${sd.padStart(width)}`);
    ctx.out("");
    ctx.out(
      `${field("Percentiles")}${quantiles.map((q, k) => cell(q + "%", k)).join("")}`,
    );
    ctx.out(
      `${" ".repeat(24)}${quantiles.map((q, k) => cell(six(percentile(sorted, q)), k)).join("")}`,
    );
  }
}

export const UTILITY_COMMANDS = [
  { name: "codebook", minimum: 4, run: codebook },
  { name: "levelsof", minimum: 6, run: levelsof },
  { name: "ds", minimum: 2, run: ds },
  { name: "unab", minimum: 4, run: unab },
  {
    name: "ttest",
    minimum: 5,
    run: perGroup(emptyGroups(ttest)),
    byable: true,
  },
  { name: "ttesti", minimum: 6, run: ttesti },
];
