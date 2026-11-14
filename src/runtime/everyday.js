// Commands students reach for early: mean, ci means, pwcorr, spearman and
// clonevar, and the ones that have no meaning in a browser (help, browse,
// ssc install) but should say so plainly rather than stop a do-file.
import { StataError } from "./errors.js";
import { applyFormat, parseFormat } from "./format.js";
import { invttail, ttail } from "./distributions.js";
import { abbreviate } from "./estimation.js";
import { count, labelled, moments, perGroup } from "./reports.js";
import { mean } from "./tables.js";
import {
  MISSING,
  byteLength,
  displayWidth,
  isMissing,
  isName,
  isStringType,
  missingName,
  parseNumber,
} from "./values.js";
import { Generator } from "./random.js";
import { splitAtComma } from "./syntax.js";
import { fileName, fold, load } from "./data-commands.js";
import { smclParagraph } from "./data-utilities.js";
import { characteristicsOf, defineCharacteristic } from "./store.js";

const g = (value) => applyFormat(value, "%9.0g").trim();

function numeric(session, names) {
  return names.map((name) => {
    const variable = session.data.get(name);
    if (isStringType(variable.type))
      throw new StataError(
        `string variables not allowed in varlist;\n${name} is a string variable`,
        109,
      );
    return variable;
  });
}

// mean is in tables.js with proportion, whose weights it shares.

function ci(session, text, ctx) {
  const m = /^\s*(\w+)\s*([\s\S]*)$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  if (!"means".startsWith(m[1]) || m[1].length < 4) {
    if (/^(prop|var)/.test(m[1]))
      throw new StataError(`ci ${m[1]} is not available yet; ci means is`, 198);
    // The older form, ci varlist, ended with Stata 14.
    throw new StataError(
      "you must specify one of means, proportions, or variances following ci",
      198,
    );
  }
  const parsed = session.parse(
      "[varlist] [if] [in] [, Level(cilevel) SEParator(integer 5) | Poisson Exposure(varname) Total]",
      m[2],
    ),
    level = parsed.options.level,
    rows = session.rows(parsed, ctx.group ? { groups: [ctx.group] } : null),
    // The level's digits move the bracket: three spaces more for 95, one
    // for 99.5, as ci lays it out.
    digits = String(level).length,
    rule =
      "-------------+---------------------------------------------------------------";
  ctx.out("");
  ctx.out(
    `    Variable |        Obs        Mean    Std. err.    ${digits === 2 ? "   " : digits === 4 ? " " : ""}[${g(level)}% conf. interval]`,
  );
  ctx.out(rule);
  let last = null,
    shown = 0;
  for (const name of parsed.varlist) {
    const variable = session.data.get(name);
    if (isStringType(variable.type)) continue;
    const stats = moments(
      rows.map((i) => variable.data[i]).filter((v) => !isMissing(v)),
    );
    if (
      shown &&
      parsed.options.separator &&
      shown % parsed.options.separator === 0
    )
      ctx.out(rule);
    shown++;
    // The numbers take the variable's display format when it is fixed,
    // %9.2f for %12.2f and %9.2fc for %12.2fc, and %9.0g otherwise. ci
    // reads the format's last characters, so %12.10f gives %9.0f.
    const own = variable.format ?? "",
      shape = own.endsWith("fc")
        ? `%9.${own.slice(-3)}`
        : own.endsWith("f")
          ? `%9.${own.slice(-2)}`
          : "%9.0g",
      // Each number starts at its column, as display's _col() places it,
      // after anything wider that ran past it.
      columns = (cells) => {
        let line = `${abbreviate(name, 12).padStart(12)} |`;
        for (const [column, text] of cells)
          line = line.padEnd(column - 1) + text;
        return line;
      },
      number = (value) => applyFormat(value, shape);
    // With no observations Stata shows dots and still posts the row.
    if (!stats.n) {
      ctx.out(
        `${abbreviate(name, 12).padStart(12)} |${"0".padStart(11)}${".".padStart(12)}${".".padStart(12)}${".".padStart(16)}${".".padStart(12)}`,
      );
      last = {
        N: 0,
        mean: MISSING,
        se: MISSING,
        lb: MISSING,
        ub: MISSING,
        level,
        citype: "normal",
      };
      continue;
    }
    // One observation has no standard error: Stata shows it and the
    // bounds as dots.
    const one = stats.n < 2,
      se = one ? MISSING : stats.sd / Math.sqrt(stats.n),
      critical = one ? MISSING : invttail(stats.n - 1, (1 - level / 100) / 2),
      lb = one ? MISSING : stats.mean - critical * se,
      ub = one ? MISSING : stats.mean + critical * se;
    ctx.out(
      columns([
        [16, applyFormat(stats.n, "%10.0fc")],
        [29, number(stats.mean)],
        [41, number(se)],
        [57, number(lb)],
        [69, number(ub)],
      ]),
    );
    last = {
      N: stats.n,
      mean: stats.mean,
      se,
      lb,
      ub,
      level,
      citype: "normal",
    };
  }
  ctx.out("");
  if (last) session.results.r = last;
}

function pearson(x, y) {
  const n = x.length,
    mx = x.reduce((a, b) => a + b, 0) / n,
    my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : MISSING;
}
const significance = (rho, n) =>
  isMissing(rho) || n < 3
    ? MISSING
    : Math.abs(rho) >= 1
      ? 0
      : 2 * ttail(n - 2, Math.abs(rho) * Math.sqrt((n - 2) / (1 - rho * rho)));

