// Compiles a Stata expression against the dataset in memory.
//
// compileExpression returns { type, evaluate }. type is "numeric" or
// "string" and is known before any observation is read, so a type mismatch
// stops a command before it changes data. evaluate(i, env) gives the value
// for zero-based observation i. env carries the by-group the observation is
// in ({ start, count }), which defines _n, _N and subscripts, and the state
// that running sums and regexm keep between observations.
import { StataError } from "./errors.js";
import { FUNCTIONS, dateLiteral } from "./functions.js";
import { UNAVAILABLE_FUNCTIONS } from "./functions-more.js";
import { resolveVariable } from "./varlist.js";
import {
  DOUBLE_MAX,
  MISSING,
  canonical,
  isMissing,
  missingValue,
} from "./values.js";
import { isStringType } from "./values.js";

// The names c() has in Stata 19.
const SYSTEM_NAMES = new Set(
  (
    "ALPHA MP Mons Months N SE Wdays Weekdays adopath adosize alpha " +
    "autotabgraphs bit born_date byteorder cformat changed charlen clevel " +
    "cmdlen coeftabresults collect_double collect_label collect_style " +
    "collect_warn console copycolor current_date current_time dirsep " +
    "dockable docx_hardbreak docx_maxtable docx_paramode doeditbackup dots " +
    "doublebuffer dp dtable_style dtascomplevel dyndoc_version edition " +
    "edition_real emptycells epsdouble epsfloat eqlen etable_style " +
    "fastscroll filedate filename frame fredkey fvbase fvlabel fvtrack " +
    "fvwrap fvwrapon graphics haverdir hostname httpproxy httpproxyauth " +
    "httpproxyhost httpproxyport httpproxypw httpproxyuser include_bitmap " +
    "iterlog java_heapmax java_home k kmp_blocktime lapack_mkl " +
    "lapack_mkl_cnr lapack_openblas level linegap linesize locale_functions " +
    "locale_icudflt locale_ui locksplitters logmsg logtype lstretch " +
    "machine_type macrolen matacache matafavor matalibs matalnum " +
    "matamofirst mataoptimize matasolvetol matastrict matsize max_N_theory " +
    "max_cmdlen max_graphsize max_it_cvars max_it_fvars max_k_theory " +
    "max_macrolen max_matdim max_memory max_preservemem max_width_theory " +
    "maxbezierpath maxbyte maxdb maxdouble maxfloat maxint maxiter maxlong " +
    "maxstrlvarlen maxstrvarlen maxvar maxvlabellen memory min_graphsize " +
    "min_memory minbyte mindouble minfloat minint minlong mode more " +
    "namelenbyte namelenchar niceness noisily notifyuser obs_t odbcdriver " +
    "odbcmgr os osdtl pagesize pdf_maxtable pformat pi pinnable playsnd " +
    "printcolor processors processors_lic processors_mach processors_max " +
    "pwd python_exec python_userpath rc reshape_favor reventries " +
    "revkeyboard rmsg rmsg_time rng rng_current rngseed_mt64s rngstate " +
    "rngstream scheme scrollbufsize searchdefault seed segmentsize sformat " +
    "showbaselevels showemptycells showomitted smallestdouble smoothfonts " +
    "sort_current sortmethod sortrngstate sortseed stata_name stata_version " +
    "svy_tab_comps sysdir_base sysdir_oldplace sysdir_personal sysdir_plus " +
    "sysdir_site sysdir_stata table_style tabulate_comps tabulate_style " +
    "taskbargroups tmpdir trace tracedepth traceexpand tracehilite " +
    "traceindent tracenumber tracesep type update_interval update_prompt " +
    "update_query username userversion varabbrev varkeyboard version width"
  ).split(" "),
);

const N = "numeric",
  S = "string";
const mismatch = () => new StataError("type mismatch", 109);
const invalid = (message = "invalid syntax") => new StataError(message, 198);
// Any result outside the range of a double is system missing.
const number = (v) => (v <= DOUBLE_MAX && v >= -DOUBLE_MAX ? v : MISSING);

// One term of a factor-variable expression: 1.g, 2b.g, 1o.g, c.x, co.x, o.x,
// each with time-series operators after it or in its own group, as 1.L.x
// or cL.x; Stata's i., ibn. and b#. are not allowed in an expression.
const FACTOR_TERM =
  /^(?:(\d+)(bn|b|o)?|(co|c|o))((?:[LFDS]\d*)*)\.((?:(?:[LFDS]\d*)+\.)*)([\p{L}_][\w\u0080-\u{10FFFF}]*)/u;
const TERM_NAME = /^[\p{L}_][\w\u0080-\u{10FFFF}]*/u;

/**
 * A factor-variable term, or an interaction of them joined by #, at the
 * start of text, as Stata reads one in an expression: 1.g is 1 where g is
 * 1, 0 elsewhere and missing where g is; c.x is x; 1.g#c.x their product.
 * Returns { terms, length } or null when text starts with none.
 */