function pwcorr(session, text, ctx) {
  const parsed = session.parse(
      "[varlist] [if] [in] [, Obs SIG STar(real 0) Print(real 0) | Listwise CASEwise Bonferroni SIDak]",
      text,
    ),
    options = parsed.options,
    variables = numeric(session, parsed.varlist),
    rows = session.rows(parsed, null),
    pair = (a, b) => {
      const use = rows.filter(
          (i) => !isMissing(a.data[i]) && !isMissing(b.data[i]),
        ),
        rho = pearson(
          use.map((i) => a.data[i]),
          use.map((i) => b.data[i]),
        );
      return { n: use.length, rho, p: significance(rho, use.length) };
    },
    short = (name) =>
      name.length > 8 ? name.slice(0, 6) + "~" + name.at(-1) : name;
  let first = null;
  // Seven variables to a block, as the Results window shows them.
  for (let start = 0; start < variables.length; start += 7) {
    const block = variables.slice(start, start + 7);
    ctx.out("");
    ctx.out(
      `             |${block.map((v) => short(v.name).padStart(9)).join("")}`,
    );
    ctx.out(`-------------+${"-".repeat(9 * block.length)}`);
    variables.slice(start).forEach((row, r) => {
      const across = block.slice(0, r + 1),
        results = across.map((column) => pair(row, column));
      first ??= variables.length > 1 && r === 1 ? results[0] : null;
      ctx.out(
        `${short(row.name).padStart(12)} | ${results
          .map((result, k) =>
            isMissing(result.rho) ||
            (options.print && across[k] !== row && !(result.p <= options.print))
              ? " ".repeat(9)
              : applyFormat(result.rho, "%8.4f") +
                (options.star && across[k] !== row && result.p <= options.star
                  ? "*"
                  : " "),
          )
          .join("")}`,
      );
      if (options.sig)
        ctx.out(
          `             | ${results
            .map((result, k) =>
              across[k] === row || isMissing(result.p)
                ? " ".repeat(9)
                : applyFormat(result.p, "%8.4f") + " ",
            )
            .join("")}`.trimEnd(),
        );
      if (options.obs)
        ctx.out(
          `             | ${results.map((result) => count(result.n).padStart(8) + " ").join("")}`.trimEnd(),
        );
      if (options.sig || options.obs) ctx.out("             |");
    });
  }
  if (!options.sig && !options.obs) ctx.out("");
  if (first) session.results.r = { N: first.n, rho: first.rho };
}

/** Ranks with ties given their average rank. */
export function ranks(values) {
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]),
    out = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && values[order[j + 1]] === values[order[i]])
      j++;
    for (let k = i; k <= j; k++) out[order[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

function spearman(session, text, ctx) {
  const parsed = session.parse(
      "varlist(min=2 max=2) [if] [in] [, | STats(string) Print(real 0) STar(real 0) PW Matrix]",
      text,
    ),
    [a, b] = numeric(session, parsed.varlist),
    rows = session
      .rows(parsed, null)
      .filter((i) => !isMissing(a.data[i]) && !isMissing(b.data[i])),
    n = rows.length;
  if (n < 2) throw new StataError("no observations", 2000);
  const rho = pearson(
      ranks(rows.map((i) => a.data[i])),
      ranks(rows.map((i) => b.data[i])),
    ),
    p = significance(rho, n);
  ctx.out("");
  ctx.out(` Number of obs = ${count(n).padStart(7)}`);
  ctx.out(`Spearman's rho = ${applyFormat(rho, "%12.4f")}`);
  ctx.out("");
  ctx.out(`Test of H0: ${a.name} and ${b.name} are independent`);
  ctx.out(`    Prob > |t| = ${applyFormat(p, "%12.4f")}`);
  ctx.out("");
  session.results.r = { N: n, rho, p };
}

function clonevar(session, text, ctx) {
  const m = /^\s*([A-Za-z_]\w*)\s*=\s*(\S+)([\s\S]*)$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  const data = session.data,
    source = data.get(session.varlist(m[2])[0]),
    parsed = session.parse("[if] [in]", m[3]),
    string = isStringType(source.type),
    values = new Array(data.n).fill(string ? "" : MISSING),
    sorted = [...data.sortedBy];
  if (data.has(m[1]))
    throw new StataError(`variable ${m[1]} already defined`, 110);
  session.select(parsed, null, (i) => (values[i] = source.data[i]));
  data.generate(m[1], values, { type: source.type });
  Object.assign(data.get(m[1]), {
    format: source.format,
    label: source.label,
    valueLabel: source.valueLabel,
  });
  data.sortedBy = sorted;
  const empty = values.filter((v) => (string ? v === "" : isMissing(v))).length,
    before = source.data.filter((v) =>
      string ? v === "" : isMissing(v),
    ).length;
  if (parsed.if || parsed.in ? empty : empty > before)
    ctx.out(
      `(${count(empty)} missing value${empty === 1 ? "" : "s"} generated)`,
    );
}

// Commands that act on Stata itself and not on the data. Each says what it
// would have done, so that a do-file written for Stata keeps running.
const note = (message) => (_session, _text, ctx) => ctx.out(message);
const quiet = () => {};

/**
 * timer on|off|clear|list [#]: wall-clock timers 1 to 100. Each keeps its
 * running total, how many times it was stopped, and when it was started.
 */
function timer(session, text, ctx) {
  const [action = "", which = ""] = text.trim().split(/\s+/),
    timers = (session.timers ??= new Map()),
    number = () => {
      const k = Number(which);
      if (!Number.isInteger(k) || k < 1 || k > 100)
        throw new StataError("timer number must be between 1 and 100", 198);
      return k;
    },
    entry = (k) => {
      if (!timers.has(k)) timers.set(k, { total: 0, count: 0, since: null });
      return timers.get(k);
    },
    now = () => (globalThis.performance ?? Date).now() / 1000;
  if (/^on$/.test(action)) {
    const t = entry(number());
    if (t.since !== null)
      throw new StataError(`timer ${which} already on`, 198);
    t.since = now();
  } else if (/^off$/.test(action)) {
    const t = entry(number());
    if (t.since === null) throw new StataError(`timer ${which} not on`, 198);
    t.total += now() - t.since;
    t.count += 1;
    t.since = null;
  } else if (/^clear$/.test(action)) {
    if (which) timers.delete(number());
    else timers.clear();
  } else if (/^(l(i(st?)?)?)?$/.test(action)) {
    const shown = which ? [number()] : [...timers.keys()].sort((a, b) => a - b);
    for (const k of shown) {
      const t = timers.get(k);
      if (!t?.count) continue;
      ctx.out(
        `${String(k).padStart(4)}:${applyFormat(t.total, "%10.2f")} /${String(t.count).padStart(9)} =${applyFormat(t.total / t.count, "%13.4f")}`,
      );
    }
  } else throw new StataError("invalid syntax", 198);
}
/**
 * A note as Stata's notes command shows it, in an SMCL paragraph: its
 * number, then its words, wrapped to the line size and indented under the
 * first word. A word that ends a sentence and was followed by two spaces or
 * more keeps two; other runs of spaces become one.
 */
function noteLines(number, text, linesize) {
  const k = String(number).length,
    rest = " ".repeat(k > 3 ? 7 : 6),
    lines = [];
  let line = " ".repeat(Math.max(3 - k, 0)),
    gap = "";
  for (const [, word, space] of `${number}.\n${text}`.matchAll(/(\S+)(\s*)/g)) {
    if (gap && displayWidth(line + gap + word) > linesize) {
      lines.push(line);
      line = rest + word;
    } else line += gap + word;
    gap =
      /[.?!:]$/.test(word) && (space.length > 1 || space.includes("\n"))
        ? "  "
        : " ";
  }
  lines.push(line);
  return lines;
}

/**
 * notes: text attached to the dataset (_dta) or to a variable, kept as the
 * characteristics note1, note2, ... with note0 the number of the last. Each
 * subcommand does what Stata's notes.ado does: notes [list] [evarlist] [in
 * #[/#]], notes [evarname]: text, notes drop evarlist [in #[/#]], notes
 * search text, notes replace evarname in # : text, notes renumber evarname.
 */
function notes(session, text, ctx) {
  const data = session.data,
    linesize = session.settings.linesize ?? 80,
    get = (owner, k) => data.chars?.get(owner)?.get(`note${k}`) ?? "",
    set = (owner, k, value) =>
      defineCharacteristic(data, owner, `note${k}`, value),
    // note0, as a number when it is one.
    last = (owner) => {
      const n = get(owner, 0).trim();
      return n !== "" && Number.isFinite(Number(n)) ? Number(n) : null;
    },
    varname = (word) => {
      const names = session.varlist(word);
      if (names.length > 1)
        throw new StataError("too many variables specified", 103);
      return names[0];
    },
    show = (owner, k) => {
      for (const line of noteLines(k, get(owner, k), linesize)) ctx.out(line);
    },
    // The word TS becomes the date and time, as Stata's $S_DATE $S_TIME.
    stamp = () => {
      const now = new Date(),
        month = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[
          now.getMonth()
        ];
      return `${String(now.getDate()).padStart(2)} ${month} ${now.getFullYear()} ${now.toTimeString().slice(0, 5)}`;
    },
    withStamp = (note) =>
      note.replace(/(^| )TS(?= |$)/g, (_, before) => before + stamp()),
    trimmed = text.trim(),
    first = /^(:|[^\s:]+)\s*([\s\S]*)$/.exec(trimmed) ?? ["", "", ""],
    [, one, after] = first;
  // notes [evarlist] [in #[/#]]: the owners and the range of numbers.
  const parse = (source) => {
    const padded = ` ${source.trim()} `,
      at = padded.indexOf(" in "),
      raw = (at < 0 ? padded : padded.slice(0, at)).trim(),
      range = at < 0 ? "" : padded.slice(at + 4).trim();
    let owners;
    if (!raw) owners = ["_dta", ...data.names];
    else {
      const words = raw.split(/\s+/),
        others = words.filter((word) => word !== "_dta");
      owners = others.length ? session.varlist(others.join(" ")) : [];
      if (others.length < words.length || raw === "_all") owners.push("_dta");
    }
    if (!range) return { listed: Boolean(raw), owners, from: 1, to: 9999 };
    const element = (word) => {
      if (/^[fF]$/.test(word)) return 1;
      if (/^[lL]$/.test(word)) return 10000;
      const k = Number(word);
      if (/^[+-]?\d+$/.test(word) && k >= 1 && k <= 9999) return k;
      throw new StataError(`${word}:  invalid range element`, 198);
    };
    const parts = range.split(/\s*(\/)\s*|\s+/).filter(Boolean),
      from = element(parts[0]);
    if (parts.length === 1)
      return { listed: Boolean(raw), owners, from, to: from };
    if (parts[1] === "/" && parts.length === 3) {
      const to = element(parts[2]);
      if (from <= to) return { listed: Boolean(raw), owners, from, to };
    }
    throw new StataError(`in ${range}:  invalid`, 198);
  };
  const list = (source) => {
    const { owners, from, to } = parse(source);
    for (const owner of owners) {
      const n = last(owner);
      if (n === null) continue;
      const top = Math.min(n, to),
        shown = [];
      for (let k = from; k <= top; k++) if (get(owner, k) !== "") shown.push(k);
      if (!shown.length) continue;
      ctx.out("");
      ctx.out(`${owner}:`);
      shown.forEach((k) => show(owner, k));
    }
  };
  const add = (owner, note) => {
    note = note.trim();
    if (!note) return ctx.out("  (no note added)");
    const n = last(owner);
    let next = 1;
    if (n !== null && Number.isInteger(n)) {
      if (n >= 9999) throw new StataError("too many notes", 103);
      next = n + 1;
    }
    set(owner, 0, String(next));
    set(owner, next, withStamp(note));
  };
  if (!trimmed) return list("");
  if (one.length <= 4 && "list".startsWith(one)) return list(after);
  if (one === ":") return add("_dta", after);
  if (one === "drop") {
    const { listed, owners, from, to } = parse(after);
    if (!listed) throw new StataError("invalid syntax", 198);
    let dropped = 0;
    for (const owner of owners) {
      const n = last(owner);
      if (n === null) continue;
      const top = Math.min(to, n);
      let k = from === 10000 ? top : from;
      while (k <= top && get(owner, k) === "") k++;
      if (k > top) continue;
      for (; k <= top; k++)
        if (get(owner, k) !== "") {
          set(owner, k, "");
          dropped++;
        }
      let left = n;
      while (left >= 1 && get(owner, left) === "") left--;
      set(owner, 0, left >= 1 ? String(left) : "");
    }
    ctx.out(`  (${dropped} note${dropped === 1 ? "" : "s"} dropped)`);
    return;
  }
  if (one === "search") {
    const words = after.match(/"[^"]*"|`"[\s\S]*?"'|\S+/g) ?? [],
      find = (words[0] ?? "").replace(/^`?"([\s\S]*)"'?$/, "$1");
    if (!find) throw new StataError("something required", 100);
    if (words.length > 1) throw new StataError("invalid syntax", 198);
    let found = false;
    for (const owner of ["_dta", ...data.names]) {
      const n = last(owner);
      if (n === null) continue;
      let header = false;
      for (let k = 1; k <= n; k++)
        if (get(owner, k).includes(find)) {
          if (!header) {
            ctx.out("");
            ctx.out(`${owner}:`);
            header = true;
          }
          show(owner, k);
          found = true;
        }
    }
    if (!found) ctx.out(`${find}: not found`);
    return;
  }
  if (one === "replace") {
    const m = /^(\S+)\s+(\S+)\s+([^\s:]+)\s*:([\s\S]*)$/.exec(after);
    if (!m || m[2] !== "in") throw new StataError("invalid syntax", 198);
    if (!/^[+-]?\d+$/.test(m[3])) throw new StataError("", 198);
    let owner = m[1];
    if (owner !== "_dta") {
      try {
        owner = varname(owner);
      } catch (error) {
        if (error instanceof StataError) {
          ctx.out(error.message);
          throw new StataError("", 198);
        }
        throw error;
      }
    }
    const k = Number(m[3]),
      note = m[4].trim();
    if (!note || get(owner, k) === "") return ctx.out("  (no note replaced)");
    set(owner, k, withStamp(note));
    ctx.out(`  (note ${k} for ${m[1]} replaced)`);
    return;
  }
  if (one === "renumber") {
    const [who, ...extra] = after.split(/\s+/).filter(Boolean);
    if (!who)
      throw new StataError("nothing found where varname or _dta expected", 198);
    if (extra.length)
      throw new StataError(
        `${extra.join(" ")} found where nothing expected`,
        198,
      );
    let owner = "_dta";
    if (who !== "_dta") {
      try {
        owner = varname(who);
      } catch (error) {
        if (!(error instanceof StataError)) throw error;
        throw new StataError(
          `${who} found where varname or _dta expected`,
          111,
        );
      }
    }
    const n = last(owner);
    if (n === null || n <= 0) return;
    const kept = [];
    for (let k = 1; k <= n; k++) {
      if (get(owner, k) !== "") kept.push(get(owner, k));
      set(owner, k, "");
    }
    set(owner, 0, String(kept.length));
    kept.forEach((note, j) => set(owner, j + 1, note));
    return;
  }
  // The programmer's subcommands: notes _count, _fetch and _dir.
  if (one === "_count" || one === "_fetch" || one === "_dir") {
    const m = /^(\w+)\s*:\s*(\S*)\s*(\S*)\s*$/.exec(after);
    if (!m) throw new StataError("invalid syntax", 198);
    const owner = m[2] === "_dta" || one === "_dir" ? m[2] : varname(m[2]);
    let value;
    if (one === "_count") value = get(owner, 0) || "0";
    else if (one === "_fetch") value = get(owner, m[3]);
    else
      value = [
        ...(get("_dta", 0) && get("_dta", 0) !== "0" ? ["_dta"] : []),
        ...data.names
          .filter((name) => get(name, 0) && get(name, 0) !== "0")
          .sort(),
      ].join(" ");
    ctx.frame.locals.set(m[1], value);
    return;
  }
  const colon = /^:\s*([\s\S]*)$/.exec(after);
  if (colon) return add(one === "_dta" ? "_dta" : varname(one), colon[1]);
  list(trimmed);
}

/**
 * char: characteristics, the named texts kept with the dataset (_dta) and
 * with each variable. char [define] evarname[charname] [text] defines one
 * (no text deletes it); char list [evarname[[charname]]] lists them; char
 * rename oldvar newvar [, replace] moves a variable's to another.
 */
function char(session, text, ctx) {
  const data = session.data,
    chars = (data.chars ??= new Map()),
    owner = (word) => {
      if (word === "_dta") return word;
      if (/[*?~\s-]/.test(word))
        throw new StataError(`${word} invalid name`, 198);
      return session.varlist(word)[0];
    },
    target = (word, empty) => {
      const m = /^([^[\]\s]+)\[([^[\]\s]*)\]$/.exec(word);
      if (!m || (!empty && !m[2]))
        throw new StataError(`${word || "nothing"} invalid name`, 198);
      if (m[2] && !/^[\p{L}_][\p{L}\p{N}_]{0,31}$/u.test(m[2]))
        throw new StataError(`${m[2]} invalid name`, 198);
      return [owner(m[1]), m[2]];
    },
    show = (who, name, value) => {
      const head = `  ${who}[${name}]:`,
        room = (session.settings.linesize ?? 80) - 31,
        shown =
          value.length > room
            ? value.slice(0, Math.max(0, room - 2)) + ".."
            : value;
      if (head.length > 29) {
        ctx.out(head);
        ctx.out(" ".repeat(30) + shown);
      } else ctx.out(head.padEnd(30) + shown);
    };
  const m = /^\s*(\S*)\s*([\s\S]*)$/.exec(text),
    verb = m[1];
  if (/^l(i(st?)?)?$/.test(verb)) {
    const word = m[2].trim();
    if (!word) {
      for (const who of ["_dta", ...data.names])
        for (const [name, value] of characteristicsOf(data, who))
          show(who, name, value);
      return;
    }
    if (/\s/.test(word)) throw new StataError("invalid syntax", 198);
    const [who, name] = target(word, true);
    // A characteristic that is not defined is listed with no text.
    if (name) show(who, name, chars.get(who)?.get(name) ?? "");
    else
      for (const [key, value] of characteristicsOf(data, who))
        show(who, key, value);
    return;
  }
  if (verb === "rename") {
    const parsed = /^(\S+)\s+(\S+)\s*(?:,\s*(\S*)\s*)?$/.exec(m[2]);
    if (!parsed) throw new StataError("invalid syntax", 198);
    if (parsed[3] !== undefined && parsed[3] !== "replace")
      throw new StataError(`option ${parsed[3]} not allowed`, 198);
    const from = owner(parsed[1]),
      to = owner(parsed[2]),
      theirs = characteristicsOf(data, to);
    if (from === to) return;
    if (!parsed[3])
      for (const [name] of characteristicsOf(data, from))
        if (theirs.some(([key]) => key === name))
          throw new StataError(
            `characteristic ${to}[${name}] already exists`,
            110,
          );
    // Each is defined again on the new owner in turn, so their order turns
    // over, as it does in Stata.
    const theirsMoved = characteristicsOf(data, from).reverse(),
      moved = new Map([
        ...theirsMoved,
        ...[...(chars.get(to) ?? [])].filter(
          ([key]) => !theirsMoved.some(([name]) => name === key),
        ),
      ]);
    chars.set(to, moved);
    chars.delete(from);
    return;
  }
  // char [define] evarname[charname] [text]
  const rest =
      verb === "define" || verb === "def" || verb === "defi" || verb === "defin"
        ? m[2]
        : text,
    d = /^\s*(\S+?\[[^\]]*\])\s?([\s\S]*)$/.exec(rest);
  if (!d) throw new StataError("invalid syntax", 198);
  const [who, name] = target(d[1], false);
  defineCharacteristic(data, who, name, charText(d[2].trim()));
}
/**
 * The text of char define: the outer double quotes or compound quotes, when
 * it starts with them, are taken off, and only those; an opening quote
 * without its closing one is an error.
 */
function charText(text) {
  if (text.startsWith('`"')) {
    if (text.length < 4 || !text.endsWith("\"'"))
      throw new StataError("invalid syntax", 198);
    return text.slice(2, -2);
  }
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"'))
      throw new StataError("invalid syntax", 198);
    return text.slice(1, -1);
  }
  return text;
}

/**
 * When a value label is attached or grows, Stata widens the %g, %f or %e
 * format of each variable carrying it to the bytes of its longest text,
 * dropping a - or 0 modifier; it never narrows one, and leaves dates and
 * the binary formats alone.
 */
export function widenForLabel(session, name) {
  const map = session.data.valueLabels.get(name);
  if (!map) return;
  let longest = 0;
  for (const text of map.values())
    longest = Math.max(longest, byteLength(text));
  for (const variable of session.data.variables ?? []) {
    if (variable.valueLabel !== name) continue;
    const spec = parseFormat(variable.format ?? "");
    if (
      spec?.kind !== "number" ||
      !/^%-?0?\d+\.\d+[gfe]c?$/.test(variable.format)
    )
      continue;
    const width = Math.min(longest, 2045);
    if (width > spec.width)
      variable.format = `%${width}.${spec.digits}${spec.style}${spec.commas ? "c" : ""}`;
  }
}

/** A labelled value as Stata writes it: 1, -5, 100000, .a. */
const valueText = (value) =>
  isMissing(value) ? missingName(value) : applyFormat(value, "%20.0g").trim();

/**
 * numlabel, as numlabel.ado does it: puts each value, through mask(), in
 * front of its label, or takes it away. A label that is only partly
 * prefixed is refused unless force is given. Every label named is then
 * defined again, in alphabetical order, so formats widen as label define
 * widens them.
 */
function numlabel(session, text, ctx) {
  const parsed = session.parse(
      "[anything] [, Add Remove Mask(string) Detail force]",
      text,
    ),
    { options } = parsed,
    head = parsed.anything ?? "";
  if (options.add && options.remove)
    throw new StataError(
      "options add and remove must not be both specified",
      198,
    );
  if (!options.add && !options.remove)
    throw new StataError("option add or remove should be specified", 198);
  const mask = options.mask ? options.mask : "#. ";
  if (options.mask && mask.split("#").length !== 2)
    throw new StataError(
      `mask ${mask} should contain 1 substitution char #`,
      198,
    );
  // numlabel.ado works between preserve and restore, and restore reads the
  // value labels back in reverse order, whatever happens next.
  const labels = (session.data.valueLabels = new Map(
      [...session.data.valueLabels].reverse(),
    )),
    named = head.trim() ? head.trim().split(/\s+/) : [];
  // matalabel takes _all, or names, which it confirms before it looks for
  // them.
  for (const name of named) {
    const bad = /^[A-Za-z_]\w*(.+)$/.exec(name)?.[1] ?? name;
    if (!/^[A-Za-z_]\w{0,31}$/.test(name))
      throw new StataError(`${bad} invalid name`, 198);
  }
  const all = named.includes("_all");
  for (const name of named)
    if (name !== "_all" && !labels.has(name))
      throw new StataError(`value label ${name} not found`, 111);
  if (!labels.size) return ctx.out("(dataset has no value labels)");
  const names = [
      ...new Set(named.length && !all ? named : labels.keys()),
    ].sort(),
    prefixOf = (value) => mask.replace("#", () => valueText(value)),
    has = (value, label) => label.startsWith(prefixOf(value));
  if (!options.force) {
    const partial = names.filter((name) => {
      const marks = [...labels.get(name)].map(([v, l]) => has(v, l));
      return marks.some(Boolean) && !marks.every(Boolean);
    });
    if (partial.length) {
      if (options.detail) {
        ctx.out("");
        ctx.out("The following value labels are only partially numlabel-ed");
        for (const name of partial) {
          ctx.out("-".repeat(session.settings.linesize ?? 80));
          ctx.out(`-> lname = ${name}`);
          ctx.out("");
          ctx.out("  value         label");
          for (const [value, label] of [...labels.get(name)].sort(
            (a, b) => a[0] - b[0],
          ))
            ctx.out(`  ${valueText(value).padStart(9)}     ${label}`);
          ctx.out("");
        }
      } else {
        ctx.out("there are value labels that are only partially numlabel-ed");
        ctx.out("specify option detail for a list of these value labels");
      }
      throw new StataError(
        "specify option force to modify value labels anyway",
        180,
      );
    }
  }
  let changed = 0;
  const made = names.map((name) => {
    const map = new Map();
    for (const [value, label] of labels.get(name)) {
      const prefix = prefixOf(value),
        next = options.add
          ? has(value, label)
            ? label
            : prefix + label
          : has(value, label)
            ? label.slice(prefix.length)
            : label;
      if (next !== label) changed++;
      map.set(value, next);
    }
    return [name, map];
  });
  if (!changed) return ctx.out("(no value label to be modified)");
  // Each label is defined again with label define, modify: it becomes the
  // most recently defined, and formats widen to its longest text.
  for (const [name, map] of made) {
    labels.delete(name);
    labels.set(name, map);
    widenForLabel(session, name);
  }
}

export const EVERYDAY_COMMANDS = [
  { name: "notes", minimum: 4, run: notes },
  { name: "char", minimum: 4, run: char },
  { name: "numlabel", minimum: 8, run: numlabel },
  { name: "labelbook", minimum: 9, run: labelbook },
  {
    name: "which",
    minimum: 5,
    run: (_session, text, ctx) =>
      ctx.out(
        `(${text.trim().split(/\s+/)[0] || "that command"}: which reports where Stata keeps a command's file; there are no such files here)`,
      ),
  },
  {
    name: "query",
    minimum: 1,
    run: (session, _text, ctx) => {
      ctx.out("");
      ctx.out(`    Settings of this session`);
      ctx.out(`      set type       ${session.data.defaultType}`);
      ctx.out(`      set level      ${session.settings.level}`);
      ctx.out(`      set linesize   ${session.settings.linesize ?? 80}`);
      ctx.out(`      set seed       ${session.settings.seed}`);
      ctx.out("");
    },
  },
  { name: "mean", minimum: 4, run: mean },
  // ci is byable(recall) in Stata: under by it runs once per group.
  { name: "ci", minimum: 2, run: perGroup(ci), byable: true },
  { name: "pwcorr", minimum: 6, run: pwcorr },
  { name: "spearman", minimum: 8, run: spearman },
  { name: "clonevar", minimum: 8, run: clonevar },
  {
    name: "browse",
    minimum: 2,
    run: note(
      "(browse opens Stata's Data Editor; here, use list to see the data)",
    ),
  },
  {
    name: "edit",
    minimum: 2,
    run: note(
      "(edit opens Stata's Data Editor; here, use replace to change values)",
    ),
  },
  {
    name: "help",
    minimum: 1,
    run: note(
      "(Stata's help files are not included; see stata.com/help.cgi for a command's help)",
    ),
  },
  {
    name: "search",
    minimum: 3,
    run: note(
      "(search looks through Stata's own documentation, which is not included)",
    ),
  },
  {
    name: "findit",
    minimum: 6,
    run: note(
      "(findit looks through Stata's own documentation, which is not included)",
    ),
  },
  {
    name: "ssc",
    minimum: 3,
    run: note(
      "(community-contributed packages cannot be installed in the browser; commands such as esttab, outreg2 and reghdfe are not available here)",
    ),
  },
  {
    name: "net",
    minimum: 3,
    run: note(
      "(community-contributed packages cannot be installed in the browser)",
    ),
  },
  { name: "cls", minimum: 3, run: quiet },
  { name: "sleep", minimum: 5, run: quiet },
  { name: "timer", minimum: 5, run: timer },
  {
    name: "about",
    minimum: 5,
    run: note(
      "STATAverse runtime: a browser implementation of part of Stata's language, checked against Stata 17. It is not Stata.",
    ),
  },
];

// ----- label copy, rename, save and language; labelbook -----

/** The value-label text of a do-file: `"text"', as Stata writes it. */
const compound = (text) => '`"' + text + "\"'";
const sortedEntries = (map) => [...map].sort((a, b) => a[0] - b[0]);

/** label copy lblname lblname [, replace] */
function labelCopy(session, text) {
  const parsed = session.parse("anything [, replace]", text),
    names = (parsed.anything ?? "").trim().split(/\s+/).filter(Boolean),
    labels = session.data.valueLabels;
  if (names.length !== 2) throw new StataError("invalid syntax", 198);
  const [from, to] = names;
  if (!labels.has(from)) throw new StataError(`label ${from} not found`, 111);
  if (!isName(to)) throw new StataError(`${to} invalid name`, 198);
  if (labels.has(to) && !parsed.options.replace)
    throw new StataError(`label ${to} already defined`, 110);
  const map = new Map(labels.get(from));
  labels.delete(to);
  labels.set(to, map);
  widenForLabel(session, to);
}

/** label rename lblname newlblname [, replace]: renames and reattaches. */
function labelRename(session, text) {
  const parsed = session.parse("anything [, replace]", text),
    names = (parsed.anything ?? "").trim().split(/\s+/).filter(Boolean),
    data = session.data,
    labels = data.valueLabels;
  if (names.length !== 2) throw new StataError("invalid syntax", 198);
  const [from, to] = names;
  if (!labels.has(from)) throw new StataError(`label ${from} not found`, 111);
  if (!isName(to)) throw new StataError(`${to} invalid name`, 198);
  if (from === to) return;
  if (labels.has(to) && !parsed.options.replace)
    throw new StataError(`label ${to} already defined`, 110);
  const map = labels.get(from);
  labels.delete(from);
  labels.delete(to);
  labels.set(to, map);
  for (const variable of data.variables)
    if (variable.valueLabel === from) variable.valueLabel = to;
}

/** label save [lblnames] using filename [, replace]: a do-file of label define. */
function labelSave(session, text, ctx) {
  const m = /^([\s\S]*?)\busing\b([\s\S]*)$/.exec(text);
  if (!m) throw new StataError("using required", 100);
  const parsed = session.parse("anything [, replace]", m[2]),
    target = (parsed.anything ?? "")
      .trim()
      .replace(/^`"([\s\S]*)"'$|^"([\s\S]*)"$/, "$1$2"),
    labels = session.data.valueLabels,
    named = m[1].trim() ? m[1].trim().split(/\s+/) : [];
  if (!target) throw new StataError("invalid file specification", 198);
  const name = /\.[A-Za-z0-9]+$/.test(target) ? target : target + ".do";
  for (const label of named)
    if (!labels.has(label))
      throw new StataError(`value label ${label} not found`, 111);
  if (!labels.size) throw new StataError("no value labels found", 111);
  const files = (session.files ??= new Map());
  if (files.has(name) && !parsed.options.replace)
    throw new StataError(`file ${name} already exists`, 602);
  if (parsed.options.replace && !files.has(name))
    ctx.out(`(file ${name} not found)`);
  // Without names, every label, the most recently defined first, as label
  // dir lists them.
  const lines = [];
  for (const label of named.length ? named : [...labels.keys()].reverse())
    for (const [value, text] of sortedEntries(labels.get(label)))
      lines.push(
        `label define ${label} ${isMissing(value) ? missingName(value) : valueText(value)} ${compound(text)}, modify`,
      );
  files.set(name, { text: lines.map((line) => line + "\n").join("") });
  ctx.out(`file ${name} saved`);
}

// ----- label language -----
const langChar = (kind, language) => `_lang_${kind}_${language}`;
function languages(data) {
  const own = new Map(characteristicsOf(data, "_dta"));
  return {
    current: own.get("_lang_c") ?? "default",
    list: (own.get("_lang_list") ?? "default").split(/\s+/).filter(Boolean),
  };
}
/** The labels in use go into characteristics of the language they are in. */
function storeLanguage(data, language) {
  defineCharacteristic(data, "_dta", langChar("v", language), data.label ?? "");
  for (const variable of data.variables) {
    defineCharacteristic(
      data,
      variable.name,
      langChar("v", language),
      variable.label ?? "",
    );
    defineCharacteristic(
      data,
      variable.name,
      langChar("l", language),
      variable.valueLabel ?? "",
    );
  }
}
/** The labels of a language come out of the characteristics into use. */
function loadLanguage(session, language) {
  const data = session.data,
    take = (owner, kind) => {
      const name = langChar(kind, language),
        text = new Map(characteristicsOf(data, owner)).get(name) ?? "";
      defineCharacteristic(data, owner, name, "");
      return text;
    };
  data.label = take("_dta", "v");
  for (const variable of data.variables) {
    variable.label = take(variable.name, "v");
    variable.valueLabel = take(variable.name, "l");
    if (variable.valueLabel) widenForLabel(session, variable.valueLabel);
  }
}
function dropLanguage(data, language) {
  for (const owner of ["_dta", ...data.names])
    for (const kind of ["v", "l"])
      defineCharacteristic(data, owner, langChar(kind, language), "");
}

function labelLanguage(session, text, ctx) {
  const data = session.data,
    linesize = session.settings.linesize ?? 80,
    [head, optionText] = splitAtComma(text),
    words = head.trim().split(/\s+/).filter(Boolean);
  // The first use of label language names the labels in use "default".
  if (!new Map(characteristicsOf(data, "_dta")).has("_lang_c")) {
    defineCharacteristic(data, "_dta", "_lang_c", "default");
    defineCharacteristic(data, "_dta", "_lang_list", "default");
  }
  const { current, list } = languages(data);
  if (words.length > 1) throw new StataError("varlist not allowed", 101);
  if (!words.length && optionText !== null)
    throw new StataError(", invalid name", 198);
  if (!words.length) {
    const out = (line) => fold(line, linesize).forEach((l) => ctx.out(l));
    ctx.out("");
    ctx.out("Language for variable and value labels");
    ctx.out("-".repeat(38));
    ctx.out("");
    if (list.length === 1)
      smclParagraph(
        [
          "In this dataset, value and variable labels have been defined in only one language:",
          current,
        ],
        linesize,
      ).forEach((line) => ctx.out(line));
    else {
      ctx.out("    Available languages:");
      for (const name of [...list].sort()) ctx.out(`            ${name}`);
      ctx.out("");
      out(`    Currently set is:               . label language ${current}`);
      ctx.out("");
      out("    To select different language:   . label language <name>");
    }
    ctx.out("");
    out("    To create new language:         . label language <name>, new");
    out("    To rename current language:     . label language <name>, rename");
    session.results.r = {
      k: list.length,
      languages: [...list].sort().join(" "),
      language: current,
    };
    return;
  }
  const options = session.parse(
      "[, new copy rename delete]",
      optionText ? "," + optionText : "",
    ).options,
    language = words[0],
    chosen = ["delete", "new", "rename"].filter((option) => options[option]);
  if (chosen.length > 1)
    throw new StataError(
      "options -delete-, -new-, and -rename- may be not be combined",
      198,
    );
  if (options.copy && !options.new)
    ctx.out("option -copy- may only be specified with option -new-");
  if (
    (options.new || options.rename) &&
    !(isName(language) && language.length <= 24)
  )
    throw new StataError(`${language} invalid name`, 198);
  if (options.new || options.rename) {
    if (list.includes(language))
      throw new StataError(`language ${language} already exists`, 110);
    if (options.rename) {
      defineCharacteristic(
        data,
        "_dta",
        "_lang_list",
        list.map((name) => (name === current ? language : name)).join(" "),
      );
      defineCharacteristic(data, "_dta", "_lang_c", language);
      ctx.out(`(language ${current} renamed ${language})`);
      return;
    }
    // The languages there were, in alphabetical order, then the new one.
    defineCharacteristic(
      data,
      "_dta",
      "_lang_list",
      [...[...list].sort(), language].join(" "),
    );
    storeLanguage(data, current);
    if (!options.copy) {
      data.label = "";
      for (const variable of data.variables) {
        variable.label = "";
        variable.valueLabel = "";
      }
    }
    defineCharacteristic(data, "_dta", "_lang_c", language);
    ctx.out(`(language ${language} now current language)`);
    return;
  }
  if (!list.includes(language))
    throw new StataError(`language ${language} not defined`, 111);
  if (options.delete) {
    if (list.length === 1)
      throw new StataError(
        `language ${language} is the only language defined; it may not be deleted`,
        119,
      );
    // The languages left are listed in alphabetical order, and the first
    // of them becomes current when the current one goes.
    const left = list
      .filter((name) => name !== language)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (language === current) {
      loadLanguage(session, left[0]);
      defineCharacteristic(data, "_dta", "_lang_c", left[0]);
      ctx.out(`(language ${left[0]} now current language)`);
    } else dropLanguage(data, language);
    defineCharacteristic(data, "_dta", "_lang_list", left.join(" "));
    return;
  }
  if (language === current)
    return ctx.out(`(${language} already current language)`);
  storeLanguage(data, current);
  loadLanguage(session, language);
  defineCharacteristic(data, "_dta", "_lang_c", language);
}

/**
 * label subcommands beyond those label() itself handles; false when the
 * subcommand is not one of them.
 */
export function labelSubcommand(session, text, ctx) {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return false;
  const [, word, rest] = m;
  if (word === "copy") labelCopy(session, rest);
  else if (word === "rename") labelRename(session, rest);
  else if (word === "save") labelSave(session, rest, ctx);
  else if (word.length >= 4 && "language".startsWith(word))
    labelLanguage(session, rest, ctx);
  else return false;
  return true;
}

// ----- labelbook -----

/**
 * labelbook, as labelbook.ado reports: for each value label, its values
 * and labels, the checks it makes of them, its definition and the
 * variables that use it in each language; problems lists the labels each
 * check finds wanting.
 */
function labelbook(session, text, ctx) {
  const parsed = session.parse(
      "[anything] [using/] [, Alpha Detail LEngth(integer 12) LIst(integer 32000) Problems]",
      text,
    ),
    { options } = parsed,
    sh = options.length,
    show = options.list,
    linesize = session.settings.linesize ?? 80;
  if (!(sh >= 1 && sh <= 2045))
    throw new StataError("length() should be in range [1,2045]", 198);
  if (show < 0) throw new StataError("list() should be positive", 198);
  // labelbook.ado works between preserve and restore, and restore reads the
  // value labels back in reverse order.
  session.data.valueLabels = new Map([...session.data.valueLabels].reverse());
  const detail = options.detail || !options.problems,
    data = parsed.using ? load(session, fileName(parsed.using)) : session.data,
    labels = data.valueLabels,
    named = (parsed.anything ?? "").trim().split(/\s+/).filter(Boolean);
  for (const name of named)
    if (!labels.has(name))
      throw new StataError(`value label ${name} not found`, 111);
  const names = [...new Set(named.length ? named : labels.keys())].sort(
      (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    ),
    rows = names.flatMap((name) =>
      sortedEntries(labels.get(name)).map(([value, label]) => ({
        name,
        value,
        label,
      })),
    );
  if (!rows.length) return void ctx.out("(dataset has no value labels)");
  // list() picks that many labels of each at random, by uniform() draws
  // made for every label in turn.
  if (show !== 32000) {
    const state = session.state;
    for (const row of rows)
      row.draw = (state.rng ??= new Generator(state.seed)).uniform();
  }
  // The variables that use each label: in the language in use, then in
  // the others.
  const { current, list } = languages(data),
    others = list.filter((name) => name !== current),
    users = (name, language) =>
      data.variables
        .filter((variable) =>
          language === current
            ? variable.valueLabel === name
            : new Map(characteristicsOf(data, variable.name)).get(
                langChar("l", language),
              ) === name,
        )
        .map((variable) => variable.name),
    found = {
      gaps: [],
      numeric: [],
      blanks: [],
      null: [],
      nuniq: [],
      ntruniq: [],
      nuniq_sh: [],
    },
    notused = names
      .filter((name) =>
        [current, ...others].every((l) => !users(name, l).length),
      )
      .sort();
  const g = (value) =>
      isMissing(value)
        ? missingName(value)
        : applyFormat(value, "%9.0g").trim(),
    at = (line, column) => line.padEnd(column - 1),
    yes = (flag) => (flag ? "yes" : "no");
  for (const name of names) {
    const mine = rows.filter((row) => row.name === name),
      present = mine.filter((row) => !isMissing(row.value)),
      lengths = mine.map((row) => byteLength(row.label)),
      texts = mine.map((row) => row.label),
      unique = (list) => new Set(list).size === list.length,
      full = unique(texts),
      short = unique(texts.map((t) => [...t].slice(0, sh).join(""))),
      nmiss = mine.length - present.length,
      low = present.length ? present[0].value : mine[0].value,
      high = present.length ? present.at(-1).value : MISSING,
      // With no nonmissing value the gap is missing, which counts as one.
      gaps = present.length ? high - low + 1 - present.length > 0 : true,
      isNull = texts.some((t) => t.trim() === ""),
      blanks = texts.some((t) => t.replace(/^ +| +$/g, "") !== t),
      numeric = texts.some((t) => !isMissing(parseNumber(t.trim()) ?? MISSING));
    if (gaps) found.gaps.push(name);
    if (numeric) found.numeric.push(name);
    if (blanks) found.blanks.push(name);
    if (isNull) found.null.push(name);
    if (!full) found.nuniq.push(name);
    if (!short) found.nuniq_sh.push(name);
    if (!detail) continue;
    ctx.out("");
    ctx.out("-".repeat(linesize));
    ctx.out(`Value label ${name}`);
    ctx.out("-".repeat(linesize));
    ctx.out("");
    ctx.out(at("      Values", 49) + "Labels");
    ctx.out(
      at(`       Range:  [${g(low)},${g(high)}]`, 42) +
        `String length:  [${Math.min(...lengths)},${Math.max(...lengths)}]`,
    );
    ctx.out(
      at(`           N:  ${mine.length}`, 34) +
        `Unique at full length:  ${yes(full)}`,
    );
    ctx.out(
      at(`        Gaps:  ${yes(gaps)}`, 36) +
        `Unique at length ${sh}:`.padStart(20) +
        `  ${yes(short)}`,
    );
    ctx.out(at(`  Missing .*:  ${nmiss}`, 44) + `Null string:  ${yes(isNull)}`);
    ctx.out(`${" ".repeat(31)}Leading/trailing blanks:  ${yes(blanks)}`);
    ctx.out(`${" ".repeat(36)}Numeric -> numeric:  ${yes(numeric)}`);
    if (show > 0) {
      ctx.out("  Definition");
      let shown = mine;
      if (mine.length > show) {
        ctx.out(`       ${show} random examples out of ${mine.length} labels`);
        ctx.out("");
        const picked = new Set(
          [...mine].sort((a, b) => a.draw - b.draw).slice(0, show),
        );
        shown = mine.filter((row) => picked.has(row));
      }
      if (options.alpha)
        shown = [...shown].sort((a, b) =>
          a.label < b.label ? -1 : a.label > b.label ? 1 : a.value - b.value,
        );
      for (const row of shown) {
        const v = g(row.value);
        if (row.label.trim() === "") {
          ctx.out(v.padStart(12));
          continue;
        }
        // {p 0 15 2}: the value, then the label's words, filled.
        const words = row.label.split(/ +/).filter(Boolean),
          width = linesize - 2;
        let line = `${" ".repeat(Math.max(0, 12 - v.length))}${v}   ${words.shift()}`;
        for (const word of words)
          if (line.length + 1 + word.length <= width) line += " " + word;
          else {
            ctx.out(line);
            line = " ".repeat(15) + word;
          }
        ctx.out(line);
      }
    }
    ctx.out("");
    const fill = (lead, rest, items) => {
      let line = lead;
      for (const item of items)
        if (line.length + 1 + item.length <= linesize || line === lead)
          line += (line.endsWith(" ") ? "" : " ") + item;
        else {
          ctx.out(line);
          line = " ".repeat(rest) + item;
        }
      ctx.out(line.trimEnd());
    };
    if (list.length === 1) fill("   Variables:  ", 15, users(name, current));
    else {
      let used = false;
      for (const language of [current, ...others]) {
        const vars = users(name, language);
        if (!vars.length) continue;
        used = true;
        fill(`   in ${language} attached to `, 23, vars);
      }
      if (!used) ctx.out("  not attached to any variable in any language");
    }
    ctx.out("");
  }
  if (options.problems) {
    const dataset = data.filename || "[unnamed]",
      checks = [
        [found.numeric, "Numeric -> numeric"],
        [found.gaps, "Gaps in mapped values"],
        [found.blanks, "Leading or trailing blanks"],
        [found.null, "Numeric -> null str"],
        [found.nuniq, "Duplicate labels"],
        [found.ntruniq, "Duplicate lab. at length 2045"],
        [found.nuniq_sh, `Duplicate lab. at length ${sh}`],
        [notused, "Not used by variables"],
      ],
      longest = Math.max(...checks.map(([items]) => items.join(" ").length));
    ctx.out("");
    if (!longest) ctx.out(`no potential problems in dataset ${dataset}`);
    else {
      ctx.out(`   Potential problems in dataset   ${dataset}`);
      ctx.out("");
      ctx.out(`${" ".repeat(15)}Potential problem   Value labels`);
      const rule = "-".repeat(Math.min(Math.max(35 + longest, 50), linesize));
      ctx.out(rule);
      for (const [items, label] of checks) {
        if (!items.length) continue;
        let line = `${label.padStart(32)}   ${items[0]}`;
        for (const item of items.slice(1))
          if (line.length + 1 + item.length <= linesize) line += " " + item;
          else {
            ctx.out(line);
            line = " ".repeat(35) + item;
          }
        ctx.out(line);
      }
      ctx.out(rule);
    }
  }
  // labelbook.ado returns names first and notused last; return list shows
  // them the other way round.
  const r = {};
  for (const [key, items] of [
    ["notused", notused],
    ["nuniq_sh", found.nuniq_sh],
    ["ntruniq", found.ntruniq],
    ["nuniq", found.nuniq],
    ["null", found.null],
    ["blanks", found.blanks],
    ["numeric", found.numeric],
    ["gaps", found.gaps],
    ["names", names],
  ])
    if (items.length) r[key] = items.join(" ");
  session.results.r = r;
}