function factorAt(text) {
  const terms = [];
  let i = 0;
  for (;;) {
    const rest = text.slice(i);
    let m = FACTOR_TERM.exec(rest);
    if (m) {
      const ops = [...`${m[4]}.${m[5]}`.matchAll(/([LFDS])(\d*)/gi)].map(
        ([, letter, k]) => [letter.toUpperCase(), k === "" ? 1 : Number(k)],
      );
      terms.push({
        level: m[1] === undefined ? null : Number(m[1]),
        flag: m[2] ?? (m[3] === "c" ? "" : m[3] ? "o" : ""),
        name: m[6],
        ops,
        operator: true,
      });
    } else if (
      (m = TERM_NAME.exec(rest)) &&
      (terms.length || /^\s*#(?!#)/.test(rest.slice(m[0].length)))
    ) {
      // Another operator Stata does not allow: 1.g#i.x.
      if (/^\.[\p{L}_(]/u.test(rest.slice(m[0].length)))
        throw invalid(`${m[0]}:  operator invalid`);
      terms.push({
        level: null,
        flag: "",
        name: m[0],
        ops: [],
        operator: false,
      });
    } else if (terms.length) {
      // Bare names so far, as x # 2: no interaction, a name Stata cannot
      // read.
      if (!terms.some((term) => term.operator)) return null;
      if (rest.startsWith("("))
        throw new StataError(`unknown function ${text.slice(0, i)}()`, 133);
      throw invalid();
    } else return null;
    i += m[0].length;
    const joint = /^\s*(##?)\s*/.exec(text.slice(i));
    if (!joint) break;
    if (joint[1] === "##")
      throw invalid(
        `invalid matrix stripe;\n${text.slice(0, i)}${
          text
            .slice(i)
            .replace(/\s+/g, "")
            .split(/[^\w.#]/)[0]
        }`,
      );
    i += joint[0].length;
  }
  // A bare name joined to bare names, as g#x, is no interaction.
  if (!terms.some((term) => term.operator)) return null;
  return { terms, length: i };
}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  const push = (type, value, start, raw) =>
    tokens.push({
      type,
      value,
      spaced: start > 0 && /\s/.test(source[start - 1]),
      start,
      ...(raw === undefined ? {} : { raw }),
    });
  while (i < source.length) {
    // Each token ends where the scan resumes after it.
    if (tokens.length && tokens.at(-1).end === undefined) tokens.at(-1).end = i;
    const c = source[i],
      rest = source.slice(i);
    let m;
    if (/\s/.test(c)) i++;
    else if (c === "`" && source[i + 1] === '"') {
      let depth = 1,
        j = i + 2;
      for (; j < source.length && depth; j++) {
        if (source[j] === "`" && source[j + 1] === '"') (depth++, j++);
        else if (source[j] === '"' && source[j + 1] === "'") (depth--, j++);
      }
      if (depth) throw new StataError("too few quotes", 132);
      push("string", source.slice(i + 2, j - 2), i);
      i = j;
    } else if (c === '"') {
      const end = source.indexOf('"', i + 1);
      if (end < 0) throw new StataError("too few quotes", 132);
      push("string", source.slice(i + 1, end), i);
      i = end + 1;
    } else if ((m = /^(t[dmqwhcC])\(([^()]*)\)/.exec(rest))) {
      // td(), tc(), tC(), tw(), tm(), tq() and th(), read with their
      // blanks removed, as Stata's message shows them.
      const value = dateLiteral(m[1], m[2]);
      if (value === undefined)
        throw invalid(`${m[1]}(${m[2].replace(/\s+/g, "")}) invalid`);
      push("number", value, i);
      i += m[0].length;
    } else if (/^\d+(?:bn|b|o)?\.\d+(?:bn|b|o)?\./.test(rest)) {
      // 1.5.g, and so 1.2.3: two levels of one factor.
      throw invalid("multiple conflicting factor levels specified");
    } else if (/^\d+(?:bn|b|o)?\.\(/.test(rest))
      throw new StataError(`unknown function ${/^[^(]*/.exec(rest)[0]}()`, 133);
    else if (
      !/^\d+\.[eEdD][+-]?\d/.test(rest) &&
      !/^[01]\.[0-9a-fA-F]+[xX][+-][0-9a-fA-F]+/.test(rest) &&
      !/[\p{L}\p{Nd}_.]/u.test(source[i - 1] ?? "") &&
      (m = factorAt(rest))
    ) {
      const text = rest.slice(0, m.length).trimEnd();
      // A factor variable takes no subscript: 1.g[2].
      if (rest[m.length] === "[")
        throw invalid(`${text.replace(/\s+/g, "")} invalid name`);
      push("factor", { terms: m.terms, text }, i);
      i += m.length;
    } else if ((m = /^[01]\.[0-9a-fA-F]+[xX][+-][0-9a-fA-F]+/.exec(rest))) {
      // The form %21x writes, such as 1.0X+3.
      const [mantissa, exponent] = m[0].toLowerCase().split("x");
      push(
        "number",
        (Number(mantissa[0]) +
          parseInt(mantissa.slice(2), 16) / 16 ** (mantissa.length - 2)) *
          2 **
            ((exponent[0] === "-" ? -1 : 1) * parseInt(exponent.slice(1), 16)),
        i,
      );
      i += m[0].length;
    } else if ((m = /^(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?/.exec(rest))) {
      // A factor-variable operator Stata does not have: 1n.g.
      const operator = /^(\d+[\p{L}_][\w]*)\.[\p{L}_]/u.exec(rest);
      if (operator) throw invalid(`${operator[1]}:  operator invalid`);
      // A number run into letters is a name Stata cannot read: 1e, 2x.
      if (/^[\p{L}_]/u.test(source.slice(i + m[0].length, i + m[0].length + 2)))
        throw invalid(`${/^[\p{L}\p{Nd}_.]+/u.exec(rest)[0]} invalid name`);
      const value = Number(m[0].replace(/[dD]/, "e"));
      push("number", value > DOUBLE_MAX ? MISSING : value, i, m[0]);
      i += m[0].length;
    } else if ((m = /^\.([a-z])?(?![\p{L}\p{Nd}_.])/u.exec(rest))) {
      push("number", missingValue(m[1] ?? ""), i);
      i += m[0].length;
    } else if (
      (m = /^\[\s*([^\]]+?)\s*\]\s*(_b|_se|_coef)\[\s*([^\]]+?)\s*\]/.exec(
        rest,
      ))
    ) {
      // [eq]_b[x]: a coefficient of one equation of the last model; _coef
      // is Stata's older name for _b.
      push(
        "coefficient",
        {
          kind: m[2] === "_coef" ? "_b" : m[2],
          name: `${m[1]}:${m[3]}`,
          bracketed: true,
        },
        i,
      );
      i += m[0].length;
    } else if ((m = /^(_b|_se|_coef)\[\s*([^\]]+?)\s*\]/.exec(rest))) {
      // _b[x] (or _coef[x]) and _se[x]: a coefficient of the last model
      // and its error.
      push(
        "coefficient",
        { kind: m[1] === "_coef" ? "_b" : m[1], name: m[2] },
        i,
      );
      i += m[0].length;
    } else if (c === "[" && tokens.at(-1)?.type === "number")
      // A number cannot be subscripted: 2[y]x is 2 invalid name.
      throw invalid(`${tokens.at(-1).raw ?? tokens.at(-1).value} invalid name`);
    else if (
      c === "[" &&
      (!tokens.length ||
        (tokens.at(-1).type === "op" && !/^[)\]]$/.test(tokens.at(-1).value)))
    ) {
      // Where a value is expected, [/p] is _b[/p] and [eq]x is _b[eq:x],
      // as Stata reads the shorthand; anything else in brackets is not.
      const free = /^\[\s*\/\s*([^\]\s]+)\s*\]/.exec(rest),
        equation =
          /^\[\s*([^\]/\s][^\]]*?)\s*\]((?:\d+(?:bn|b|o)?\.)?[\p{L}_][\w]*)/u.exec(
            rest,
          );
      // [/var(e.y)] is read as a function of that name, which there is not.
      if (free && free[1].includes("("))
        throw new StataError(
          `unknown function /${free[1].slice(0, free[1].indexOf("("))}()`,
          133,
        );
      if (free) {
        if (/^[\p{L}_]/u.test(rest.slice(free[0].length)))
          throw new StataError(`equation [/${free[1]}] not found`, 303);
        push("coefficient", { kind: "_b", name: `/${free[1]}` }, i);
        i += free[0].length;
      } else if (equation) {
        push(
          "coefficient",
          {
            kind: "_b",
            name: `${equation[1]}:${equation[2]}`,
            shorthand: true,
          },
          i,
        );
        i += equation[0].length;
      } else {
        push("op", "[", i);
        i++;
      }
    } else if (
      (m = /^((?:(?:[LFDS]\d*)+\.+)+)([\p{L}_][\w\u0080-\u{10FFFF}]*)/iu.exec(
        rest,
      ))
    ) {
      // L.x, F2.x, D.x, S12.x and chains such as LD.x, l2d.x or L.F.x: lags,
      // leads, differences and seasonal differences under xtset or tsset,
      // in either case, as Stata reads them; l..x is L.x.
      if (source[i + m[0].length] === "[")
        throw invalid(`${m[0]} invalid name`);
      push(
        "series",
        {
          ops: [...m[1].matchAll(/([LFDS])(\d*)/gi)].map(([, letter, k]) => [
            letter.toUpperCase(),
            k === "" ? 1 : Number(k),
          ]),
          name: m[2],
        },
        i,
      );
      i += m[0].length;
    } else if ((m = /^((?:[LFDS]\d*)+)\.\(/iu.exec(rest)))
      throw new StataError(`unknown function ${m[1]}.()`, 133);
    else if (
      /^[\p{L}_][\w\u0080-\u{10FFFF}]*\s*#(?!#)/u.test(rest) &&
      (m = factorAt(rest))
    ) {
      // x#1.g: a name beside a factor variable in an interaction.
      push("factor", { terms: m.terms, text: rest.slice(0, m.length) }, i);
      i += m.length;
    } else if (rest.startsWith("#") && !tokens.length)
      throw invalid("invalid varname");
    else if ((m = /^[\p{L}_][\w\u0080-\u{10FFFF}]*/u.exec(rest))) {
      // A name joined to a further name by a period is an operator Stata
      // does not know: q.x.
      if (/^\.[\p{L}_]/u.test(source.slice(i + m[0].length)))
        throw invalid(`${m[0]}:  operator invalid`);
      push("name", m[0], i, m[0]);
      i += m[0].length;
    } else if (
      (m = /^(==|!=|~=|>=|<=|[!~<>]\s+=(?!=)|[-+*/^<>&|!~()[\],])/.exec(rest))
    ) {
      // Stata reads the blanks out of > =, < =, ! = and ~ =.
      const op = m[0].replace(/\s+/g, "");
      push("op", op === "~=" ? "!=" : op === "~" ? "!" : op, i);
      i += m[0].length;
    } else if (c === "=") throw invalid("= is not a comparison; use ==");
    // A brace, as the { that ends display 1 {, is plain invalid syntax.
    else if (c === "{" || c === "}") throw invalid();
    // Characters that can be no part of a name: invalid '@'.
    else if (/[@$\\;?%]/.test(c) && tokens.length)
      throw invalid(`invalid '${c}' `);
    else {
      // Stata names the whole word the character is in: 'abc' invalid name.
      // It reads # and : across blanks, as x # 2 is x#2.
      const operator = /[\s\-+*/^<>&|!~()[\],=]/,
        across = c === "#" || c === ":";
      let from = i,
        to = i + 1;
      if (across) while (from > 0 && /\s/.test(source[from - 1])) from--;
      while (from > 0 && !operator.test(source[from - 1])) from--;
      if (across) while (/\s/.test(source[to] ?? "")) to++;
      while (to < source.length && !operator.test(source[to])) to++;
      throw invalid(
        `${source.slice(from, to).replace(/\s+/g, "")} invalid name`,
      );
    }
  }
  if (tokens.length && tokens.at(-1).end === undefined) tokens.at(-1).end = i;
  // Inside parentheses Stata reads on past the blanks between two names or
  // numbers: (1 2) is 12, and inrange(x 1 2) names a variable x12.
  const joined = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.type === "op" && token.value === "(") depth++;
    else if (token.type === "op" && token.value === ")") depth--;
    const last = joined.at(-1);
    // After a string, Stata passes over what follows: ("a" "b") is "a".
    if (
      depth > 0 &&
      token.spaced &&
      last?.type === "string" &&
      ["string", "number", "name"].includes(token.type)
    )
      continue;
    if (
      depth > 0 &&
      token.spaced &&
      token.raw !== undefined &&
      last?.raw !== undefined
    ) {
      const raw = last.raw + token.raw;
      if (/^[\p{L}_]/u.test(raw))
        Object.assign(last, { type: "name", value: raw, raw, end: token.end });
      else if (/^(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?$/.test(raw))
        Object.assign(last, {
          type: "number",
          value: Number(raw.replace(/[dD]/, "e")),
          raw,
          end: token.end,
        });
      else throw invalid(`${raw} invalid number`);
      continue;
    }
    joined.push(token);
  }
  return joined;
}

/**
 * scope: { dataset, scalars (Map of name to number or string),
 * results ({ r: {...}, e: {...} }), state (shared object for regexm) }.
 * All parts are optional; an expression with no dataset can use constants,
 * scalars and functions.
 */
export function compileExpression(source, scope = {}) {
  const tokens = tokenize(source),
    dataset = scope.dataset,
    state = scope.state ?? (scope.state = {});
  let at = 0,
    sums = 0;
  const peek = () => tokens[at],
    isOp = (value) => peek()?.type === "op" && peek().value === value,
    take = (value) => (isOp(value) ? (at++, true) : false);
  const numeric = (node) => {
    if (node.type !== N) throw mismatch();
    return node.evaluate;
  };
  const node = (type, evaluate) => ({ type, evaluate });

  const arithmetic = (left, right, fn) => {
    const a = numeric(left),
      b = numeric(right);
    return node(N, (i, env) => {
      const x = a(i, env),
        y = b(i, env);
      return isMissing(x) || isMissing(y) ? MISSING : number(fn(x, y));
    });
  };
  const power = (x, y) => {
    if (x === 0) return y > 0 ? 0 : y === 0 ? 1 : MISSING;
    const integer = Number.isInteger(y);
    // Stata raises to a whole power up to 64 by multiplying, one factor at
    // a time, x or (for a negative power) 1/x: 10^-2 is 0.1*0.1, which is
    // not 0.01, and 2^-50 is exact. Beyond that it computes exp(y ln x).
    if (integer && Math.abs(y) <= 64) {
      const factor = y < 0 ? 1 / x : x;
      let product = 1;
      for (let k = 0; k < Math.abs(y); k++) product *= factor;
      return product;
    }
    if (x < 0 && !integer) return MISSING;
    const size = Math.exp(y * Math.log(Math.abs(x)));
    return x < 0 && Math.abs(y) % 2 === 1 ? -size : size;
  };

  // How tightly each binary operator binds, loosest first, which decides
  // how Stata names two operators in a row: x ** 2 is x* invalid name, the
  // left side and the first operator, and x + * 2 is *2, the second
  // operator and what follows it, as it splits at the looser one.
  const BINDING = [
    "|",
    "&",
    "==",
    ">=",
    "<=",
    "<",
    ">",
    "!=",
    "+",
    "-",
    "*",
    "/",
    "^",
  ];
  const squeezed = (from, to) => source.slice(from, to).replace(/\s+/g, "");
  // The text an operator with no value before it reads as a name: *2, *"a".
  const operatorWord = (k) => {
    const operator = tokens[k],
      after = tokens[k + 1];
    if (!after || after.type === "op" || after.type === "coefficient")
      return operator.value;
    return squeezed(operator.start, after.end);
  };
  // An operator that cannot begin a value, where one is wanted, after the
  // operator at index k whose left side began at from. ++ is one symbol to
  // Stata, so a + after a + is one of these.
  const misplaced = (from, k) => {
    const first = tokens[k],
      second = peek();
    if (second?.type !== "op") return;
    const value = second.value;
    if (value === ")" || value === "," || value === "]")
      throw invalid(`${squeezed(from, first.end)} invalid name`);
    const binary =
      BINDING.includes(value) &&
      value !== "-" &&
      (value !== "+" || first.value === "+");
    if (!binary) return;
    if (BINDING.indexOf(value) <= BINDING.indexOf(first.value)) {
      // After a parenthesis Stata looks for a function: (x) ** 2.
      if (tokens[k - 1]?.type === "op" && tokens[k - 1].value === ")")
        throw new StataError("unknown function ()", 133);
      throw invalid(`${squeezed(from, first.end)} invalid name`);
    }
    throw invalid(`${operatorWord(at)} invalid name`);
  };
  function binaryLevel(operators, next, build) {
    return function level() {
      const from = peek()?.start ?? source.length;
      let left = next();
      while (peek()?.type === "op" && operators.includes(peek().value)) {
        const op = tokens[at++].value;
        misplaced(from, at - 1);
        left = build(op, left, next());
      }
      return left;
    };
  }
  // Stata evaluates both sides of & and |, so a draw on the right is taken
  // whatever the left side gives.
  const logical = (op, left, right) => {
    const a = numeric(left),
      b = numeric(right);
    return node(N, (i, env) => {
      const x = a(i, env) !== 0,
        y = b(i, env) !== 0;
      return Number(op === "&" ? x && y : x || y);
    });
  };
  const COMPARE = {
    "==": (x, y) => x === y,
    "!=": (x, y) => x !== y,
    "<": (x, y) => x < y,
    ">": (x, y) => x > y,
    "<=": (x, y) => x <= y,
    ">=": (x, y) => x >= y,
  };
  const relational = (op, left, right) => {
    if (left.type !== right.type) throw mismatch();
    const a = left.evaluate,
      b = right.evaluate,
      test = COMPARE[op];
    return node(N, (i, env) => Number(test(a(i, env), b(i, env))));
  };
  // A string times a count, in either order. Both operands are evaluated,
  // left first, whatever the count is, as Stata does.
  const repeat = (left, right, textOnLeft) => (i, env) => {
    const a = left(i, env),
      b = right(i, env),
      [text, n] = textOnLeft ? [a, b] : [b, a];
    return isMissing(n) || n < 1 ? "" : text.repeat(Math.trunc(n));
  };

  const primary = () => {
    const token = tokens[at++];
    if (!token) throw invalid();
    if (token.type === "number") {
      const value = token.value;
      return node(N, () => value);
    }
    if (token.type === "string") {
      const value = token.value;
      return node(S, () => value);
    }
    if (token.type === "coefficient") {
      const { kind, name, shorthand, bracketed } = token.value,
        form = { equation: !!(shorthand || bracketed), shorthand: !!shorthand };
      if (!scope.coefficient)
        throw new StataError(
          form.equation && !name.startsWith("/")
            ? `equation [${name.split(":")[0]}] not found`
            : kind === "_se"
              ? "_se not allowed when e(V) is not present"
              : "_b not allowed when e(b) is not present",
          form.equation && !name.startsWith("/") ? 303 : 111,
        );
      // Looked up when the expression is compiled, so a wrong name stops
      // the command before it runs.
      try {
        scope.coefficient(kind, name, form);
      } catch (error) {
        // [eq]x names the equation, or the coefficient, it cannot find;
        // [eq]_b[x] names the equation.
        if (!form.equation || !(error instanceof StataError)) throw error;
        const [equation, coefficient] = name.split(":");
        if (/^equation/.test(error.message)) {
          // A factor-variable coefficient the model does not have is not
          // found before its equation is looked for: [y]2.g.
          if (shorthand && /^\d/.test(coefficient))
            try {
              scope.coefficient(kind, coefficient, {});
            } catch {
              throw new StataError(`[${coefficient}] not found`, 111);
            }
          throw new StataError(`equation [${equation}] not found`, 303);
        }
        if (!shorthand) throw error;
        throw new StataError(`[${coefficient}] not found`, 111);
      }
      return node(N, () => scope.coefficient(kind, name, form));
    }
    if (token.type === "factor") return factor(token.value);
    if (token.type === "series") {
      if (!scope.series) throw new StataError("time variable not set", 111);
      const { ops, name } = token.value,
        value = scope.series(ops, name);
      // Under by, a lag reaches only into the observation's own group.
      return node(N, (i, env) => value(i, env));
    }
    if (token.type === "op" && token.value === "(") {
      // Inside parentheses a comma is part of a name: (1,2).
      commaInOne(at - 1);
      // A subscript belongs to a name, not to what is in parentheses, and
      // Stata finds that before it reads what is inside: (e(b))[1,1].
      for (let j = at, depth = 0; j < tokens.length; j++) {
        const t = tokens[j];
        if (t.type !== "op") continue;
        if (t.value === "(" || t.value === "[") depth++;
        else if ((t.value === ")" || t.value === "]") && --depth < 0) {
          if (tokens[j + 1]?.type === "op" && tokens[j + 1].value === "[")
            throw new StataError("unknown function ()", 133);
          break;
        }
      }
      const inner = or();
      if (!take(")")) throw new StataError("too few ')' or ']'", 132);
      // A subscript belongs to a name, not to what is in parentheses.
      if (isOp("[")) throw new StataError("unknown function ()", 133);
      return inner;
    }
    if (token.type === "op") {
      // An operator that begins no value: () and -*x are invalid syntax,
      // and *x, or <3 in x == < 3, a name Stata cannot read.
      const before = tokens[at - 2];
      if (
        /^[)\],]$/.test(token.value) ||
        (before?.type === "op" && /^[-!]$/.test(before.value))
      )
        throw invalid();
      throw invalid(`${operatorWord(at - 1)} invalid name`);
    }
    const name = token.value;
    if (isOp("(") && !peek().spaced) return call(name);
    if (name === "_n") return node(N, (i, env) => i - (env?.start ?? 0) + 1);
    if (name === "_N")
      return node(N, (i, env) => env?.count ?? dataset?.n ?? 0);
    if (name === "_pi") return node(N, () => Math.PI);
    if (name === "_rc") return node(N, () => scope.rc?.() ?? 0);
    return variable(name);
  };

  /**
   * The value of a factor-variable term or interaction: the product of its
   * terms, a level term being 1 where its variable has that level and 0
   * elsewhere, and missing where any variable is missing or a string. A
   * term alone that is a base level or omitted (1b.g, o.g, co.x) is 0.
   */
  function factor({ terms }) {
    const names = dataset?.names ?? [],
      seen = new Set();
    const parts = terms.map((term) => {
      let resolved;
      try {
        resolved = resolveVariable(term.name, names);
      } catch (error) {
        if (/ambiguous/.test(error.message)) throw error;
        throw new StataError(`variable ${term.name} not found`, 111);
      }
      if (term.level !== null) {
        if (seen.has(resolved))
          throw invalid(
            "interaction with duplicate factor variables not allowed",
          );
        seen.add(resolved);
      }
      const column = dataset.get(resolved),
        read = term.ops.length
          ? (() => {
              if (!scope.series)
                throw new StataError("time variable not set", 111);
              return scope.series(term.ops, resolved);
            })()
          : (i) => dataset.get(resolved).data[i];
      return { term, text: isStringType(column.type), read };
    });
    const zero =
      terms.length === 1 && (terms[0].flag === "b" || terms[0].flag === "o");
    return node(N, (i, env) => {
      let product = 1;
      for (const { term, text, read } of parts) {
        if (text) return MISSING;
        const v = read(i, env);
        if (isMissing(v)) return MISSING;
        product *= term.level === null ? v : Number(v === term.level);
      }
      return zero ? 0 : number(product);
    });
  }

  /**
   * A matrix's element, name[row, column], from the bracket on. A subscript
   * is a number or the name of the row or column, as b[1,"female"].
   */
  function element(name) {
    at++;
    const row = or().evaluate;
    // One subscript, or three, is not how Stata reads a matrix: b[1] is
    // b not found, and e(b)[1] invalid syntax.
    const wrong = () =>
      name.includes("(") ? invalid() : new StataError(`${name} not found`, 111);
    if (!take(",")) throw wrong();
    const column = or().evaluate;
    if (isOp(",")) throw wrong();
    if (!take("]")) throw new StataError("too few ')' or ']'", 132);
    // Found when the expression is compiled, so a wrong name stops it.
    scope.matrix.rows(name);
    // The column is evaluated before the row, as Stata does.
    return node(N, (i, env) => {
      const c = column(i, env);
      return scope.matrix.element(name, row(i, env), c);
    });
  }

  function variable(name) {
    const names = dataset?.names ?? [];
    if (!names.includes(name) && scope.matrix?.has(name) && isOp("["))
      return element(name);
    let resolved = null;
    try {
      resolved = resolveVariable(name, names);
    } catch (error) {
      if (!scope.scalars?.has(name)) {
        // An ambiguous abbreviation is reported as such, a matrix where a
        // value is wanted is a type mismatch; otherwise not found.
        if (/ambiguous/.test(error.message)) throw error;
        if (scope.matrix?.has(name)) throw mismatch();
        throw new StataError(`${name} not found`, 111);
      }
    }
    if (resolved === null) {
      const value = scope.scalars.get(name);
      if (isOp("[")) throw invalid("a scalar cannot be subscripted");
      // Read when evaluated: twoway function changes x between points.
      return node(typeof value === "string" ? S : N, () =>
        scope.scalars.get(name),
      );
    }
    const column = dataset.get(resolved),
      text = isStringType(column.type),
      empty = text ? "" : MISSING;
    if (!take("[")) {
      // Outside any observation, a variable means its first observation.
      return node(text ? S : N, (i) => dataset.get(resolved).data[i] ?? empty);
    }
    if (at >= tokens.length) throw new StataError("too few ')' or ']'", 132);
    // x[] and x[1,2] are matrix subscripts, of a matrix x Stata looks for.
    if (isOp("]")) throw new StataError(`${name} not found`, 111);
    const index = numeric(or());
    if (isOp(",")) throw new StataError(`${name} not found`, 111);
    if (!take("]")) throw new StataError("too few ')' or ']'", 132);
    return node(text ? S : N, (i, env) => {
      const k = index(i, env),
        count = env?.count ?? dataset.n;
      if (isMissing(k)) return empty;
      const row = Math.trunc(k);
      return row < 1 || row > count
        ? empty
        : dataset.get(resolved).data[(env?.start ?? 0) + row - 1];
    });
  }

  /**
   * Where one value is wanted between the parenthesis at k and its
   * partner, Stata reads a comma as part of a name, from the word before
   * the first comma to the word after the last: abs(1 + 2, 3) is 2,3
   * invalid name.
   */
  function commaInOne(k) {
    let depth = 0,
      first = -1,
      last = -1,
      j = k + 1;
    for (; j < tokens.length; j++) {
      const token = tokens[j];
      if (token.type !== "op") continue;
      if (token.value === "(" || token.value === "[") depth++;
      else if (token.value === ")" || token.value === "]") {
        if (--depth < 0) break;
      } else if (token.value === "," && !depth) {
        if (first < 0) first = j;
        last = j;
      }
    }
    if (first < 0) return;
    const word = (t) => t && t.type !== "op",
      from = word(tokens[first - 1])
        ? tokens[first - 1].start
        : tokens[first].start,
      to = word(tokens[last + 1]) ? tokens[last + 1].end : tokens[last].end;
    throw invalid(`${squeezed(from, to)} invalid name`);
  }

  function call(name) {
    at++; // the opening parenthesis
    if (name === "c") {
      const inner = tokens[at++];
      if (inner?.type !== "name" || !take(")")) throw invalid();
      const value = scope.system?.(inner.value);
      // A name Stata does not have is undefined; one it has that the
      // browser does not keep is refused.
      if (value === undefined && !SYSTEM_NAMES.has(inner.value))
        throw new StataError(`c(${inner.value}) undefined`, 133);
      if (value === undefined)
        throw new StataError(
          `c(${inner.value}) not available`,
          198,
          "This c() value is not kept in the browser.",
        );
      return node(typeof value === "string" ? S : N, () =>
        scope.system(inner.value),
      );
    }
    if (name === "r" || name === "e" || name === "scalar") {
      const inner = tokens[at++];
      if (inner?.type !== "name" || !take(")")) throw invalid();
      if (name === "scalar") {
        if (!scope.scalars?.has(inner.value))
          throw new StataError(`${inner.value} not found`, 111);
        const value = scope.scalars.get(inner.value);
        return node(typeof value === "string" ? S : N, () => value);
      }
      // e(sample) is a function of the observation: 1 in the active
      // estimates' sample, 0 elsewhere and when there are none.
      if (name === "e" && inner.value === "sample")
        return node(N, (i) => scope.esample?.(i) ?? 0);
      // A result matrix subscripted, as e(b)[1,2] or r(table)[4,1].
      if (isOp("[") && scope.matrix) {
        const matrix = `${name}(${inner.value})`;
        // A result that is not a matrix cannot be subscripted.
        if (!scope.matrix.has(matrix)) throw invalid();
        return element(matrix);
      }
      const value = scope.results?.[name]?.[inner.value];
      // A matrix result where a value is wanted: display e(b).
      if (value === undefined && scope.matrix?.has(`${name}(${inner.value})`))
        throw mismatch();
      return node(
        typeof value === "string" ? S : N,
        () => scope.results?.[name]?.[inner.value] ?? MISSING,
      );
    }
    if (
      /^(rowsof|colsof|el|det|trace|issymmetric|matmissing|colnumb|rownumb)$/.test(
        name,
      ) &&
      scope.matrix
    ) {
      const target = { ...tokens[at++] };
      if (target?.type !== "name") throw invalid();
      // A result matrix, e(V) or r(table), is named as it is written.
      if (/^[er]$/.test(target.value) && isOp("(")) {
        at++;
        const inner = tokens[at++];
        if (inner?.type !== "name" || !take(")")) throw invalid();
        target.value = `${target.value}(${inner.value})`;
      }
      if (name === "colnumb" || name === "rownumb") {
        if (!take(",")) throw invalid();
        const label = or();
        if (label.type !== S) throw mismatch();
        if (!take(")")) throw invalid();
        const which = name === "colnumb" ? "column" : "row";
        scope.matrix.rows(target.value);
        return node(N, (i, env) =>
          scope.matrix.number(target.value, which, label.evaluate(i, env)),
        );
      }
      if (name !== "el") {
        if (!take(")")) throw invalid();
        const size = {
          rowsof: scope.matrix.rows,
          colsof: scope.matrix.columns,
          det: scope.matrix.det,
          trace: scope.matrix.trace,
          issymmetric: scope.matrix.symmetric,
          matmissing: scope.matrix.anyMissing,
        }[name];
        size(target.value);
        return node(N, () => size(target.value));
      }
      if (!take(",")) throw invalid();
      const row = numeric(or());
      if (!take(",")) throw invalid();
      const column = numeric(or());
      if (!take(")")) throw invalid();
      // The column is evaluated before the row, as Stata does.
      return node(N, (i, env) => {
        const c = column(i, env);
        return scope.matrix.element(target.value, row(i, env), c);
      });
    }
    const args = [];
    if (at >= tokens.length) throw new StataError("too few ')' or ']'", 132);
    const known = FUNCTIONS[name];
    if (known && (known.max ?? known.args.length) === 1) commaInOne(at - 1);
    if (!take(")")) {
      do {
        // An argument left empty: mod(1,), mod(,1).
        if (isOp(",") || isOp(")")) throw invalid();
        args.push(or());
      } while (take(","));
      if (!take(")")) {
        if (at >= tokens.length)
          throw new StataError("too few ')' or ']'", 132);
        throw invalid();
      }
    }
    if (name === "sum") {
      if (args.length !== 1) throw invalid("sum() takes one argument");
      const value = numeric(args[0]),
        slot = sums++;
      // A running sum that treats missing as zero and restarts with each
      // by-group, which is when env.sums is replaced.
      return node(N, (i, env) => {
        const x = value(i, env),
          total = (env.sums[slot] ?? 0) + (isMissing(x) ? 0 : x);
        env.sums[slot] = total;
        return number(total);
      });
    }
    if (name === "string" || name === "strofreal") {
      if (!scope.format)
        throw new StataError(`unknown function ${name}()`, 133);
      return scope.format(args, { node, numeric, mismatch, invalid });
    }
    const definition = FUNCTIONS[name];
    if (!definition && UNAVAILABLE_FUNCTIONS.has(name))
      throw new StataError(
        `${name}() is a Stata function that is not available in the browser yet`,
        198,
      );
    if (!definition) throw new StataError(`unknown function ${name}()`, 133);
    const variadic = !Array.isArray(definition.args),
      maximum = definition.max ?? (variadic ? 255 : definition.args.length),
      minimum = definition.min ?? (variadic ? 1 : definition.args.length);
    if (args.length < minimum || args.length > maximum) throw invalid();
    if (definition.counts && !definition.counts.includes(args.length))
      throw invalid();
    args.forEach((arg, k) => {
      const wanted = variadic ? definition.args : definition.args[k];
      if (wanted !== "any" && wanted !== arg.type) throw mismatch();
    });
    if (definition.sameType) {
      const positions =
          definition.sameType === "all"
            ? args.map((_, k) => k)
            : definition.sameType,
        types = positions
          .filter((k) => k < args.length)
          .map((k) => args[k].type);
      if (new Set(types).size > 1) throw mismatch();
    }
    const type = definition.returns ?? args[1].type,
      evaluators = args.map((arg) => arg.evaluate),
      strict = !definition.lenient,
      { fn } = definition;
    return node(type, (i, env) => {
      // Stata evaluates a function's arguments last to first, which decides
      // which argument receives which draw when several call runiform(),
      // and whether regexs() reads the match regexm() makes beside it.
      const values = new Array(evaluators.length);
      for (let k = evaluators.length - 1; k >= 0; k--)
        values[k] = evaluators[k](i, env);
      if (strict && values.some((v) => typeof v === "number" && isMissing(v)))
        return type === N ? MISSING : "";
      const result = definition.state ? fn(state, ...values) : fn(...values);
      return typeof result === "number" ? canonical(result) : result;
    });
  }

  // Precedence, tightest first: ^, then the prefix operators ! and -, then
  // /, *, -, +, then the comparisons each at its own level in the order
  // !=, >, <, <=, >=, ==, then & and |. These were settled by running
  // machine-written expressions in Stata: !a^b is !(a^b), a == b < c is
  // a == (b < c), and ! may not be followed directly by a minus sign.
  const negate = (operand) => {
    const value = numeric(operand);
    return node(N, (i, env) => {
      const x = value(i, env);
      return isMissing(x) ? MISSING : -x;
    });
  };
  const invert = (operand) => {
    const value = numeric(operand);
    return node(N, (i, env) => Number(value(i, env) === 0));
  };
  // What may follow ^: a primary, or one carrying its own prefix.
  // A plus sign may stand only before a number: +x is a name Stata cannot
  // read.
  const plus = () => {
    if (peek()?.type !== "number")
      throw invalid(`${operatorWord(at - 1)} invalid name`);
  };
  const powerOperand = () => {
    if (take("-")) return negate(powerOperand());
    if (take("+")) return (plus(), node(N, numeric(powerOperand())));
    if (take("!")) return invert(bang());
    return primary();
  };
  const pow = () => {
    const from = peek()?.start ?? source.length;
    let left = primary();
    while (take("^")) {
      misplaced(from, at - 1);
      left = arithmetic(left, powerOperand(), power);
    }
    return left;
  };
  // What may follow !: another !, or a power; not a sign.
  const bang = () => {
    if (take("!")) return invert(bang());
    if (isOp("-") || isOp("+"))
      throw invalid("! may not be followed by a sign");
    return pow();
  };
  const unary = () => {
    if (take("-")) return negate(unary());
    if (take("+")) return (plus(), node(N, numeric(unary())));
    if (take("!")) return invert(bang());
    return pow();
  };
  const divide = binaryLevel(["/"], unary, (_, l, r) =>
    arithmetic(l, r, (x, y) => (y === 0 ? MISSING : x / y)),
  );
  const multiply = binaryLevel(["*"], divide, (_, l, r) => {
    if (l.type === S && r.type === N)
      return node(S, repeat(l.evaluate, r.evaluate, true));
    if (l.type === N && r.type === S)
      return node(S, repeat(l.evaluate, r.evaluate, false));
    return arithmetic(l, r, (x, y) => x * y);
  });
  const subtract = binaryLevel(["-"], multiply, (_, l, r) =>
    arithmetic(l, r, (x, y) => x - y),
  );
  const add = binaryLevel(["+"], subtract, (_, l, r) => {
    if (l.type === S && r.type === S) {
      const a = l.evaluate,
        b = r.evaluate;
      return node(S, (i, env) => a(i, env) + b(i, env));
    }
    return arithmetic(l, r, (x, y) => x + y);
  });
  // Each comparison is its own level, != binding tightest and == loosest.
  const compare = ["!=", ">", "<", "<=", ">=", "=="].reduce(
    (next, operator) => binaryLevel([operator], next, relational),
    add,
  );
  const and = binaryLevel(["&"], compare, logical);
  const or = binaryLevel(["|"], and, logical);

  if (!tokens.length) throw invalid("expression is empty");
  // A closing parenthesis or bracket with nothing of its kind open is
  // Stata's "too many", whatever else the expression holds: 1], (1+2].
  const open = [];
  for (const token of tokens)
    if (token.type !== "op") continue;
    else if (token.value === "(" || token.value === "[") open.push(token.value);
    else if (
      (token.value === ")" || token.value === "]") &&
      open.pop() !== (token.value === ")" ? "(" : "[")
    )
      throw new StataError("too many ')' or ']'", 132);
  const root = or();
  if (at < tokens.length) {
    const extra = tokens[at];
    if (extra.type === "op" && extra.value === ",")
      throw new StataError("options not allowed", 101);
    if (extra.type === "op" && extra.value === "(" && !extra.spaced)
      throw new StataError("unknown function ()", 133);
    if (extra.type === "op" && extra.value === ")")
      throw new StataError("too many ')' or ']'", 132);
    // A ! after a value joins it and what follows into one name, x!1; at
    // the end it is invalid syntax.
    if (extra.type === "op" && extra.value === "!") {
      const after = tokens[at + 1];
      if (!after) throw invalid();
      throw invalid(
        `${squeezed(tokens[at - 1].start, after.end ?? source.length)} invalid name`,
      );
    }
    // Stata names the word as it was typed, a missing code such as .a
    // included, and drops a string's closing quote: invalid '"a'.
    const typed =
      extra.type === "string"
        ? `"${extra.value}`
        : source
            .slice(extra.start, tokens[at + 1]?.start ?? source.length)
            .trim();
    throw invalid(`invalid '${typed}' `);
  }
  return { type: root.type, evaluate: root.evaluate, usesSum: sums > 0 };
}

/**
 * Evaluates a compiled expression for every observation, in order. groups is
 * a list of { start, count } covering consecutive observations; one group of
 * all observations by default.
 */
export function evaluateAll(compiled, n, groups = [{ start: 0, count: n }]) {
  const out = new Array(n);
  for (const group of groups) {
    const env = { start: group.start, count: group.count, sums: [] };
    for (let i = group.start; i < group.start + group.count; i++)
      out[i] = compiled.evaluate(i, env);
  }
  return out;
}
/** The value of an expression outside any observation, as display uses it. */
export function evaluateScalar(source, scope = {}) {
  const compiled = compileExpression(source, scope);
  return compiled.evaluate(0, {
    start: 0,
    count: scope.dataset?.n ?? 0,
    sums: [],
  });
}
