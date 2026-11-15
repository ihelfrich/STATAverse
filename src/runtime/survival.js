// Survival analysis: stset and the st commands that read its settings,
// stdescribe, stsum, sts list, sts graph, sts test, stcox, streg and
// estat phtest after stcox.
//
// stset keeps its settings where Stata keeps them, in characteristics of
// _dta (st_bt, st_bd, st_ev, st_id, st_enter, st_exit, st_orig, st_bs and
// the rest), and makes the variables _st, _d, _t and _t0 as st_set.ado
// makes them, so that a dataset saved here and opened in Stata is set the
// same way. Every st command shows the settings it works under, as
// st_show.ado shows them, before its own output.
//
// The Kaplan–Meier tables follow st_ct.ado and sts.ado: one row for each
// time at which a record enters or leaves, the number at risk counted
// before any entries at that time. stcox fits the Cox model by the
// Newton steps of maximizeNR, with Breslow's, Efron's or the exact
// marginal treatment of ties, and streg the exponential, Weibull and
// Gompertz models in Stata's parameterisation, with the log likelihood
// reported as Stata reports it.
import { StataError } from "./errors.js";
import { evaluateAll } from "./expression.js";
import { applyFormat } from "./format.js";
import { renderSmcl } from "./smcl.js";
import { chi2tail, invttail } from "./distributions.js";
import { invnormal } from "./functions-normal.js";
import { defineCharacteristic } from "./store.js";
import { splitAtComma } from "./syntax.js";
import { parseNumlist } from "./numlist.js";
import {
  MISSING,
  formatNumber,
  inferType,
  isMissing,
  isStringType,
  promote,
} from "./values.js";
import { percentile } from "./reports.js";
import {
  abbreviate,
  baseLevelsAsked,
  coefficientSpace,
  estimates,
  stripeName,
  tableWidth,
} from "./estimation.js";
import {
  frame,
  generalizedInverse,
  iterationLine,
  layoutRows,
  maximizeNR,
  quadSum,
  row,
  rule,
  split,
  tableHead,
  tableModel,
  unconverged,
} from "./likelihood.js";
import { draw } from "./graphics.js";
import { LOOKS, looksOf, parseGraph, withStyleNotes } from "./graph-looks.js";

// ----- small helpers -----
const known = (v) =>
  typeof v === "number" && Number.isFinite(v) && !isMissing(v);
/** A number in a display format; one that is not a number shows missing. */
const fmt = (v, format) => applyFormat(known(v) ? v : MISSING, format);
const trimmed = (v, format) => fmt(v, format).trim();
const invalid = (message) => new StataError(message, 198);
const notHere = (what, hint = "") =>
  new StataError(`${what} is not available in the browser yet`, 198, hint);
const column = (text, at) => text.padEnd(at - 1);
/** Stata's compress applied to a double: the smallest integer type, else double. */
function compressedType(values) {
  const type = inferType(values);
  return type === "float" ? "double" : type;
}
/** A missing value of a variable: "" for a string, . and above for a number. */
const missingIn = (variable, i) =>
  isStringType(variable.type)
    ? variable.data[i] === ""
    : isMissing(variable.data[i]);
/** abbrev(name, n) as Stata gives it. */
const abbrev = (name, n) => abbreviate(name, n);

// ----- the settings -----
const CLEARED = [
  "_dta",
  "st_set",
  "st_ver",
  "st_id",
  "st_bt0",
  "st_bt",
  "st_bd",
  "st_ev",
  "st_enter",
  "st_enexp",
  "st_envn",
  "st_ennl",
  "st_exit",
  "st_exexp",
  "st_exvn",
  "st_exnl",
  "st_orig",
  "st_orexp",
  "st_orvn",
  "st_ornl",
  "st_bs",
  "st_ifexp",
  "st_if",
  "st_ever",
  "st_never",
  "st_after",
  "st_befor",
  "st_wt",
  "st_wv",
  "st_w",
  "st_show",
  "st_o",
  "st_s",
  "st_t",
  "st_t0",
  "st_d",
  "st_n0",
  "st_fev",
  "st_fente",
  "st_fexit",
  "st_forig",
  "st_fif",
  "st_fever",
  "st_fafte",
  "st_fbefo",
  "st_full",
];

/** The st settings of the data, or Stata's error when there are none. */
export function stSettings(session) {
  const chars = session.data.chars?.get("_dta");
  if (chars?.get("_dta") !== "st") throw new StataError("data not st", 119);
  const get = (name) => chars.get(name) ?? "";
  return {
    bt: get("st_bt"),
    bd: get("st_bd"),
    ev: get("st_ev"),
    id: get("st_id"),
    enter: get("st_enter"),
    enexp: get("st_enexp"),
    exit: get("st_exit"),
    exexp: get("st_exexp"),
    orig: get("st_orig"),
    orexp: get("st_orexp"),
    bs: get("st_bs") || "1",
    ifexp: get("st_ifexp"),
    show: get("st_show"),
  };
}

/**
 * The lines every st command shows first, as st_show.ado shows them: a
 * blank line, then the failure, the analysis time and the other settings,
 * each label set right to a common edge.
 */
function stHeader(ctx, s, noshow = false) {
  if (noshow || s.show) return;
  ctx.out("");
  const width = s.enter || s.exit ? 19 : 18,
    line = (label, text) => ctx.out(`${label.padStart(width)}: ${text}`);
  line(
    "Failure _d",
    s.bd ? (s.ev ? `${s.bd}==${s.ev}` : s.bd) : "1 (meaning all fail)",
  );
  line(
    "Analysis time _t",
    `${s.orig ? `(${s.bt}-origin)` : s.bt}${s.bs !== "1" ? `/${s.bs}` : ""}`,
  );
  if (s.orig) line("Origin", s.orig);
  if (s.enter) line("Enter on or after", s.enter);
  if (s.exit) line("Exit on or before", s.exit);
  if (s.id) line("ID variable", s.id);
}

/** Whether a command's options include noshow. */
const noShow = (text) =>
  /(^|[\s,])nosh(o(w)?)?\b/.test(splitAtComma(text)[1] ?? "");

/**
 * The records an st command analyses: those with _st set that pass its if
 * and in, and have every one of the variables given (by-variables, say).
 */
function stRows(session, parsed, variables = []) {
  const st = session.data.get("_st").data;
  return session
    .rows(parsed, null)
    .filter((i) => st[i] === 1 && variables.every((v) => !missingIn(v, i)));
}

/** The analysis columns, read once. */
function stColumns(session) {
  const data = session.data;
  return {
    t: data.get("_t").data,
    t0: data.get("_t0").data,
    d: data.get("_d").data,
  };
}

// ----- stset -----
const STSET =
  "varlist(numeric max=2) [if] [fweight pweight iweight] [, Failure(string) ID(varname) Origin(string) ENter(string) ENTRy(string) EXit(string) SCale(real 1) noSHow | TIME0(string) IFopt(string) EVER(string) NEVER(string) AFTER(string) BEFORe(string) MI noHEADer]";

function oneVariable(session, word) {
  const names = session.varlist(word);
  if (names.length !== 1)
    throw new StataError("too many variables specified", 103);
  return names[0];
}

/** failure(varname[==numlist]) as st_set.ado's Failure reads it. */
function readFailure(session, text) {
  const source = text.trim();
  if (!source) return { bd: "", ev: "" };
  const m = /^([^\s=]+)\s*(?:(==?)\s*([\s\S]*))?$/.exec(source);
  if (!m) throw invalid("option failure(): syntax error");
  const bd = oneVariable(session, m[1]),
    // A string failure variable is a type mismatch, as st_set.ado's
    // comparison of it with numbers finds; its numlist is read first.
    numeric = () => {
      if (isStringType(session.data.get(bd).type))
        throw new StataError("type mismatch", 109);
    };
  if (!m[2]) {
    numeric();
    return { bd, ev: "" };
  }
  const list = m[3]
    .trim()
    .split(/\s+/)
    .flatMap((token) => {
      if (token === "." || /^\.[a-z]$/.test(token)) return [MISSING];
      if (token.startsWith('"'))
        throw new StataError("invalid numlist has too few elements", 122);
      return parseNumlist(token);
    });
  if (!list.length) throw invalid("option failure(): syntax error");
  numeric();
  return {
    bd,
    ev: list.map((v) => (isMissing(v) ? "." : formatNumber(v))).join(" "),
    events: list,
  };
}

/**
 * origin(), enter() and exit() as times: time exp, or a variable alone.
 * The event forms, varname==numlist, are refused here.
 */
function readTime(session, option, raw) {
  const text = (raw ?? "").trim();
  if (!text) return "";
  if (/^[^\s=]+\s*=/.test(text))
    throw notHere(
      `${option}(varname==numlist)`,
      `Give ${option}() as a time: ${option}(time exp).`,
    );
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text),
    word = m[1],
    rest = (m[2] ?? "").trim();
  if (!rest) return oneVariable(session, word);
  if (!"time".startsWith(word)) throw invalid(`option ${option}() invalid`);
  try {
    const names = session.varlist(rest);
    if (names.length === 1) return names[0];
  } catch {
    // An expression, not a variable.
  }
  return rest;
}

function stsetCommand(session, text, ctx) {
  const [head, tail] = splitAtComma(text);
  if (!head.trim()) return stsetReplay(session, (tail ?? "").trim(), ctx);
  const parsed = session.parse(STSET, text),
    o = parsed.options;
  if (parsed.weight)
    throw notHere(
      "stset with weights",
      "Set the data without the weight; expand the data by an fweight first if each record stands for several.",
    );
  let failure = o.failure ?? "";
  if (parsed.varlist.length === 2) {
    if (failure)
      throw invalid(
        "may not mix old and new syntax\nmay not specify two variables and failure()",
      );
    failure = parsed.varlist[1];
  }
  if (o.enter !== undefined && o.entry !== undefined)
    throw invalid("invalid syntax");
  const id = o.id ?? "";
  if (id && !failure.trim())
    throw invalid(
      "you must specify option failure() in combination with option id()",
    );
  const edit = (value) => (value === "." ? "" : (value ?? "").trim()),
    exitText = edit(o.exit),
    originText = edit(o.origin),
    ifexp =
      parsed.if && !/^\s*(\.|1)\s*$/.test(parsed.if) ? parsed.if.trim() : "",
    { bd, ev, events } = readFailure(session, failure);
  const spec = {
    bt: parsed.varlist[0],
    bd,
    ev,
    events,
    id,
    enexp: readTime(session, "enter", edit(o.enter ?? o.entry)),
    exexp: exitText === "failure" ? "" : readTime(session, "exit", exitText),
    origin: originText === "min" ? "min" : "",
    orexp: originText === "min" ? "" : readTime(session, "origin", originText),
    bs: o.scale,
    ifexp,
    show: o.show === false ? "noshow" : "",
  };
  if (!(spec.bs > 0) || isMissing(spec.bs))
    throw invalid("option scale() must be positive");
  settle(session, spec, ctx);
}

function stsetReplay(session, options, ctx) {
  if (/^clear$/.test(options)) {
    clearSettings(session);
    return;
  }
  const s = stSettings(session);
  if (/^nosh(o(w)?)?$/.test(options))
    return void defineCharacteristic(session.data, "_dta", "st_show", "noshow");
  if (/^sh(o(w)?)?$/.test(options))
    return void defineCharacteristic(session.data, "_dta", "st_show", "");
  if (options) throw invalid(`option ${options.split(/[\s(]/)[0]} not allowed`);
  // streset: stset again as it was set, after the command it stands for.
  let command = "";
  if (s.ifexp) command += ` if ${s.ifexp}`;
  command += ",";
  if (s.id) command += ` id(${s.id})`;
  if (s.bd) command += ` failure(${s.bd}${s.ev ? `==${s.ev}` : ""})`;
  if (s.enter) command += ` enter(${s.enter})`;
  if (s.exit) command += ` exit(${s.exit})`;
  if (s.orig) command += ` origin(${s.orig})`;
  if (s.bs !== "1") command += ` scale(${s.bs})`;
  if (s.show) command += ` ${s.show}`;
  ctx.out(`-> stset ${s.bt}${command}`);
  const events = s.ev
    ? s.ev.split(" ").map((v) => (v === "." ? MISSING : Number(v)))
    : undefined;
  settle(
    session,
    {
      bt: s.bt,
      bd: s.bd,
      ev: s.ev,
      events,
      id: s.id,
      enexp: s.enexp,
      exexp: s.exexp,
      origin: s.orig === "min" ? "min" : "",
      orexp: s.orexp,
      bs: Number(s.bs),
      ifexp: s.ifexp,
      show: s.show,
    },
    ctx,
  );
}

function clearSettings(session) {
  const data = session.data,
    chars = data.chars?.get("_dta");
  const drop = (name) => {
    if (data.has(name)) data.drop([name]);
  };
  if (chars) {
    if (chars.get("st_t") === "_t") drop("_t");
    if (chars.get("st_t0") === "_t0") drop("_t0");
    if (chars.get("st_d") === "_d") drop("_d");
    const o = chars.get("st_o");
    if (o && data.has(o) && o === "_origin") drop(o);
    for (const name of [...chars.keys()])
      if (CLEARED.includes(name) || /^st_n\d+$/.test(name))
        defineCharacteristic(data, "_dta", name, "");
  }
  drop("_st");
  drop("_insmpl");
  drop("_origin");
}

/** Groups of observations sharing an id, each in order of the base time. */
function idGroups(rows, idVar, bt) {
  const groups = new Map();
  for (const i of rows) {
    const key = isStringType(idVar.type) ? `s${idVar.data[i]}` : idVar.data[i];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  for (const list of groups.values())
    list.sort((a, b) => bt[a] - bt[b] || a - b);
  return [...groups.values()];
}

/**
 * st_set.ado's computation: which records are used, and their analysis
 * times, failure flags and entry times, with a count of the records set
 * aside for each reason. Then the variables and characteristics, and the
 * report.
 */
function settle(session, spec, ctx) {
  const data = session.data,
    n = data.n,
    bt = data.get(spec.bt).data,
    idVar = spec.id ? data.get(spec.id) : null,
    touse = new Uint8Array(n),
    compiled = (text) => {
      const c = session.compile(text);
      if (c.type !== "numeric") throw new StataError("type mismatch", 109);
      return evaluateAll(c, n);
    };
  // Step 1: if exp, and observations with no id or no time.
  const keep = spec.ifexp ? compiled(spec.ifexp) : null;
  for (let i = 0; i < n; i++) touse[i] = !keep || keep[i] !== 0 ? 1 : 0;
  const counts = {
    ifexp: 0,
    id: 0,
    bt: 0,
    order: 0,
    never: 0,
    prior: 0,
    after: 0,
    t0t: 0,
  };
  for (let i = 0; i < n; i++) if (!touse[i]) counts.ifexp++;
  if (idVar)
    for (let i = 0; i < n; i++)
      if (touse[i] && missingIn(idVar, i)) {
        counts.id++;
        touse[i] = 0;
      }
  for (let i = 0; i < n; i++)
    if (touse[i] && isMissing(bt[i])) {
      counts.bt++;
      touse[i] = 0;
    }
  // Step 2: the failure indicator.
  const d = new Float64Array(n).fill(MISSING),
    bd = spec.bd ? data.get(spec.bd).data : null;
  for (let i = 0; i < n; i++) {
    if (!touse[i]) continue;
    if (spec.events) d[i] = spec.events.includes(bd[i]) ? 1 : 0;
    else if (bd) d[i] = bd[i] !== 0 && !isMissing(bd[i]) ? 1 : 0;
    else d[i] = 1;
  }
  const using = () => [...touse.keys()].filter((i) => touse[i]);
  // The smallest value of an expression over each id's records, or each
  // record's own value without an id.
  const smallest = (text) => {
    const values = compiled(text),
      out = new Float64Array(n).fill(MISSING);
    for (let i = 0; i < n; i++) if (touse[i]) out[i] = values[i];
    if (idVar)
      for (const group of idGroups(using(), idVar, bt)) {
        const low = Math.min(...group.map((i) => out[i]));
        for (const i of group) out[i] = low;
      }
    return out;
  };
  const scaled = (value, zero) =>
    isMissing(value) || isMissing(zero) ? MISSING : (value - zero) / spec.bs;
  // Step 3: the origin.
  let zero = null;
  if (spec.origin === "min") {
    const low = Math.min(...using().map((i) => bt[i]));
    zero = new Float64Array(n).fill(MISSING);
    for (let i = 0; i < n; i++) if (touse[i]) zero[i] = low - 1;
  } else if (spec.orexp) zero = smallest(spec.orexp);
  const zeroAt = (i) => (zero ? zero[i] : 0);
  // Step 4: the analysis time.
  const t = new Float64Array(n).fill(MISSING);
  for (let i = 0; i < n; i++) if (touse[i]) t[i] = scaled(bt[i], zeroAt(i));
  const firstType = compressedType([...t]);
  // Step 5: the entry time, the previous record's time within an id.
  const t0 = new Float64Array(n).fill(MISSING),
    touse2 = Uint8Array.from(touse);
  if (idVar) {
    for (const group of idGroups(using(), idVar, bt)) {
      const bad = group.map(
        (i, k) =>
          (k > 0 && bt[group[k - 1]] === bt[i]) ||
          (k + 1 < group.length && bt[group[k + 1]] === bt[i]),
      );
      group.forEach((i, k) => {
        t0[i] =
          k === 0
            ? group.length > 1 && t[group[1]] <= 0
              ? 2 * t[i]
              : 0
            : t[group[k - 1]];
      });
      group.forEach((i, k) => {
        if (bad[k]) {
          counts.order++;
          touse2[i] = 0;
          t0[i] = MISSING;
        }
      });
    }
  } else for (let i = 0; i < n; i++) if (touse[i]) t0[i] = 0;
  // Step 6: the first time of entry.
  let tEnter = null;
  if (spec.enexp) {
    const values = smallest(spec.enexp);
    tEnter = new Float64Array(n);
    for (let i = 0; i < n; i++) tEnter[i] = scaled(values[i], zeroAt(i));
  }
  const enterAt = (i) => (tEnter ? tEnter[i] : 0);
  // Step 7: the last time of exit, the first failure within an id.
  let tExit = null;
  if (spec.exexp) {
    const values = smallest(spec.exexp);
    tExit = new Float64Array(n);
    for (let i = 0; i < n; i++) tExit[i] = scaled(values[i], zeroAt(i));
  } else if (idVar) {
    tExit = new Float64Array(n).fill(MISSING);
    for (const group of idGroups(using(), idVar, bt)) {
      const first = group.find((i) => d[i] === 1),
        at = first === undefined ? MISSING : bt[first];
      for (const i of group) tExit[i] = scaled(at, zeroAt(i));
    }
  }
  const exitAt = (i) => (tExit ? tExit[i] : MISSING);
  for (let i = 0; i < n; i++) if (!touse2[i]) touse[i] = 0;
  // Steps 9 and 10: entry and exit.
  for (let i = 0; i < n; i++)
    if (touse[i] && (isMissing(enterAt(i)) || isMissing(zeroAt(i)))) {
      counts.never++;
      touse[i] = 0;
    }
  for (let i = 0; i < n; i++)
    if (touse[i] && t[i] <= enterAt(i) && !isMissing(enterAt(i))) {
      counts.prior++;
      touse[i] = 0;
    }
  for (let i = 0; i < n; i++)
    if (touse[i] && t0[i] <= enterAt(i) && t[i] > enterAt(i))
      t0[i] = enterAt(i);
  for (let i = 0; i < n; i++)
    if (touse[i] && t0[i] >= exitAt(i)) {
      counts.after++;
      touse[i] = 0;
    }
  for (let i = 0; i < n; i++)
    if (t0[i] < exitAt(i) && t[i] > exitAt(i)) {
      d[i] = 0;
      t[i] = exitAt(i);
    }
  for (let i = 0; i < n; i++) if (touse[i] && t0[i] < 0) t0[i] = 0;
  for (let i = 0; i < n; i++)
    if (touse[i] && t0[i] >= t[i]) {
      counts.t0t++;
      touse[i] = 0;
    }
  for (let i = 0; i < n; i++)
    if (!touse[i]) {
      t[i] = MISSING;
      t0[i] = MISSING;
      d[i] = MISSING;
    }
  // The variables, which replace any an earlier stset made.
  clearSettings(session);
  const add = (name, values, type, format, label) => {
    data.generate(name, Array.from(values), { type });
    const variable = data.get(name);
    variable.format = format;
    variable.label = label;
  };
  add("_st", touse, "byte", "%8.0g", "1 if record is to be used; 0 otherwise");
  add("_d", d, "byte", "%8.0g", "1 if failure; 0 if censored");
  let origin = "0";
  if (zero) {
    const used = [...touse.keys()].filter((i) => touse[i]).map((i) => zero[i]),
      low = used.length ? Math.min(...used) : MISSING,
      high = used.length ? Math.max(...used) : MISSING;
    if (!(low === high && !isMissing(low))) {
      add(
        "_origin",
        zero,
        compressedType([...zero]),
        "%10.0g",
        "Evaluated value of origin()",
      );
      origin = "_origin";
    } else origin = formatNumber(low);
  }
  add(
    "_t",
    t,
    promote(firstType, [...t]),
    "%10.0g",
    "Analysis time when record ends",
  );
  add(
    "_t0",
    t0,
    compressedType([...t0]),
    "%10.0g",
    "Analysis time when record begins",
  );
  // The characteristics, in the order st_set.ado defines them.
  const set = (name, text) => defineCharacteristic(data, "_dta", name, text);
  set("st_t", "_t");
  set("st_t0", "_t0");
  set("st_d", "_d");
  set("st_ifexp", spec.ifexp);
  if (spec.exexp) {
    set("st_exexp", spec.exexp);
    set("st_exit", `time ${spec.exexp}`);
  }
  if (spec.enexp) {
    set("st_enexp", spec.enexp);
    set("st_enter", `time ${spec.enexp}`);
  }
  set("st_bs", formatNumber(spec.bs));
  set("st_s", formatNumber(spec.bs));
  if (spec.origin === "min") set("st_orig", "min");
  else if (spec.orexp) {
    set("st_orexp", spec.orexp);
    set("st_orig", `time ${spec.orexp}`);
  }
  set("st_o", origin);
  set("st_ev", spec.ev);
  set("st_bd", spec.bd);
  set("st_bt", spec.bt);
  set("st_id", spec.id);
  set("st_show", spec.show);
  set("st_ver", "2");
  set("_dta", "st");
  // stset sorts as it works, and puts the records back in their order.
  report(session, stSettings(session), counts, spec, ctx);
}

/** The settings as st.ado shows them, then the summary st_set.ado shows. */
function report(session, s, counts, spec, ctx) {
  ctx.out("");
  ctx.out("Survival-time data settings");
  ctx.out("");
  const line = (label, text) => ctx.out(`${label.padStart(22)}: ${text}`);
  if (s.id) line("ID variable", s.id);
  line(
    "Failure event",
    s.bd
      ? s.ev
        ? `${s.bd}==${s.ev}`
        : `${s.bd}!=0 & ${s.bd}<.`
      : `(assumed to fail at time=${s.bt})`,
  );
  line(
    "Observed time interval",
    `(${s.id ? `${s.bt}[_n-1]` : s.orig ? "origin" : "0"}, ${s.bt}]`,
  );
  if (s.enter) line("Enter on or after", s.enter);
  line("Exit on or before", s.exit || "failure");
  if (s.orig || s.bs !== "1") {
    line(
      "Time for analysis",
      `${s.orig ? "(time-origin)" : "time"}${s.bs !== "1" ? `/${s.bs}` : ""}`,
    );
    if (s.orig) line("Origin", s.orig);
  }
  if (s.ifexp) {
    ctx.out(`${"Keep observations".padStart(23)}`);
    line("if exp", s.ifexp);
  }
  ctx.out("");
  ctx.out("-".repeat(74));
  const data = session.data,
    n = data.n,
    amount = (v) => fmt(Math.round(v / 0.001) * 0.001, "%11.0gc"),
    di = (v, text) => ctx.out(`${amount(v)}  ${text}`),
    probable = (v, text) =>
      ctx.out(`${`${amount(v)}  ${text}`.padEnd(60)}PROBABLE ERROR`);
  di(n, `total observation${n === 1 ? "" : "s"}`);
  const st = data.get("_st").data,
    used = [];
  for (let i = 0; i < n; i++) if (st[i]) used.push(i);
  if (used.length < n) {
    if (counts.ifexp) di(counts.ifexp, "ignored at outset because of if exp");
    if (counts.id) di(counts.id, `ignored because ${s.id} missing`);
    if (counts.bt) probable(counts.bt, `event time missing (${s.bt}>=.)`);
    if (counts.order) {
      probable(counts.order, "multiple records at same instant ");
      ctx.out(`${" ".repeat(13)}(${s.bt}[_n-1]==${s.bt})`);
    }
    if (counts.never) di(counts.never, "ignored because never entered");
    if (counts.prior)
      di(
        counts.prior,
        counts.prior === 1
          ? "observation ends on or before enter()"
          : "observations end on or before enter()",
      );
    if (counts.t0t)
      di(
        counts.t0t,
        counts.t0t === 1
          ? "observation ends on or before origin()"
          : "observations end on or before origin()",
      );
    if (counts.after) {
      const what = spec.exexp ? "exit" : "(first) failure";
      di(
        counts.after,
        counts.after === 1
          ? `observation begins on or after ${what}`
          : `observations begin on or after ${what}`,
      );
    }
  } else di(0, "exclusions");
  ctx.out("-".repeat(74));
  const left = used.length;
  di(left, `observation${left === 1 ? "" : "s"} remaining, representing`);
  const { t, t0, d } = stColumns(session);
  let message = "in single-record/single-failure data",
    atRisk = 0;
  if (s.id) {
    const idVar = data.get(s.id),
      groups = idGroups(used, idVar, t);
    di(groups.length, `subject${groups.length === 1 ? "" : "s"}`);
    const multiple = groups.some(
      (g) => g.reduce((sum, i) => sum + d[i], 0) > 1,
    );
    message = multiple
      ? "in multiple-failure-per-subject data"
      : "in single-failure-per-subject data";
    if (!multiple)
      atRisk = groups.filter((g) => g.slice(0, -1).some((i) => d[i])).length;
  }
  const failures = used.reduce((sum, i) => sum + d[i], 0);
  di(failures, `failure${failures === 1 ? "" : "s"} ${message}`);
  if (atRisk)
    di(
      atRisk,
      `${atRisk === 1 ? "subject remains" : "subjects remain"} at risk after failure`,
    );
  const total = used.reduce((sum, i) => sum + (t[i] - t0[i]), 0);
  di(total, "total analysis time at risk and under observation");
  ctx.out(`${" ".repeat(48)}At risk from t = ${fmt(0, "%9.0gc")}`);
  const low = used.length ? Math.min(...used.map((i) => t0[i])) : MISSING,
    high = used.length ? Math.max(...used.map((i) => t[i])) : MISSING;
  ctx.out(`${" ".repeat(37)}Earliest observed entry t = ${fmt(low, "%9.0gc")}`);
  ctx.out(`${" ".repeat(42)}Last observed exit t = ${fmt(high, "%9.0gc")}`);
  // summarize _t if _st, meanonly.
  const sum = used.reduce((a, i) => a + t[i], 0);
  session.results.r = used.length
    ? {
        N: used.length,
        sum_w: used.length,
        sum,
        mean: sum / used.length,
        min: Math.min(...used.map((i) => t[i])),
        max: high,
      }
    : { N: 0, sum_w: 0, sum: 0 };
}

// ----- stdescribe -----
function stdescribe(session, text, ctx) {
  const s = stSettings(session),
    parsed = session.parse("[if] [in] [, noSHow | Weight]", text),
    rows = stRows(session, parsed),
    { t, t0, d } = stColumns(session);
  stHeader(ctx, s, parsed.options.show === false);
  ctx.out("");
  ctx.out(`${" ".repeat(35)}|${"-".repeat(14)} Per subject ${"-".repeat(14)}|`);
  ctx.out(
    `${column(column(column(column(column("Category", 28) + "Total", 41) + "Mean", 54) + "Min", 62) + "Median", 76)}Max`,
  );
  ctx.out("-".repeat(78));
  const subjects = s.id
      ? idGroups(rows, session.data.get(s.id), t)
      : rows.map((i) => [i]),
    stats = (values) => {
      const sorted = values.filter(known).sort((a, b) => a - b);
      if (!sorted.length)
        return {
          sum: 0,
          mean: MISSING,
          min: MISSING,
          med: MISSING,
          max: MISSING,
        };
      const sum = sorted.reduce((a, b) => a + b, 0);
      return {
        sum,
        mean: sum / sorted.length,
        min: sorted[0],
        med: percentile(sorted, 50),
        max: sorted.at(-1),
      };
    },
    show = (label, total, st) => {
      let line = column(label, 23);
      line +=
        total === undefined ? " ".repeat(13) : `${fmt(total, "%10.0g")}   `;
      if (st)
        line += `${fmt(st.mean, "%9.0g")}   ${fmt(st.min, "%9.0g")}  ${fmt(st.med, "%9.0g")}  ${fmt(st.max, "%9.0g")}`;
      ctx.out(line);
    };
  const records = stats(subjects.map((g) => g.length)),
    first = stats(subjects.map((g) => t0[g[0]])),
    last = stats(subjects.map((g) => t[g.at(-1)])),
    risk = stats(subjects.map((g) => g.reduce((a, i) => a + t[i] - t0[i], 0))),
    fails = stats(subjects.map((g) => g.reduce((a, i) => a + (d[i] !== 0), 0)));
  show("Number of subjects", subjects.length);
  show("Number of records", rows.length, records);
  ctx.out("");
  show("Entry time (first)", undefined, first);
  show("Exit time (final)", undefined, last);
  ctx.out("");
  let gap = { sum: 0, mean: MISSING, min: MISSING, med: MISSING, max: MISSING },
    withGap = 0;
  if (s.id) {
    const gaps = [];
    for (const g of subjects) {
      let any = false;
      g.forEach((i, k) => {
        if (k === 0) return;
        const z = t0[i] - t[g[k - 1]];
        if (z > 0) any = true;
        if (z !== 0) gaps.push(z);
      });
      if (any) withGap++;
    }
    gap = stats(gaps);
    show("Subjects with gap", withGap);
    show("Time on gap", gap.sum, gap);
  } else {
    show("Subjects with gap", 0);
    show("Time on gap", 0);
  }
  show("Time at risk", risk.sum, risk);
  ctx.out("");
  show("Failures", fails.sum, fails);
  ctx.out("-".repeat(78));
  // Stata lists these newest first.
  session.results.r = {
    f_max: fails.max,
    f_med: fails.med,
    f_min: fails.min,
    f_mean: fails.mean,
    N_fail: fails.sum,
    tr_max: risk.max,
    tr_med: risk.med,
    tr_min: risk.min,
    tr_mean: risk.mean,
    tr: risk.sum,
    gap_max: gap.max,
    gap_med: gap.med,
    gap_min: gap.min,
    gap_mean: gap.mean,
    gap: gap.sum,
    N_gap: withGap,
    t1_max: last.max,
    t1_med: last.med,
    t1_min: last.min,
    t1_mean: last.mean,
    t0_max: first.max,
    t0_med: first.med,
    t0_min: first.min,
    t0_mean: first.mean,
    N_max: records.max,
    N_med: records.med,
    N_min: records.min,
    N_mean: records.mean,
    N_total: rows.length,
    N_sub: subjects.length,
  };
}

// ----- grouping by variables -----
/** A by-variable's value as st commands label it: its value label or the number. */
function valueText(session, variable, i, max = 255) {
  if (isStringType(variable.type)) return variable.data[i].trim().slice(0, max);
  const value = variable.data[i],
    labels = variable.valueLabel
      ? session.data.valueLabels.get(variable.valueLabel)
      : null;
  if (labels?.has(value)) return labels.get(value).slice(0, max);
  return formatNumber(value);
}
/** The records in groups of equal by-values, in sorted order. */
function byGroups(variables, rows) {
  if (!variables.length) return [{ rows, first: rows[0] }];
  const compare = (a, b) => {
    for (const v of variables) {
      const x = v.data[a],
        y = v.data[b];
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  };
  const sorted = [...rows].sort((a, b) => compare(a, b) || a - b),
    groups = [];
  for (const i of sorted) {
    const last = groups.at(-1);
    if (last && compare(last.first, i) === 0) last.rows.push(i);
    else groups.push({ first: i, rows: [i] });
  }
  return groups;
}
function byVariables(session, text) {
  if (Array.isArray(text)) return text.map((name) => session.data.get(name));
  if (!text?.trim()) return [];
  return session.varlist(text).map((name) => session.data.get(name));
}

// ----- Kaplan–Meier -----
/**
 * st_ct.ado's table for one group of records: a row for each time at
 * which a record enters or leaves, with the number at risk just before it
 * (n), the failures (d), the censored (cens) and those entering (ent).
 */
function countTable(rows, { t, t0, d }) {
  const events = [];
  for (const i of rows) {
    events.push([t0[i], 3]);
    events.push([t[i], d[i] ? 1 : 2]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const table = [];
  let running = 0;
  for (let k = 0; k < events.length;) {
    const time = events[k][0],
      entry = { t: time, n: running, d: 0, cens: 0, ent: 0 };
    for (; k < events.length && events[k][0] === time; k++) {
      const op = events[k][1];
      if (op === 1) entry.d++;
      else if (op === 2) entry.cens++;
      else entry.ent++;
    }
    running += entry.ent - entry.d - entry.cens;
    table.push(entry);
  }
  return table;
}
/** sts.ado's AddSurv: the survivor function, its standard error and interval. */
function survivor(table, level) {
  const z = invnormal(1 - (1 - level / 100) / 2);
  let s = 1,
    greenwood = 0,
    logs = 0;
  for (const r of table) {
    const h = r.n === 0 ? 0 : r.d / r.n;
    s *= 1 - h;
    if (r.n > 0 && r.n > r.d) {
      greenwood += r.d / (r.n * (r.n - r.d));
      logs += Math.log((r.n - r.d) / r.n);
    }
    r.s = s;
    r.se = s !== 0 && s !== 1 ? s * Math.sqrt(greenwood) : MISSING;
    const spread = Math.sqrt(greenwood / (logs * logs));
    r.lb = s !== 0 && known(spread) ? s ** Math.exp(z * spread) : MISSING;
    r.ub = s !== 0 && known(spread) ? s ** Math.exp(-z * spread) : MISSING;
  }
  return table;
}

// ----- stsum -----
function stsum(session, text, ctx) {
  const s = stSettings(session),
    parsed = session.parse("[if] [in] [, BY(varlist) noSHow]", text),
    by = byVariables(session, parsed.options.by),
    rows = stRows(session, parsed, by),
    columns = stColumns(session);
  if (!rows.length) throw new StataError("no observations", 2000);
  stHeader(ctx, s, parsed.options.show === false);
  ctx.out("");
  // The heading: the by-variables' names, the last two beside the columns.
  const names = by.map((v) => abbrev(v.name, 8));
  for (const name of names.slice(0, -2)) ctx.out(`${name.padStart(8)} |`);
  const ttl1 = names.length >= 2 ? names.at(-2) : "",
    ttl2 = names.length ? names.at(-1) : "";
  ctx.out(
    `${column(column(column(column(ttl1.padStart(8), 10) + "|", 26) + "Incidence", 40) + "Number of", 52)}|------ Survival time -----|`,
  );
  ctx.out(
    `${column(column(column(column(column(column(ttl2.padStart(8), 10) + "| Time at risk", 31) + "rate", 41) + "subjects", 57) + "25%", 67) + "50%", 77)}75%`,
  );
  ctx.out(`${"-".repeat(9)}+${"-".repeat(69)}`);
  const id = s.id ? session.data.get(s.id) : null,
    statistics = (group) => {
      const risk = group.reduce((a, i) => a + columns.t[i] - columns.t0[i], 0),
        fail = group.reduce((a, i) => a + columns.d[i], 0),
        subjects = id
          ? new Set(group.map((i) => id.data[i])).size
          : group.length,
        table = survivor(countTable(group, columns), 95),
        point = (p) => {
          const exits = new Set(group.map((i) => columns.t[i]));
          for (const r of table)
            if (exits.has(r.t) && Math.fround(r.s) <= Math.fround(p))
              return r.t;
          return MISSING;
        };
      return {
        risk,
        ir: fail / risk,
        subjects,
        p25: point(0.75),
        p50: point(0.5),
        p75: point(0.25),
      };
    },
    shown = (label, st) => {
      const lines =
        label.length > 1 && label.join(" ").length + 2 * label.length > 10
          ? label
          : [label.join(" ")];
      for (const extra of lines.slice(0, -1)) ctx.out(`${extra.padStart(8)} |`);
      ctx.out(
        `${column(`${lines.at(-1).padStart(8)} | ${fmt(st.risk, "%12.0gc")}  ${fmt(st.ir, "%9.0g")}`, 40)}${fmt(st.subjects, "%9.0g")}  ${fmt(st.p25, "%9.0g")} ${fmt(st.p50, "%9.0g")} ${fmt(st.p75, "%9.0g")}`,
      );
    };
  if (by.length) {
    for (const group of byGroups(by, rows))
      shown(
        by.map((v) => valueText(session, v, group.first, 8)),
        statistics(group.rows),
      );
    ctx.out(`${"-".repeat(9)}+${"-".repeat(69)}`);
  }
  const total = statistics(rows);
  shown(["Total"], total);
  session.results.r = {
    p75: total.p75,
    p50: total.p50,
    p25: total.p25,
    N_sub: total.subjects,
    ir: total.ir,
    risk: total.risk,
  };
}

// ----- sts -----
function sts(session, text, ctx) {
  const m = /^\s*([A-Za-z]+)\b([\s\S]*)$/.exec(text),
    word = m?.[1] ?? "";
  if (!m || word === "if" || word === "in") return stsGraph(session, text, ctx);
  const rest = m[2];
  if ("list".startsWith(word)) return stsList(session, rest, ctx);
  if ("graph".startsWith(word)) return stsGraph(session, rest, ctx);
  if ("test".startsWith(word)) return stsTest(session, rest, ctx);
  if ("generate".startsWith(word))
    throw notHere(
      "sts generate",
      "sts list shows the survivor function and its interval at each time.",
    );
  throw invalid(`unknown sts subcommand ${word}`);
}

/** The groups of a by() for sts list and sts graph, with their tables. */
function survivorGroups(session, parsed, by, level) {
  const s = stSettings(session),
    rows = stRows(session, parsed, by),
    columns = stColumns(session);
  return {
    s,
    groups: byGroups(by, rows).map((group) => ({
      ...group,
      table: survivor(countTable(group.rows, columns), level),
    })),
  };
}

function stsList(session, text, ctx) {
  const parsed = session.parse(
      "[if] [in] [, SURvival Failure BY(varlist) Enter Level(cilevel) noSHow | CUMHaz NA ADjustfor(string) AT(string) STrata(varlist) Compare SAVing(string) tmin(string) tmax(string) RISKtable(string)]",
      text,
    ),
    o = parsed.options;
  if (o.survival && o.failure)
    throw invalid("options survival and failure may not be combined");
  const by = byVariables(session, o.by),
    { s, groups } = survivorGroups(session, parsed, by, o.level);
  if (!groups[0]?.rows.length) throw new StataError("no observations", 2000);
  stHeader(ctx, s, o.show === false);
  ctx.out("");
  ctx.out(`Kaplan–Meier ${o.failure ? "failure" : "survivor"} function`);
  if (by.length === 1) ctx.out(`By variable: ${by[0].name}`);
  else if (by.length > 1)
    ctx.out(`By variables: ${by.map((v) => v.name).join(" ")}`);
  const enter = !!o.enter;
  // Without enter, entries are netted from the censored, and times with
  // neither a failure nor a net loss are dropped.
  const listed = groups.map((g) => ({
    ...g,
    rows: g.table
      .map((r) => (enter ? { ...r } : { ...r, cens: r.cens - r.ent, ent: 0 }))
      .filter((r) => enter || r.d !== 0 || r.cens !== 0),
  }));
  const all = listed.flatMap((g) => g.rows),
    delay =
      all.slice(1).some((r) => r.cens < 0) || (all.length && all[0].t !== 0),
    net = !enter && (!!s.id || delay);
  const level = formatNumber(o.level),
    spaces = level.length === 2 ? "     " : level.length === 4 ? "   " : "  ",
    title = o.failure ? " Failure" : "Survivor",
    [skip, std, rule] = enter ? [41, 55, 79] : [34, 48, 72];
  ctx.out("");
  ctx.out(
    `${column(column(column(column("", 14) + "At", 27) + (net ? "Net" : ""), skip) + title, std)}Std.`,
  );
  ctx.out(
    `${column(`  Time     risk   Fail   ${net ? "lost" : "Lost"}  ${enter ? "Enter" : ""}`, skip)}function     error${spaces}[${level}% conf. int.]`,
  );
  ctx.out("-".repeat(rule));
  for (const g of listed) {
    if (by.length)
      ctx.out(
        `${by
          .map((v) => {
            const text = valueText(session, v, g.first, 20);
            return isStringType(v.type) ||
              !(
                v.valueLabel &&
                session.data.valueLabels.get(v.valueLabel)?.has(v.data[g.first])
              )
              ? `${isStringType(v.type) ? "" : `${v.name}=`}${text} `
              : `${text} `;
          })
          .join("")}`,
      );
    for (const r of g.rows) {
      if (r.t === 0 && !enter) continue;
      let [value, lower, upper] = [r.s, r.lb, r.ub];
      if (o.failure) {
        value = 1 - value;
        [lower, upper] = [
          known(upper) ? 1 - upper : MISSING,
          known(lower) ? 1 - lower : MISSING,
        ];
      }
      ctx.out(
        `${fmt(r.t, "%6.0g")} ${fmt(r.n, "%8.0g")} ${fmt(r.d, "%6.0g")} ${fmt(r.cens, "%6.0g")}${enter ? ` ${fmt(r.ent, "%6.0g")}` : ""} ${fmt(value, "%11.4f")} ${fmt(r.se, "%9.4f")} ${fmt(lower, "%10.4f")} ${fmt(upper, "%9.4f")}`,
      );
    }
  }
  ctx.out("-".repeat(rule));
  if (net)
    ctx.out(
      "Note: Net lost equals the number lost minus the number who entered.",
    );
}

// ----- sts graph -----
function stsGraph(session, text, ctx) {
  const parsed = parseGraph(
      session,
      `[if] [in] [, SURvival Failure noSHow ${LOOKS} | CI CENsored(string) ATRisk LOST Enter noORIgin SEParate Hazard CUMHaz NA ADjustfor(string) STrata(varlist) RISKtable(string) TMIn(string) TMAx(string) YLOg PER(string) Level(string) PLOTOPTS(string) PLOT1opts(string) PLOT2opts(string)]`,
      text,
    ),
    o = parsed.options;
  if (o.survival && o.failure)
    throw invalid("options survival and failure may not be combined");
  const by = byVariables(session, o.by),
    { s, groups } = survivorGroups(session, parsed, by, 95);
  // sts graph shows the settings before it finds the sample empty.
  stHeader(ctx, s, o.show === false);
  if (!groups[0]?.rows.length) throw new StataError("no observations", 2000);
  const looks = looksOf({ ...o, by: undefined }),
    layers = groups.map((g) => {
      // A step function from time 0, as connect(J) draws it.
      const value = (r) => (o.failure ? 1 - r.s : r.s);
      let last = o.failure ? 0 : 1;
      const points = [[0, last]];
      for (const r of g.table) {
        if (r.t === 0) continue;
        points.push([r.t, last]);
        last = value(r);
        points.push([r.t, last]);
      }
      return {
        kind: "line",
        points,
        label: by.length
          ? by
              .map((v) => `${v.name} = ${valueText(session, v, g.first, 30)}`)
              .join(", ")
          : "",
        xFormat: "%9.0g",
        yFormat: "%9.2f",
      };
    });
  const kind = o.failure ? "failure" : "survival",
    title = `Kaplan–Meier ${kind} estimate${by.length ? "s" : ""}`;
  ctx.graph({
    svg: draw({
      ...looks,
      layers,
      title: looks.title ?? title,
      xTitle: o.xtitle ?? "Analysis time",
      yTitle: o.ytitle ?? "",
      yTicks: looks.yTicks ?? [0, 0.25, 0.5, 0.75, 1],
      legend:
        layers.length > 1 || looks.legend?.on || looks.legend?.order
          ? looks.legend
          : { off: true },
    }),
    // Where each curve ends, which is what a reader of the graph sees.
    description: `${title}${by.length ? ` by ${by.map((v) => v.name).join(" and ")}` : ""}: ${layers
      .map(
        (l) =>
          `${l.label ? `${l.label} ` : ""}${o.failure ? "rises" : "falls"} to ${trimmed(l.points.at(-1)[1], "%9.4f")} by time ${trimmed(l.points.at(-1)[0], "%9.0g")}`,
      )
      .join("; ")}.`,
  });
}

// ----- sts test -----
function stsTest(session, text, ctx) {
  const parsed = session.parse(
      "varlist [if] [in] [, Logrank Wilcoxon noSHow | Cox TWare Peto Fh(string) TRend STrata(varlist) Detail BY(string)]",
      text,
    ),
    o = parsed.options;
  if (o.logrank && o.wilcoxon)
    throw invalid(
      "only one of option logrank, wilcoxon, tware, peto, fh(), or cox is allowed",
    );
  const s = stSettings(session),
    by = parsed.varlist.map((name) => session.data.get(name)),
    rows = stRows(session, parsed, by),
    columns = stColumns(session);
  if (!rows.length) throw new StataError("no observations", 2000);
  stHeader(ctx, s, o.show === false);
  if (!rows.some((i) => columns.d[i]))
    throw new StataError(
      "no test possible because there are no failures",
      2000,
    );
  const groups = byGroups(by, rows),
    k = groups.length,
    which = new Map();
  // The test's variance has a row and column for each group, and is
  // summed at every failure time and inverted: a continuous variable
  // makes thousands of groups, more than a browser can compare in
  // reasonable time and memory.
  if (k > STS_TEST_GROUPS)
    throw new StataError(
      `${parsed.varlist.join(" ")} ${parsed.varlist.length > 1 ? "take" : "takes"} ${k.toLocaleString("en-US")} distinct values here; sts test compares at most ${STS_TEST_GROUPS.toLocaleString("en-US")} groups\nGroup a continuous variable first, for example with egen's cut().`,
      134,
    );
  groups.forEach((g, j) => g.rows.forEach((i) => which.set(i, j)));
  // The risk sets at each failure time, overall and by group.
  const events = [];
  for (const i of rows) {
    events.push([columns.t0[i], 3, which.get(i)]);
    events.push([columns.t[i], columns.d[i] ? 1 : 2, which.get(i)]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // Running sums, carried as Stata's sum() carries them.
  const atRisk = new Array(k).fill(0),
    expectedSums = Array.from({ length: k }, () => quadSum()),
    observed = new Array(k).fill(0),
    rankSums = Array.from({ length: k }, () => quadSum()),
    wilcoxon = !!o.wilcoxon,
    // With many groups the variance is summed piece by piece instead of
    // time by time: each element of V is Σ a_t n_i δij - Σ c_t n_i n_j,
    // and each group's number at risk changes only at its own records.
    many = k > STS_TEST_DIRECT,
    VSums = many ? null : quadMatrix(k),
    diagonal = many ? quadMatrix(k) : null,
    pieces = many ? Array.from({ length: k }, () => [[0, 0]]) : null,
    weights = [];
  for (let e = 0; e < events.length;) {
    const time = events[e][0],
      deaths = new Array(k).fill(0),
      ni = atRisk.slice(),
      changes = new Array(k).fill(0);
    for (; e < events.length && events[e][0] === time; e++) {
      const [, op, g] = events[e];
      if (op === 1) deaths[g]++;
      changes[g] += op === 3 ? 1 : -1;
    }
    changes.forEach((c, g) => (atRisk[g] += c));
    const dt = deaths.reduce((a, b) => a + b, 0),
      nt = ni.reduce((a, b) => a + b, 0);
    if (many)
      changes.forEach(
        (c, g) =>
          c && pieces[g].push([weights.length + (dt ? 1 : 0), atRisk[g]]),
      );
    if (!dt) continue;
    const factor = nt > 1 ? (dt * (nt - dt)) / (nt * nt * (nt - 1)) : 0,
      // The time's weights of n_i on the diagonal and of n_i n_j.
      a = wilcoxon
        ? nt > 1
          ? (nt * dt * (nt - dt)) / (nt - 1)
          : 0
        : nt * factor,
      c = wilcoxon ? (nt > 1 ? a / nt : 0) : factor,
      active = [];
    if (many) weights.push(c);
    for (let g = 0; g < k; g++) if (ni[g]) active.push(g);
    for (let i = 0; i < k; i++) {
      expectedSums[i].add((ni[i] * dt) / nt);
      observed[i] += deaths[i];
      if (wilcoxon) rankSums[i].add(nt * (deaths[i] - (ni[i] * dt) / nt));
      // A group with none at risk adds zeros to its row and column, which
      // leave the sums as they are.
      if (!ni[i]) continue;
      if (many) {
        diagonal.add(i, a * ni[i]);
        continue;
      }
      for (const j of active) {
        if (wilcoxon) {
          if (nt > 1)
            VSums.add(
              i * k + j,
              ((nt * nt * ni[i] * dt * (nt - dt)) / (nt * (nt - 1))) *
                ((i === j ? 1 : 0) - ni[j] / nt),
            );
        } else
          VSums.add(
            i * k + j,
            (i === j ? ni[i] * (nt - ni[i]) : -ni[i] * ni[j]) * factor,
          );
      }
    }
  }
  const expected = expectedSums.map((q) => q.value),
    ranks = rankSums.map((q) => q.value),
    V = many
      ? pairedVariance(k, pieces, weights, diagonal)
      : Array.from({ length: k }, (_, i) =>
          Array.from({ length: k }, (_, j) => VSums.value(i * k + j)),
        );
  const v = wilcoxon ? ranks : observed.map((x, i) => expected[i] - x),
    // With many groups the statistic is taken from the factor of V alone,
    // not its inverse, which would cost several times as much.
    chi2 = many
      ? inverseForm(V, v)
      : ((inverse) =>
          v.reduce(
            (t, x, i) =>
              t + x * v.reduce((u, y, j) => u + inverse[i][j] * y, 0),
            0,
          ))(generalizedInverse(V)),
    df = k - 1;
  // The table: one row for each group, labelled by its values.
  const title =
      by.length === 1
        ? abbrev(by[0].name, 12)
        : by.map((v) => abbrev(v.name, 8)).join(", "),
    labels = groups.map((g) =>
      by.map((v) => valueText(session, v, g.first, 30)).join(", "),
    ),
    width =
      Math.max(title.length, Math.max(1, ...labels.map((l) => l.length)), 5) +
      1,
    wide = wilcoxon ? 38 : 25;
  ctx.out("");
  ctx.out("Equality of survivor functions");
  ctx.out(wilcoxon ? "Wilcoxon–Breslow–Gehan test" : "Log-rank test");
  ctx.out("");
  ctx.out(
    `${" ".repeat(width - 1)} |  Observed       Expected${wilcoxon ? "       Sum of" : ""}`,
  );
  ctx.out(
    `${title.padEnd(width)}|    events         events${wilcoxon ? "        ranks" : ""}`,
  );
  ctx.out(`${"-".repeat(width)}+${"-".repeat(wide)}`);
  labels.forEach((label, i) =>
    ctx.out(
      `${label.padStart(width - 1)} |${fmt(observed[i], "%10.0g")}     ${fmt(expected[i], "%10.2f")}${wilcoxon ? `   ${fmt(ranks[i], "%10.0g")}` : ""}`,
    ),
  );
  ctx.out(`${"-".repeat(width)}+${"-".repeat(wide)}`);
  const sum = observed.reduce((a, b) => a + b, 0);
  ctx.out(
    `${"Total ".padStart(width)}|${fmt(sum, "%10.0g")}     ${fmt(sum, "%10.2f")}${wilcoxon ? `   ${fmt(0, "%10.0g")}` : ""}`,
  );
  const shownChi2 = trimmed(chi2, "%10.2f"),
    shownP = trimmed(chi2tail(df, chi2), "%10.4f"),
    most = Math.max(shownChi2.length, shownP.length),
    eq = width + wide - most,
    pad = eq - 8 - (df >= 10 ? 1 : 0);
  ctx.out("");
  ctx.out(
    `${column(column("", pad) + `chi2(${df})`, eq)}= ${shownChi2.padStart(most)}`,
  );
  ctx.out(
    `${column(column("", pad) + "Pr>chi2", eq)}= ${shownP.padStart(most)}`,
  );
  session.results.r = wilcoxon
    ? { chi2, df, by: parsed.varlist.join(" ") }
    : { chi2, df };
}

/** The most groups sts test compares. */
const STS_TEST_GROUPS = 1000;
/** Beyond this many groups sts test sums its variance piece by piece. */
const STS_TEST_DIRECT = 50;
/**
 * v' inv(V) v for v in the span of V, with the generalised inverse taken
 * as generalizedInverse takes it: the columns by their diagonal, largest
 * first, one whose pivot falls to 1e-9 of its diagonal left out. The
 * Cholesky factor of the rest gives the form by one forward solve.
 */
function inverseForm(V, v) {
  const n = V.length,
    order = [...Array(n).keys()].sort((i, j) => V[j][j] - V[i][i] || i - j),
    keep = [],
    factor = [];
  for (const j of order) {
    const row = new Float64Array(keep.length + 1);
    let pivot = V[j][j];
    for (let q = 0; q < keep.length; q++) {
      const L = factor[q];
      let x = V[j][keep[q]];
      for (let p = 0; p < q; p++) x -= row[p] * L[p];
      row[q] = x / L[q];
      pivot -= row[q] * row[q];
    }
    if (!(pivot > 1e-9 * Math.abs(V[j][j]))) continue;
    row[keep.length] = Math.sqrt(pivot);
    keep.push(j);
    factor.push(row);
  }
  let total = 0;
  const y = new Float64Array(keep.length);
  for (let q = 0; q < keep.length; q++) {
    const L = factor[q];
    let x = v[keep[q]];
    for (let p = 0; p < q; p++) x -= L[p] * y[p];
    y[q] = x / L[q];
    total += y[q] * y[q];
  }
  return total;
}
/**
 * The variance of sts test from each group's numbers at risk, held as
 * pieces [first failure index, number], and the weights c_t of the
 * failure times: V_ij = diagonal_i δij - Σ_t c_t n_i(t) n_j(t), the sum
 * taken over the stretches where both numbers hold, from cumulative
 * weights carried to twice double precision.
 */
function pairedVariance(k, pieces, weights, diagonal) {
  const T = weights.length,
    high = new Float64Array(T + 1),
    low = new Float64Array(T + 1);
  for (let l = 0; l < T; l++) {
    const s = high[l],
      x = weights[l],
      total = s + x;
    high[l + 1] = total;
    low[l + 1] =
      low[l] + (Math.abs(s) >= Math.abs(x) ? s - total + x : x - total + s);
  }
  const span = (from, to) => high[to] - high[from] + (low[to] - low[from]),
    V = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++)
    for (let j = i; j < k; j++) {
      const p = pieces[i],
        q = pieces[j];
      let a = 0,
        b = 0,
        from = 0,
        sum = 0;
      while (from < T) {
        const nextA = a + 1 < p.length ? p[a + 1][0] : T,
          nextB = b + 1 < q.length ? q[b + 1][0] : T,
          to = Math.min(nextA, nextB, T);
        const product = p[a][1] * q[b][1];
        if (product && to > from) sum += product * span(from, to);
        from = to;
        if (nextA === to && a + 1 < p.length) a++;
        if (nextB === to && b + 1 < q.length) b++;
        if (to >= T) break;
      }
      V[i][j] = V[j][i] = -sum;
    }
  for (let i = 0; i < k; i++) V[i][i] += diagonal.value(i);
  return V;
}
/** k*k running sums carried as quadSum carries them, in flat arrays. */
function quadMatrix(k) {
  const sum = new Float64Array(k * k),
    carry = new Float64Array(k * k);
  return {
    add(a, x) {
      const s = sum[a],
        total = s + x;
      carry[a] += Math.abs(s) >= Math.abs(x) ? s - total + x : x - total + s;
      sum[a] = total;
    },
    value: (a) => (Number.isFinite(sum[a]) ? sum[a] + carry[a] : sum[a]),
  };
}

// ----- stcox -----
const TIES = {
  none: "no ties",
  breslow: "Breslow method for ties",
  efron: "Efron method for ties",
  marginal: "exact marginal likelihood method for ties",
};

/**
 * The analysis data of a model: the design of the covariates over the st
 * records, with _t, _t0 and _d of each record of the sample.
 */
function stFrame(session, parsed, constant) {
  const st = session.data.get("_st").data,
    only = new Set();
  for (let i = 0; i < session.data.n; i++) if (st[i] === 1) only.add(i);
  const f = frame(
      session,
      {
        ...parsed,
        anything: `_t ${parsed.anything ?? ""}`,
        only: parsed.only
          ? new Set([...parsed.only].filter((i) => only.has(i)))
          : only,
      },
      constant,
      true,
    ),
    columns = stColumns(session);
  return {
    f,
    T: f.sample.map((i) => columns.t[i]),
    T0: f.sample.map((i) => columns.t0[i]),
    D: f.sample.map((i) => columns.d[i]),
  };
}

/**
 * The Cox partial log likelihood, its gradient and information, with ties
 * treated by method. X is centred, which leaves all three unchanged.
 */
function coxLikelihood(T, T0, D, X, method) {
  const n = T.length,
    k = X[0]?.length ?? 0,
    byExit = [...Array(n).keys()].sort((a, b) => T[b] - T[a]),
    byEntry = [...Array(n).keys()].sort((a, b) => T0[b] - T0[a]),
    times = [...new Set(byExit.filter((i) => D[i]).map((i) => T[i]))];
  // The failures at each failure time.
  const failing = new Map(times.map((t) => [t, []]));
  for (let i = 0; i < n; i++) if (D[i]) failing.get(T[i]).push(i);
  return (beta, todo = 2) => {
    const r = X.map((x) => Math.exp(x.reduce((a, v, j) => a + v * beta[j], 0))),
      S0 = { v: 0 },
      S1 = new Array(k).fill(0),
      S2 = Array.from({ length: k }, () => new Array(k).fill(0)),
      gradient = new Array(k).fill(0),
      information = Array.from({ length: k }, () => new Array(k).fill(0)),
      value = quadSum();
    const change = (i, sign) => {
      S0.v += sign * r[i];
      const x = X[i];
      for (let a = 0; a < k; a++) {
        S1[a] += sign * r[i] * x[a];
        if (todo >= 2)
          for (let b = 0; b <= a; b++) S2[a][b] += sign * r[i] * x[a] * x[b];
      }
    };
    let pe = 0,
      pn = 0;
    for (const time of times) {
      while (pe < n && T[byExit[pe]] >= time) change(byExit[pe++], 1);
      while (pn < n && T0[byEntry[pn]] >= time) change(byEntry[pn++], -1);
      const dead = failing.get(time),
        d = dead.length;
      for (const i of dead) {
        value.add(Math.log(r[i]));
        for (let a = 0; a < k; a++) gradient[a] += X[i][a];
      }
      // The sums over the failures themselves.
      let D0 = 0;
      const D1 = new Array(k).fill(0),
        D2 = Array.from({ length: k }, () => new Array(k).fill(0));
      if (method !== "breslow" && d > 1)
        for (const i of dead) {
          D0 += r[i];
          for (let a = 0; a < k; a++) {
            D1[a] += r[i] * X[i][a];
            if (todo >= 2)
              for (let b = 0; b <= a; b++) D2[a][b] += r[i] * X[i][a] * X[i][b];
          }
        }
      const term = (phi, psi, omega, times) => {
        value.add(-Math.log(phi), times);
        for (let a = 0; a < k; a++) {
          gradient[a] -= (times * psi[a]) / phi;
          if (todo >= 2)
            for (let b = 0; b <= a; b++)
              information[a][b] +=
                times * (omega[a][b] / phi - (psi[a] * psi[b]) / (phi * phi));
        }
      };
      if (method === "breslow" || d === 1) term(S0.v, S1, S2, d);
      else if (method === "efron")
        for (let j = 0; j < d; j++) {
          const w = j / d;
          term(
            S0.v - w * D0,
            S1.map((v, a) => v - w * D1[a]),
            S2.map((rowS, a) => rowS.map((v, b) => v - w * D2[a][b])),
            1,
          );
        }
      else {
        // The exact marginal likelihood: the chance that these d fail
        // before the others at risk, integrated over the unobserved order.
        value.add(-dead.reduce((a, i) => a + Math.log(r[i]), 0));
        for (const i of dead)
          for (let a = 0; a < k; a++) gradient[a] -= X[i][a];
        const C0 = S0.v - D0,
          C1 = S1.map((v, a) => v - D1[a]),
          C2 =
            todo >= 2
              ? S2.map((rowS, a) => rowS.map((v, b) => v - D2[a][b]))
              : null;
        const part = marginal(
          dead.map((i) => r[i]),
          dead.map((i) => X[i]),
          C0,
          C1,
          C2,
          k,
          todo,
        );
        value.add(part.value);
        for (let a = 0; a < k; a++) {
          gradient[a] += part.gradient[a];
          if (todo >= 2)
            for (let b = 0; b <= a; b++)
              information[a][b] += part.information[a][b];
        }
      }
    }
    if (todo >= 2)
      for (let a = 0; a < k; a++)
        for (let b = a + 1; b < k; b++) information[a][b] = information[b][a];
    return { value: value.value, gradient, information };
  };
}

/**
 * The 15 nodes and weights of Gauss–Laguerre quadrature, ∫0^∞ e^-v f(v) dv
 * ≈ Σ w f(v). Stata integrates the exact marginal likelihood with them:
 * its log likelihoods equal the 15-point sums to every digit it shows,
 * as for tied groups of 207, 235 and 236 among 1,000, 678 and 326 at risk,
 * where Stata's -1466.5746 is the 15-point value and the integral itself
 * gives -1129.6494 (docs/numerical-contract.md).
 */
const LAGUERRE = (() => {
  const m = 15,
    nodes = [],
    weights = [];
  let z = 0;
  for (let i = 0; i < m; i++) {
    if (i === 0) z = 3 / (1 + 2.4 * m);
    else if (i === 1) z += 15 / (1 + 2.5 * m);
    else z += ((1 + 2.55 * (i - 1)) / (1.9 * (i - 1))) * (z - nodes[i - 2]);
    let p1 = 0,
      p2 = 0,
      dp = 0;
    for (let iteration = 0; iteration < 100; iteration++) {
      p1 = 1;
      p2 = 0;
      for (let j = 1; j <= m; j++) {
        const p3 = p2;
        p2 = p1;
        p1 = ((2 * j - 1 - z) * p2 - (j - 1) * p3) / j;
      }
      dp = (m * (p1 - p2)) / z;
      const before = z;
      z -= p1 / dp;
      if (Math.abs(z - before) <= 1e-15 * Math.abs(z)) break;
    }
    nodes.push(z);
    weights.push(-1 / (dp * m * p2));
  }
  return { nodes, weights };
})();

/**
 * One tied group's term of the exact marginal likelihood: the log of
 * ∫0^∞ e^-v Π (1 - exp(-a_i v)) dv, a_i = r_i / C0 with C0 the risk of
 * those at risk who did not fail then, with its gradient and information
 * in beta, by Stata's 15-point Gauss–Laguerre rule, summed in logs so that
 * large groups do not underflow. C2 holds the lower triangle of the
 * second moments of the others.
 */
function marginal(r, X, C0, C1, C2, k, todo) {
  const d = r.length,
    gradient = new Array(k).fill(0),
    information = Array.from({ length: k }, () => new Array(k).fill(0));
  if (!(C0 > 0)) return { value: 0, gradient, information };
  const a = r.map((v) => v / C0),
    xbar = C1.map((v) => v / C0),
    u = X.map((x) => x.map((v, j) => v - xbar[j])),
    logs = LAGUERRE.nodes.map((v, q) => {
      let s = Math.log(LAGUERRE.weights[q]);
      for (const ai of a) s += Math.log(-Math.expm1(-ai * v));
      return s;
    }),
    top = Math.max(...logs);
  let total = 0,
    weightC = 0;
  const first = new Array(k).fill(0),
    outer = Array.from({ length: k }, () => new Array(k).fill(0)),
    own = new Array(d).fill(0),
    s = new Array(k);
  LAGUERRE.nodes.forEach((v, q) => {
    const P = Math.exp(logs[q] - top);
    if (!(P > 0)) return;
    const c = a.map((ai) => (v * Math.exp(-ai * v)) / -Math.expm1(-ai * v));
    total += P;
    s.fill(0);
    let sumC = 0;
    for (let i = 0; i < d; i++) {
      const ca = c[i] * a[i];
      sumC += ca;
      for (let j = 0; j < k; j++) s[j] += ca * u[i][j];
      if (todo >= 2) {
        // (H/F - c^2) a^2 + c a, with H/F = -v c.
        own[i] += P * ((-v * c[i] - c[i] * c[i]) * a[i] * a[i] + ca);
      }
    }
    for (let j = 0; j < k; j++) first[j] += P * s[j];
    if (todo >= 2) {
      weightC += P * sumC;
      for (let j = 0; j < k; j++)
        for (let m = 0; m <= j; m++) outer[j][m] += P * s[j] * s[m];
    }
  });
  for (let j = 0; j < k; j++) gradient[j] = first[j] / total;
  if (todo >= 2) {
    for (let j = 0; j < k; j++)
      for (let m = 0; m <= j; m++) {
        let second = outer[j][m];
        for (let i = 0; i < d; i++) second += own[i] * u[i][j] * u[i][m];
        const covariance = C2[j][m] / C0 - xbar[j] * xbar[m];
        second -= weightC * covariance;
        information[j][m] = -(second / total - gradient[j] * gradient[m]);
        information[m][j] = information[j][m];
      }
  }
  return { value: top + Math.log(total), gradient, information };
}

function coxFit(T, T0, D, X, method) {
  const k = X[0]?.length ?? 0,
    means = new Array(k).fill(0);
  for (const x of X) x.forEach((v, j) => (means[j] += v / X.length));
  const centred = X.map((x) => x.map((v, j) => v - means[j])),
    evaluate = coxLikelihood(T, T0, D, centred, method);
  const ll0 = evaluate(new Array(k).fill(0), 0).value;
  if (!k)
    return {
      theta: [],
      V: [],
      ll: ll0,
      ll0,
      log: [ll0],
      notes: [""],
      converged: true,
    };
  return { ...coxNewton(evaluate, k), ll0 };
}

/**
 * Newton's method as Stata's cox takes it: full steps, halved while the
 * likelihood falls, until g'inv(H)g is below 1e-5 and the next step would
 * move every estimate by less than 1e-4 of itself; then the estimates are
 * refined by further steps, each of which "Refining estimates" logs before
 * it is taken, until one moves them by less than that, and then silently
 * until the steps no longer move them. Stata's cox ignores tolerance(),
 * ltolerance() and nrtolerance(); this rule gives the number of iterations
 * it logs for 48 fits of Breslow's, Efron's and the exact marginal
 * likelihood on data of 40 to 500 records, recorded from Stata 19, where
 * a relative change of 1e-6 in the estimates or 1e-7 in the log
 * likelihood took one iteration more than Stata in 34 of them.
 */
function coxNewton(evaluate, k) {
  const times = (m, v) => m.map((r) => r.reduce((t, x, j) => t + x * v[j], 0)),
    settled = (beta, step) =>
      step.every((v, j) => !v || Math.abs(v) < 1e-4 * Math.abs(beta[j]));
  let beta = new Array(k).fill(0),
    current = evaluate(beta, 2),
    converged = false;
  const log = [current.value],
    notes = [""];
  for (let iteration = 0; iteration < 300; iteration++) {
    const V = generalizedInverse(current.information),
      step = times(V, current.gradient),
      criterion = current.gradient.reduce((t, g, j) => t + g * step[j], 0);
    if (Math.abs(criterion) < 1e-5 && settled(beta, step)) {
      converged = true;
      break;
    }
    let next = beta.map((b, j) => b + step[j]),
      value = evaluate(next, 0).value,
      halvings = 0;
    while (!(value >= current.value) && halvings < 60) {
      next = next.map((b, j) => (b + beta[j]) / 2);
      value = evaluate(next, 0).value;
      halvings++;
    }
    beta = next;
    current = evaluate(beta, 2);
    log.push(current.value);
    notes.push(halvings >= 6 ? "backed up" : "");
  }
  // Refining: each step is logged before it is taken, until one settles
  // the estimates; then steps until they no longer move them.
  const refined = [];
  for (let refine = 0; refine < 20; refine++) {
    refined.push(current.value);
    const step = times(
        generalizedInverse(current.information),
        current.gradient,
      ),
      last = settled(beta, step),
      next = beta.map((b, j) => b + step[j]),
      at = evaluate(next, 2);
    if (at.value >= current.value - 1e-12 * Math.abs(current.value)) {
      beta = next;
      current = at;
    }
    if (last) break;
  }
  for (let refine = 0; refine < 20; refine++) {
    const step = times(
      generalizedInverse(current.information),
      current.gradient,
    );
    if (step.every((v, j) => Math.abs(v) <= 1e-15 * (1 + Math.abs(beta[j]))))
      break;
    const next = beta.map((b, j) => b + step[j]),
      at = evaluate(next, 2);
    if (!(at.value >= current.value - 1e-12 * Math.abs(current.value))) break;
    beta = next;
    current = at;
  }
  return {
    theta: beta,
    ll: current.value,
    V: generalizedInverse(current.information),
    log,
    notes,
    refined,
    converged,
  };
}

/** The st_hcd.ado header of stcox and streg. */
/**
 * The header of stcox and streg; under bootstrap or jackknife `test` is
 * the prefix's: Wald chi2 or F, from the replicates' variance.
 */
function stHeaderTable(ctx, e, test = null) {
  const subjects = trimmed(e.N_sub, "%12.0fc"),
    failures = trimmed(e.N_fail, "%12.0fc"),
    risk = trimmed(Math.round(e.risk / 0.0001) * 0.0001, "%12.0gc"),
    left = Math.max(subjects.length, failures.length, risk.length),
    nobs = trimmed(e.N, "%10.0fc"),
    chi2 = trimmed(test ? test.value : e.chi2, "%10.2f"),
    right = Math.max(nobs.length, chi2.length, 1, 6),
    statistic = test
      ? test.label
      : `${e.chi2type === "Wald" ? "Wald" : "LR"} chi2(${trimmed(e.df_m, "%4.0f")})`,
    widest = Math.max(13, statistic.length, 11),
    at = 79 - widest - 3 - right,
    p = trimmed(
      test ? test.p : e.df_m > 0 ? chi2tail(e.df_m, e.chi2) : MISSING,
      "%10.4f",
    ),
    pair = (label, value) =>
      `${label.padEnd(widest)} = ${value.padStart(right)}`;
  ctx.out("");
  ctx.out(
    `${column(`No. of subjects = ${subjects.padStart(left)}`, at)}${pair("Number of obs", nobs)}`,
  );
  ctx.out(`No. of failures = ${failures.padStart(left)}`);
  ctx.out(`Time at risk    = ${risk.padStart(left)}`);
  ctx.out(`${" ".repeat(at - 1)}${pair(statistic, chi2)}`);
  ctx.out(
    `${column(`Log likelihood = ${trimmed(e.ll, "%10.0g")}`, at)}${pair(test?.pLabel ?? "Prob > chi2", p)}`,
  );
}
/** The prefix's test as the survival header shows it. */
const prefixTest = (r) =>
  r.df
    ? {
        label: `F(${r.test.df}, ${r.df})`,
        value: r.test.F,
        p: r.test.p,
        pLabel: "Prob > F",
      }
    : {
        label: `Wald chi2(${r.test.df})`,
        value: r.test.value,
        p: r.test.p,
        pLabel: "Prob > chi2",
      };
/**
 * The title; under a prefix stcox then says which made the variance
 * (streg does not).
 */
function prefixTitle(ctx, title, r) {
  ctx.out(title);
  if (!r) return;
  ctx.out("");
  ctx.out(r.method === "bootstrap" ? "Bootstrap results" : "Jackknife results");
}
/**
 * stcox and streg under bootstrap and jackknife: the test of the
 * covariates (not streg's constant), and their own table with the
 * prefix's heads and variance.
 */
const SURVIVAL_RESAMPLED = {
  tested: (fit) =>
    fit.names
      .map((name, j) =>
        name !== "_cons" && fit.estimable[j] && fit.V[j][j] !== 0 ? j : -1,
      )
      .filter((j) => j >= 0),
  show(session, ctx, fit, r) {
    (fit.kind === "stcox" ? coxTable : stregTable)(session, ctx, fit, {}, r);
  },
};

/** N_sub, N_fail and risk of a sample, as st_hc.ado counts them. */
function stCounts(session, sample, T, T0, D) {
  const s = stSettings(session),
    subjects = s.id
      ? new Set(sample.map((i) => session.data.get(s.id).data[i])).size
      : sample.length;
  return {
    N_sub: subjects,
    N_fail: D.reduce((a, b) => a + (b ? 1 : 0), 0),
    risk: T.reduce((a, t, j) => a + t - T0[j], 0),
  };
}

function stcox(session, text, ctx) {
  const [head, tail] = splitAtComma(text);
  // stcox, estimate fits the model with no covariates; stcox alone replays.
  if (!head.trim() && !/(^|[\s,])esti(m(a(te?)?)?)?\b/.test(tail ?? ""))
    return stcoxReplay(session, tail ?? "", ctx);
  const s = stSettings(session),
    parsed = session.parse(
      "[anything] [if] [in] [, noHR Level(cilevel) noSHow noLOg BREslow EFRon EXACTM BASElevels ALLBASElevels ESTImate | EXACTP Robust VCE(string) CLuster(string) STrata(varlist) TVC(string) TEXP(string) SHared(varname) OFFset(varname) BASEHC(string) BASEChazard(string) BASESurv(string) MGale(string) ESR(string) SCHoenfeld(string) SCAledsch(string) NOHEADer]",
      text,
    ),
    o = parsed.options,
    chosen = ["breslow", "efron", "exactm"].filter((m) => o[m]);
  if (chosen.length > 1)
    throw invalid("only one of breslow, efron, exactm, and exactp is allowed");
  const method = o.efron ? "efron" : o.exactm ? "marginal" : "breslow",
    { f, T, T0, D } = stFrame(session, parsed, false),
    // With no failures nothing can be estimated, and every covariate is
    // shown omitted, as Stata shows them.
    none = !D.some((v) => v),
    fit = none
      ? {
          theta: f.active.map(() => 0),
          V: f.active.map(() => f.active.map(() => 0)),
          ll: 0,
          ll0: 0,
          log: [0],
          notes: [""],
          refined: [0],
          converged: true,
        }
      : coxFit(T, T0, D, f.x, method),
    counts = stCounts(session, f.sample, T, T0, D),
    // Stata's title and e(ties) say "no ties" when no two failures share a
    // time, whichever method was asked for; the methods then agree.
    seen = new Set(),
    tied = T.some((t, i) => D[i] && (seen.has(t) || !seen.add(t))),
    ties = tied ? method : "none",
    names = f.columns.map((c) => c.name),
    placed = f.place(fit.theta, fit.V),
    // The rank of the estimates is that of their variance: a coefficient
    // the information cannot identify, as one that separates the failures
    // from the rest, has none and adds no degree of freedom.
    k = names.filter(
      (_, j) => placed.estimable[j] && placed.V[j][j] !== 0,
    ).length,
    covariates = names.length > 0,
    chi2 = Math.max(0, 2 * (fit.ll - fit.ll0));
  stHeader(ctx, s, o.show === false);
  // The iteration log opens with a blank line, before the notes of
  // omitted variables; without it the notes come first.
  if (o.log !== false) {
    ctx.out("");
    f.notes(ctx);
    fit.log.forEach((v, j) =>
      ctx.out(iterationLine(j, "Log likelihood", v, fit.notes[j])),
    );
    ctx.out("Refining estimates:");
    (fit.refined ?? [fit.ll]).forEach((v, j) =>
      ctx.out(iterationLine(j, "Log likelihood", v)),
    );
  } else f.notes(ctx);
  ctx.out("");
  const model = {
    // estat names the model by e(cmd), which is cox.
    command: "cox",
    kind: "stcox",
    title: "Cox regression",
    dist: "z",
    depvar: "_t",
    names,
    ...placed,
    columns: f.columns,
    constant: false,
    N: f.sample.length,
    df_m: k,
    rank: k,
    ll: fit.ll,
    ll_0: fit.ll0,
    vce: "oim",
    sample: f.sample,
    level: o.level,
    eform: o.hr !== false ? "Haz. ratio" : null,
    // The covariates' values over the sample, by which estat phtest
    // knows the data have changed since (checkestimationsample).
    fitValues: f.columns.map((c) => f.sample.map((i) => c.value(i))),
    resampled: SURVIVAL_RESAMPLED,
    survival: {
      method: ties,
      T,
      T0,
      D,
      X: f.x,
      theta: fit.theta,
      V: fit.V,
      active: f.active.map((c) => c.name),
      counts,
      ties: method,
    },
  };
  session.estimates = model;
  const e = { N: model.N, ll_0: fit.ll0, ll: fit.ll, chi2 };
  // Stata leaves e(r2_p) out when the null log likelihood is zero, and
  // e(rank) out when there are no covariates.
  if (fit.ll0 !== 0) e.r2_p = 1 - fit.ll / fit.ll0;
  e.converged = fit.converged ? 1 : 0;
  if (covariates) e.rank = k;
  Object.assign(e, {
    df_m: k,
    ...counts,
    cmdline: `stcox ${text.trim()}`,
    cmd2: "stcox",
    marginsnotok:
      "CSNell DEViance DFBeta ESR LDisplace LMax MGale SCAledsch SCHoenfeld SCores",
    footnote: "stcox_footnote",
    predict: "stcox_p",
    estat_cmd: "stcox_estat",
    vce: "oim",
    chi2type: "LR",
    // e(ties) comes before e(method) when there are none.
    ...(tied ? { method, ties } : { ties, method }),
    t0: "_t0",
    depvar: "_t",
    cmd: "cox",
    properties: "b V",
  });
  session.results.e = e;
  coxTable(session, ctx, model, o);
  unconverged(fit);
}

function coxTable(session, ctx, model, o, r = null) {
  const e = session.results.e;
  if (!r || r.header !== false) {
    prefixTitle(ctx, `Cox regression with ${TIES[model.survival.method]}`, r);
    stHeaderTable(ctx, { ...e, df_m: model.df_m }, r && prefixTest(r));
    ctx.out("");
  }
  if (r && r.table === false) return;
  const level = r?.level ?? o.level ?? model.level,
    hr = r ? !!model.eform : o.hr !== false,
    df = r?.df ?? 0;
  // A coefficient held at zero with no variance is shown omitted, as
  // _coef_table shows one.
  const f = {
      columns: model.columns,
      names: model.names,
      at: model.names.map((_, j) =>
        model.estimable[j] && (model.b[j] !== 0 || model.V[j][j] !== 0)
          ? j
          : -1,
      ),
    },
    w = tableWidth(session, tableModel(f, baseLevelsAsked(o)), ["_t"]),
    head = [],
    sink = { out: (line) => head.push(line) };
  if (r?.note) ctx.out(r.note.padStart(w + 66));
  if (r) r.heads(sink, w, "_t", hr ? "Haz. ratio" : "Coefficient");
  else
    tableHead(
      sink,
      "_t",
      level,
      hr ? "Haz. ratio" : "Coefficient",
      false,
      false,
      w,
    );
  // With no covariates the table is its heading alone.
  (model.names.length ? head : head.slice(0, -1)).forEach((line) =>
    ctx.out(line),
  );
  layoutRows(
    session,
    f,
    baseLevelsAsked(o),
    (j) =>
      row("", model.b[j], Math.sqrt(model.V[j][j]), level, df, hr).slice(1),
    w,
    hr ? 1 : 0,
  ).forEach(ctx.out);
  ctx.out(rule(w));
}

function stcoxReplay(session, tail, ctx) {
  const model = estimates(session);
  if (model.kind !== "stcox")
    throw new StataError("last estimates not found", 301);
  const o = session.parse(
    "[, noHR Level(cilevel) BASElevels ALLBASElevels]",
    `,${tail}`,
  ).options;
  ctx.out("");
  coxTable(session, ctx, model, o);
}

// ----- streg -----
const DISTRIBUTIONS = [
  ["exponential", 1, "Exponential", "ereg", "ereg_p"],
  ["weibull", 1, "Weibull", "weibull", "weibul_p"],
  ["gompertz", 3, "Gompertz", "gompertz", "gomper_p"],
];

/**
 * One record's log likelihood under each model and its derivatives in the
 * index eta and the ancillary parameter phi: [ll, l_e, l_p, l_ee, l_ep,
 * l_pp]. Stata reports the likelihood of log time, so failures add ln t.
 */
const RECORD = {
  exponential: (aft) => (t, t0, d, eta) => {
    const span = t - t0;
    if (aft) {
      const m = Math.exp(-eta);
      return [
        -d * eta - m * span + d * Math.log(t),
        -d + m * span,
        0,
        -m * span,
        0,
        0,
      ];
    }
    const m = Math.exp(eta);
    return [
      d * eta - m * span + d * Math.log(t),
      d - m * span,
      0,
      -m * span,
      0,
      0,
    ];
  },
  // weib_lf0 and weib_lf: here t and t0 are ln t and ln t0, centred on the
  // mean of ln t as weibull_s.ado centres them, and t0 is null at entry 0.
  weibull: () => (L, L0, d, eta, phi) => {
    const p = Math.exp(phi),
      e = Math.exp(p * L + eta),
      e0 = L0 === null ? 0 : Math.exp(p * L0 + eta),
      pL = p * L,
      pL0 = L0 === null ? 0 : p * L0;
    return [
      d * (eta + phi + pL) - e + e0,
      d - e + e0,
      d * (1 + pL) - pL * e + pL0 * e0,
      -e + e0,
      -pL * e + pL0 * e0,
      d * pL - (pL + pL * pL) * e + (pL0 + pL0 * pL0) * e0,
    ];
  },
  gompertz: () => (t, t0, d, eta, given) => {
    // gomp_lf moves a gamma within 1e-6 of zero, but not zero, a further
    // 1e-6 away from it.
    const gamma =
        given !== 0 && Math.abs(given) < 1e-6
          ? given + (given < 0 ? -1e-6 : 1e-6)
          : given,
      m = Math.exp(eta),
      [B, Bg, Bgg] = gompertzIntegral(t, t0, gamma);
    return [
      d * (eta + gamma * t) - m * B + d * Math.log(t),
      d - m * B,
      d * t - m * Bg,
      -m * B,
      -m * Bg,
      -m * Bgg,
    ];
  },
};
/** ∫t0^t exp(gamma u) du and its first two derivatives in gamma. */
function gompertzIntegral(t, t0, gamma) {
  if (Math.abs(gamma) * Math.max(t, 1e-300) < 0.5) {
    // The series in gamma, which holds at gamma = 0: the jth term of B is
    // gamma^(j-1) (t^j - t0^j) / j!; p0, p1 and p2 are gamma^(j-1),
    // gamma^(j-2) and gamma^(j-3).
    let B = 0,
      Bg = 0,
      Bgg = 0,
      tk = t,
      t0k = t0,
      factorial = 1,
      p0 = 1,
      p1 = 0,
      p2 = 0;
    for (let j = 1; j < 60; j++) {
      const diff = (tk - t0k) / factorial,
        last = p0 * diff,
        lastSecond = (j - 1) * (j - 2) * p2 * diff;
      B += last;
      Bg += (j - 1) * p1 * diff;
      Bgg += lastSecond;
      if (
        j > 4 &&
        Math.abs(last) <= 1e-17 * Math.abs(B) &&
        Math.abs(lastSecond) <= 1e-17 * Math.abs(Bgg)
      )
        break;
      tk *= t;
      t0k *= t0;
      factorial *= j + 1;
      p2 = p1;
      p1 = p0;
      p0 *= gamma;
    }
    return [B, Bg, Bgg];
  }
  const e = Math.exp(gamma * t),
    e0 = Math.exp(gamma * t0),
    B = (e - e0) / gamma,
    Bg = (t * e - t0 * e0) / gamma - B / gamma,
    Bgg = (t * t * e - t0 * t0 * e0) / gamma - (2 * Bg) / gamma;
  return [B, Bg, Bgg];
}

/**
 * weibull_s.ado's constant-only model: Newton steps in ln p alone, the
 * constant taken at each step as ln(failures / sum of t^p), in centred
 * log time L (and L0 at entry, null for entry at 0).
 */
function weibullConstant(L, L0, D) {
  const reldif = (a, b) => Math.abs(a - b) / (Math.abs(b) + 1),
    nfail = D.reduce((a, b) => a + b, 0),
    dlnt = quadSum();
  L.forEach((v, i) => D[i] && dlnt.add(v));
  const entry = L0.some((v) => v !== null),
    // summarize x [aw=exp(p x)]: the weights' sum, the weighted sum and
    // the weighted sum of squares about the mean.
    moments = (values, p) => {
      const w = quadSum(),
        s = quadSum();
      for (const x of values) {
        const e = Math.exp(p * x);
        w.add(e);
        s.add(x, e);
      }
      const mean = s.value / w.value,
        ss = quadSum();
      for (const x of values) ss.add((x - mean) ** 2, Math.exp(p * x));
      return { sumw: w.value, sum: s.value, mean, ss: ss.value };
    };
  let lnp = 0,
    step = 0,
    ll = 0,
    tp = 0,
    converged = false;
  const log = [];
  // WeibCons allows 20 iterations after the first.
  for (let i = 0; !converged && i <= 20; i++) {
    const before = ll;
    lnp += step;
    const p = Math.exp(lnp),
      one = moments(L, p);
    let df, ddf;
    if (!entry) {
      df = one.mean - 1 / p;
      ddf = (p * one.ss) / one.sumw + 1 / p;
      tp = one.sumw;
    } else {
      const zero = moments(
          L0.filter((v) => v !== null),
          p,
        ),
        sumw12 = one.sumw - zero.sumw;
      df = (one.sum - zero.sum) / sumw12 - 1 / p;
      ddf =
        (p *
          (one.ss -
            zero.ss -
            (one.sumw * zero.sumw * (one.mean - zero.mean) ** 2) / sumw12)) /
          sumw12 +
        1 / p;
      tp = sumw12;
    }
    ll = nfail * (Math.log(nfail / tp) + lnp - 1) + p * dlnt.value;
    step = (dlnt.value / nfail - df) / ddf;
    log.push(ll);
    converged =
      (reldif(ll, before) <= 1e-7 || Math.abs(step) < 1e-15) && i >= 2;
  }
  return {
    theta: [Math.log(nfail / tp), lnp],
    ll,
    log,
    notes: log.map(() => ""),
    converged,
  };
}

/**
 * A Weibull fit in centred time put back as Stata puts it: the constant
 * moved by p times the mean of ln t (AdjCons), or the whole equation
 * turned into the accelerated-time metric (Remetric), with the variance
 * carried by the Jacobian and the gradient by its inverse transpose.
 */
function weibullMetric(theta, V, m, aft, gradient) {
  const k = theta.length,
    cons = k - 2,
    lnp = theta[k - 1],
    p = Math.exp(lnp),
    J = Array.from({ length: k }, (_, r) =>
      Array.from({ length: k }, (_, c) => (r === c ? 1 : 0)),
    ),
    b = theta.slice();
  if (aft) {
    const s = -Math.exp(-lnp);
    for (let j = 0; j <= cons; j++) b[j] = s * theta[j];
    for (let j = 0; j <= cons; j++) {
      J[j][j] = s;
      J[j][k - 1] = -b[j];
    }
    b[cons] += m;
  } else {
    b[cons] = theta[cons] - p * m;
    J[cons][k - 1] = -p * m;
  }
  const JV = J.map((row) =>
      V[0].map((_, c) => row.reduce((t, x, j) => t + x * V[j][c], 0)),
    ),
    out = JV.map((row) =>
      J.map((other) => row.reduce((t, x, j) => t + x * other[j], 0)),
    );
  return { theta: b, V: out, gradient: solve(transpose(J), gradient) };
}
const transpose = (A) => A[0].map((_, c) => A.map((row) => row[c]));
/** The solution of A x = y by elimination with partial pivoting. */
function solve(A, y) {
  const n = y.length,
    M = A.map((row, r) => [...row, y[r]]);
  for (let c = 0; c < n; c++) {
    let best = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(M[r][c]) > Math.abs(M[best][c])) best = r;
    [M[c], M[best]] = [M[best], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || !M[r][c]) continue;
      const factor = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= factor * M[c][j];
    }
  }
  return M.map((row, r) => row[n] / row[r]);
}

function strFit(T, T0, D, X, dist, aft, start, iterate = true) {
  const record = RECORD[dist](aft),
    k = start.length,
    ancillary = dist !== "exponential",
    kb = ancillary ? k - 1 : k;
  const evaluate = (theta, todo = 2) => {
    const value = quadSum(),
      gradient = new Array(k).fill(0),
      information = Array.from({ length: k }, () => new Array(k).fill(0)),
      phi = ancillary ? theta[k - 1] : 0;
    for (let i = 0; i < T.length; i++) {
      const x = X[i];
      let eta = 0;
      for (let j = 0; j < kb; j++) eta += x[j] * theta[j];
      const [ll, le, lp, lee, lep, lpp] = record(T[i], T0[i], D[i], eta, phi);
      value.add(ll);
      if (todo < 1) continue;
      for (let a = 0; a < kb; a++) {
        gradient[a] += le * x[a];
        if (todo >= 2) {
          for (let b = 0; b <= a; b++) information[a][b] -= lee * x[a] * x[b];
          if (ancillary) information[k - 1][a] -= lep * x[a];
        }
      }
      if (ancillary) {
        gradient[k - 1] += lp;
        if (todo >= 2) information[k - 1][k - 1] -= lpp;
      }
    }
    for (let a = 0; a < k; a++)
      for (let b = a + 1; b < k; b++) information[a][b] = information[b][a];
    return { value: value.value, gradient, information };
  };
  if (!iterate) {
    // Where the start is already the estimate: no step is taken.
    const at = evaluate(start, 2);
    return {
      theta: start,
      ll: at.value,
      V: generalizedInverse(at.information),
      log: [at.value],
      notes: [""],
      converged: true,
      evaluate,
    };
  }
  return { ...maximizeNR(evaluate, start), evaluate };
}

function streg(session, text, ctx) {
  const [head, tail] = splitAtComma(text);
  if (
    !head.trim() &&
    !/\bd(i(s(t(r(i(b(u(t(i(on?)?)?)?)?)?)?)?)?)?)?\s*\(/.test(tail ?? "")
  )
    return stregReplay(session, tail ?? "", ctx);
  const s = stSettings(session),
    parsed = session.parse(
      "[anything] [if] [in] [, Distribution(string) noHR TIme Level(cilevel) noSHow noLOg BASElevels ALLBASElevels | TRatio noCONStant Robust VCE(string) CLuster(string) STrata(varlist) ANCillary(varlist) ANC2(varlist) FRailty(string) SHared(varname) OFFset(varname) NOHEADer]",
      text,
    ),
    o = parsed.options,
    given = (o.distribution ?? "").trim();
  // Without distribution(), streg fits the distribution of the last streg.
  let found;
  if (!given) {
    if (session.estimates?.kind !== "streg")
      throw invalid("you must specify option distribution()");
    found = DISTRIBUTIONS.find(
      ([name]) => name === session.estimates.streg.dist,
    );
  } else
    found = DISTRIBUTIONS.find(
      ([name, shortest, , command]) =>
        (given.length >= shortest && name.startsWith(given)) ||
        (command === "ereg" && "ereg".startsWith(given)),
    );
  if (!found) {
    const others = [
      ["lognormal", 4],
      ["lnormal", 2],
      ["loglogistic", 4],
      ["llogistic", 2],
      ["ggamma", 4],
    ];
    if (
      others.some(
        ([name, shortest]) =>
          given.length >= shortest && name.startsWith(given),
      )
    )
      throw notHere(
        `streg, distribution(${given})`,
        "streg fits the exponential, Weibull and Gompertz models here.",
      );
    throw invalid(`unknown distribution ${given}`);
  }
  const [dist, , label, cmd, predictSub] = found;
  if (o.time && dist === "gompertz") throw invalid("option time not allowed");
  if (o.time && o.hr === false) throw invalid("option nohr not allowed");
  const aft = !!o.time,
    ancillary = dist !== "exponential",
    { f, T, T0, D } = stFrame(session, parsed, true),
    counts = stCounts(session, f.sample, T, T0, D),
    kb = f.active.length + 1,
    lnRate = Math.log(counts.N_fail / counts.risk),
    base = aft ? -lnRate : lnRate,
    constantX = f.x.map(() => [1]);
  if (!counts.N_fail) {
    stHeader(ctx, s, o.show === false);
    throw new StataError("no failures", 498);
  }
  // The constant-only model: in closed form for the exponential, by
  // Newton steps from it for the Gompertz, and for the Weibull by
  // weibull_s.ado's steps in ln p alone, in time centred on the mean of
  // ln t, where the full model is fitted too and then put back.
  let null0, fit, theta, V, gradient;
  const zeros = new Array(kb - 1).fill(0),
    // gompertz.ado fits a model with no covariates at once, from zero,
    // and reports a Wald test of nothing; weibull.ado leaves the
    // constant-only model as it is.
    alone = !f.columns.length,
    wald = alone && dist === "gompertz";
  if (wald) {
    null0 = null;
    fit = strFit(T, T0, D, constantX, dist, aft, [0, 0]);
    ({ theta, V } = fit);
    gradient = fit.evaluate(theta, 1).gradient;
  } else if (dist === "weibull") {
    const lnt = T.map((t) => Math.log(t)),
      total = quadSum();
    lnt.forEach((v) => total.add(v));
    const m = total.value / lnt.length,
      L = lnt.map((v) => v - m),
      L0 = T0.map((t) => (t > 0 ? Math.log(t) - m : null));
    null0 = weibullConstant(L, L0, D);
    // When WeibCons fails, weibull_s.ado fits the constant-only model again
    // by ml from ml search's starting values, which are not computed here.
    if (!null0.converged) {
      stHeader(ctx, s, o.show === false);
      if (o.log !== false) {
        ctx.out("");
        ctx.out("Fitting constant-only model:");
        null0.log.forEach((v, j) =>
          ctx.out(iterationLine(j, "Log likelihood", v)),
        );
      }
      throw new StataError(
        "convergence not achieved\nThe constant-only Weibull model did not converge in 20 iterations; Stata then searches for other starting values, which is not done here.",
        430,
      );
    }
    fit = strFit(
      L,
      L0,
      D,
      f.x,
      "weibull",
      false,
      [...zeros, ...null0.theta],
      !alone,
    );
    if (alone) fit.log = [(fit.ll = null0.ll)];
    ({ theta, V, gradient } = weibullMetric(
      fit.theta,
      fit.V,
      m,
      aft,
      fit.evaluate(fit.theta, 1).gradient,
    ));
  } else {
    if (ancillary) null0 = strFit(T, T0, D, constantX, dist, aft, [base, 0]);
    else {
      const record = RECORD.exponential(aft),
        sum = quadSum();
      T.forEach((t, i) => sum.add(record(t, T0[i], D[i], base)[0]));
      null0 = {
        theta: [base],
        ll: sum.value,
        log: [sum.value],
        notes: [""],
        converged: true,
      };
    }
    fit = strFit(T, T0, D, f.x, dist, aft, [...zeros, ...null0.theta]);
    ({ theta, V } = fit);
    gradient = fit.evaluate(theta, 1).gradient;
  }
  fit = { ...fit, theta, V, gradient };
  const k = theta.length,
    // The rank is that of the variance: a coefficient the information
    // cannot identify, as one that separates the failures from the rest,
    // has none, and the model's degrees of freedom are what remains after
    // the constant and the ancillary parameter.
    rank = V.filter((row, j) => row[j] !== 0).length,
    dfModel = Math.max(0, rank - (ancillary ? 2 : 1)),
    // Twice a difference of equal log likelihoods can round below zero.
    chi2 = wald ? MISSING : Math.max(0, 2 * (fit.ll - null0.ll)),
    p = dfModel > 0 ? chi2tail(dfModel, chi2) : MISSING,
    mainV = fit.V.slice(0, kb).map((r) => r.slice(0, kb)),
    names = [...f.columns.map((c) => c.name), "_cons"],
    aux = dist === "weibull" ? "ln_p" : dist === "gompertz" ? "gamma" : null,
    metric = aft ? "AFT" : "PH",
    title = `${label} ${metric} regression`;
  stHeader(ctx, s, o.show === false);
  f.notes(ctx);
  // Without a log, ml says first that convergence was not achieved.
  if (o.log === false && !fit.converged) ctx.out("convergence not achieved");
  // gompertz.ado's log of a model with no covariates follows the header
  // without a blank line.
  if (!wald || o.log === false) ctx.out("");
  if (o.log !== false) {
    if (ancillary && !wald) {
      ctx.out("Fitting constant-only model:");
      null0.log.forEach((v, j) =>
        ctx.out(iterationLine(j, "Log likelihood", v, null0.notes[j])),
      );
      ctx.out("");
      ctx.out("Fitting full model:");
    }
    fit.log.forEach((v, j) =>
      ctx.out(iterationLine(j, "Log likelihood", v, fit.notes[j])),
    );
    if (!fit.converged) ctx.out("convergence not achieved");
    ctx.out("");
  }
  const model = {
    command: cmd,
    kind: "streg",
    title,
    dist: "z",
    depvar: "_t",
    names,
    ...f.place(fit.theta.slice(0, kb), mainV),
    columns: f.columns,
    constant: true,
    N: f.sample.length,
    df_m: dfModel,
    rank,
    ll: fit.ll,
    ll_0: null0?.ll ?? MISSING,
    vce: "oim",
    sample: f.sample,
    level: o.level,
    streg: { dist, aft, label, hr: !aft && o.hr !== false },
    resampled: SURVIVAL_RESAMPLED,
    ...(aux
      ? {
          auxiliary: {
            equation: "/",
            names: [aux],
            b: [fit.theta[k - 1]],
            cross: [
              names.map((_, j) => (f.at[j] >= 0 ? fit.V[k - 1][f.at[j]] : 0)),
            ],
            V: [[fit.V[k - 1][k - 1]]],
          },
        }
      : {}),
  };
  session.estimates = model;
  // e(b) as Stata holds it: every column, base levels included, and the
  // ancillary parameter.
  const space = coefficientSpace(model),
    columns = space.entries.map(stripeName),
    shownGradient = space.entries.map((entry) =>
      entry.aux !== undefined
        ? fit.gradient[k - 1]
        : entry.index >= 0 && f.at[entry.index] >= 0
          ? fit.gradient[f.at[entry.index]]
          : 0,
    ),
    held = space.entries
      .map((entry, j) =>
        entry.index >= 0 && !model.estimable[entry.index] ? j : -1,
      )
      .filter((j) => j >= 0);
  const e = {
    rank,
    N: model.N,
    ic: fit.log.length - 1,
    k: space.entries.length,
    k_eq: ancillary ? 2 : 1,
    k_dv: ancillary ? 1 : 2,
    converged: fit.converged ? 1 : 0,
    rc: fit.converged ? 0 : 430,
    ll: fit.ll,
    k_eq_model: 1,
  };
  // Without the constant-only model there is no LR test to store.
  if (wald) e.df_m = dfModel;
  else {
    e.ll_0 = null0.ll;
    if (dist === "gompertz") e.rank0 = 2;
    Object.assign(e, { df_m: dfModel, chi2, p });
  }
  if (dist === "weibull") e.aux_p = Math.exp(fit.theta[k - 1]);
  if (ancillary) {
    e.k_aux = 1;
    if (wald) e.gamma = fit.theta[k - 1];
    Object.assign(
      e,
      wald
        ? { N_sub: counts.N_sub, N_fail: counts.N_fail, risk: counts.risk }
        : { risk: counts.risk, N_fail: counts.N_fail, N_sub: counts.N_sub },
    );
  } else
    Object.assign(e, {
      N_sub: counts.N_sub,
      N_fail: counts.N_fail,
      risk: counts.risk,
    });
  if (dist === "gompertz" && !wald) e.gamma = fit.theta[k - 1];
  // The macros in the order each of ereg, weibull and gompertz stores them.
  const macros = {
      cmd,
      depvar: "_t",
      stcurve: "stcurve",
      dead: "_d",
      frm2: aft ? "time" : "hazard",
    },
    order = {
      exponential: ["cmd", "depvar", "stcurve", "dead", "frm2"],
      weibull: ["cmd", "dead", "frm2", "stcurve"],
      gompertz: ["frm2", "cmd", "stcurve", "dead"],
    }[dist];
  Object.assign(e, {
    cmdline: `streg ${text.trim()}`,
    predict: "streg_p",
    predict_sub: predictSub,
    estat_cmd: "streg_estat",
    cmd2: "streg",
    title,
  });
  for (const name of order) e[name] = macros[name];
  Object.assign(e, {
    t0: "_t0",
    chi2type: wald ? "Wald" : "LR",
    deriv_useminbound: "off",
    opt: "moptimize",
    vce: "oim",
    // weibull_s.ado's evaluator for data that all enter at time zero, and
    // its general one.
    user:
      dist === "exponential"
        ? "ereg_lf"
        : dist === "gompertz"
          ? "gomp_lf"
          : T0.every((t) => t === 0)
            ? "weib_lf0"
            : "weib_lf",
    ml_method: "e2",
    technique: "nr",
    which: "max",
  });
  if (dist !== "exponential") e.depvar = "_t";
  e.properties = "b V";
  // A base level or an omitted variable is held at zero by a constraint.
  if (held.length)
    e["matrix:Cns"] = {
      rowNames: held.map((_, r) => `r${r + 1}`),
      colNames: [...columns, "_Cns:_r"],
      values: held.map((j) => [...columns.map((_, c) => (c === j ? 1 : 0)), 0]),
    };
  // The first 20 log likelihoods of the full model's iterations.
  e["matrix:ilog"] = {
    rowNames: ["r1"],
    colNames: Array.from({ length: 20 }, (_, c) => `c${c + 1}`),
    values: [Array.from({ length: 20 }, (_, c) => fit.log[c] ?? 0)],
  };
  e["matrix:gradient"] = {
    rowNames: ["r1"],
    colNames: columns,
    values: [shownGradient],
  };
  session.results.e = e;
  stregTable(session, ctx, model, o);
  unconverged(fit);
}

function stregTable(session, ctx, model, o, r = null) {
  const e = session.results.e,
    { aft } = model.streg,
    level = r?.level ?? o.level ?? model.level,
    hr = r ? !!model.streg.hr : !aft && o.hr !== false,
    df = r?.df ?? 0,
    // With no covariates the one row is the baseline hazard itself.
    alone = model.names.length === 1;
  if (!r || r.header !== false) {
    prefixTitle(ctx, model.title, null);
    stHeaderTable(ctx, e, r && prefixTest(r));
    ctx.out("");
  }
  if (r && r.table === false) return;
  const f = {
      columns: model.columns,
      names: model.names,
      at: model.names.map((_, j) => (model.estimable[j] ? j : -1)),
    },
    w = tableWidth(session, tableModel(f, baseLevelsAsked(o)), ["_t"]),
    word = hr ? (alone ? "Hazard" : "Haz. ratio") : "Coefficient";
  if (r?.note) ctx.out(r.note.padStart(w + 66));
  if (r) r.heads(ctx, w, "_t", word);
  else tableHead(ctx, "_t", level, word, false, false, w);
  layoutRows(
    session,
    f,
    baseLevelsAsked(o),
    (j) =>
      row("", model.b[j], Math.sqrt(model.V[j][j]), level, df, hr).slice(1),
    w,
    hr ? 1 : 0,
  ).forEach(ctx.out);
  const aux = model.auxiliary;
  if (aux) {
    const b = aux.b[0],
      se = Math.sqrt(aux.V[0][0]),
      z = df
        ? invttail(df, (1 - level / 100) / 2)
        : invnormal(1 - (1 - level / 100) / 2),
      plain = (label, value, error, low, high) =>
        `${label.padStart(w)} |${trimmed(value, "%9.0g").padStart(11)}${trimmed(error, "%9.0g").padStart(11)}${" ".repeat(17)}${trimmed(low, "%9.0g").padStart(13)}${trimmed(high, "%9.0g").padStart(12)}`;
    ctx.out(split(w));
    ctx.out(row(`${`/${aux.names[0]}`.padStart(w)} `, b, se, level, df));
    if (aux.names[0] === "ln_p") {
      const pv = Math.exp(b);
      ctx.out(split(w));
      ctx.out(
        plain("p", pv, pv * se, Math.exp(b - z * se), Math.exp(b + z * se)),
      );
      ctx.out(
        plain(
          "1/p",
          1 / pv,
          se / pv,
          Math.exp(-b - z * se),
          Math.exp(-b + z * se),
        ),
      );
    }
  }
  ctx.out(rule(w));
  if (hr && !alone) ctx.out("Note: _cons estimates baseline hazard.");
}

function stregReplay(session, tail, ctx) {
  const model = estimates(session);
  if (model.kind !== "streg")
    throw new StataError("last estimates not found", 301);
  const o = session.parse(
    "[, noHR TIme Level(cilevel) BASElevels ALLBASElevels]",
    `,${tail}`,
  ).options;
  if (model.streg.aft && o.hr === false)
    throw invalid("option nohr not allowed");
  ctx.out("");
  stregTable(session, ctx, model, o);
  // A fit that ran out of iterations stops its replay as it stopped.
  if (session.results.e?.rc === 430)
    throw new StataError("convergence not achieved", 430);
}

// ----- after stcox and streg -----
/**
 * The linear prediction of a survival model at observation i, without
 * the constant when the hazard ratio is asked for.
 */
function linearAt(model, i, constant = true) {
  let xb = 0;
  for (let j = 0; j < model.names.length; j++) {
    if (!model.estimable[j] || (!constant && model.names[j] === "_cons"))
      continue;
    const value = model.names[j] === "_cons" ? 1 : model.columns[j].value(i);
    if (isMissing(value)) return MISSING;
    xb += model.b[j] * value;
  }
  return xb;
}

function survivalPredict(session, text, ctx) {
  const declaration = `newvarname [if] [in] [, XB STDP HR SCHoenfeld SCAledsch | BASESurv BASEChazard BASEHC MGale CSNell DEViance ESR DFBeta LDisplace LMax EFFects Median MEAN Surv CHazard Hazard Time LNTime SCores PARTial]`,
    [head, tail] = splitAtComma(text),
    names = head.replace(/(^|\s)(if|in)\s[\s\S]*$/, "").trim(),
    qualifier = head.trim().slice(names.length),
    several = names.includes("*") || /\s/.test(names);
  // schoenfeld, scaledsch, esr, dfbeta and scores make a variable for each
  // covariate, named stub* or listed; such a list meets the refusal of
  // the statistic, not an error in the names.
  const statistic =
    tail === null
      ? {}
      : session.parse(declaration, `__predicted, ${tail}`).options;
  const model = estimates(session),
    cox = model.kind === "stcox";
  if (statistic.schoenfeld || statistic.scaledsch)
    return schoenfeldPredict(
      session,
      model,
      names,
      session.parse(
        declaration,
        `__predicted ${qualifier}${tail === null ? "" : `, ${tail}`}`,
      ),
      ctx,
    );
  // Several names for one statistic: Stata assumes hr first.
  if (
    several &&
    cox &&
    !["xb", "stdp", "hr"].some((name) => statistic[name]) &&
    !names.includes("*")
  )
    ctx.out("(option hr assumed; predicted hazard ratio)");
  const parsed = session.parse(declaration, text),
    o = parsed.options,
    asked = ["xb", "stdp", "hr"].filter((name) => o[name]);
  if (asked.length > 1) throw invalid("only one statistic may be specified");
  if (o.hr && !cox && model.streg.aft)
    throw notHere(
      "predict, hr after streg in the accelerated failure-time metric",
      "Fit the model without time to predict hazard ratios.",
    );
  let kind = asked[0];
  if (!kind) {
    if (!cox)
      throw notHere(
        "predict after streg without xb, stdp or hr",
        "predict, xb gives the linear prediction; median and mean survival times are not computed here yet.",
      );
    kind = "hr";
    ctx.out("(option hr assumed; predicted hazard ratio)");
  }
  const data = session.data,
    values = new Array(data.n).fill(MISSING),
    // streg's predictions (ereg_p, weibul_p, gomper_p) are made only where
    // _st is 1; stcox's everywhere the covariates are.
    st = cox ? null : data.get("_st")?.data;
  for (const i of session.rows(parsed, null)) {
    if (st && st[i] !== 1) continue;
    const xb = linearAt(model, i, kind !== "hr");
    if (isMissing(xb)) continue;
    if (kind === "xb") values[i] = xb;
    else if (kind === "hr") values[i] = Math.exp(xb);
    else {
      let v = 0;
      for (let a = 0; a < model.names.length; a++)
        for (let b = 0; b < model.names.length; b++) {
          if (!model.estimable[a] || !model.estimable[b]) continue;
          const xa = model.names[a] === "_cons" ? 1 : model.columns[a].value(i),
            xbv = model.names[b] === "_cons" ? 1 : model.columns[b].value(i);
          v += xa * model.V[a][b] * xbv;
        }
      values[i] = Math.sqrt(v);
    }
  }
  const name = parsed.varlist?.[0] ?? parsed.newvarlist?.[0] ?? parsed.anything,
    result = data.generate(name, values, {
      type: parsed.typed?.[0] ? parsed.types[0] : undefined,
    });
  if (result.missing)
    ctx.out(
      `(${result.missing} missing value${result.missing === 1 ? "" : "s"} generated)`,
    );
  data.get(name).label =
    kind === "xb"
      ? "Linear prediction"
      : kind === "hr"
        ? "Predicted hazard ratio"
        : "S.E. of the prediction";
}

/**
 * predict stub* or one name per covariate, schoenfeld or scaledsch after
 * stcox: the Schoenfeld residuals at each failure, or scaled, b + d V r
 * for d failures, as stcox_p makes them.
 */
function schoenfeldPredict(session, model, typedNames, parsed, ctx) {
  // A storage type may come first: predict double ss*, scaledsch.
  const typed = /^(byte|int|long|float|double)\s+([\s\S]*)$/.exec(typedNames),
    names = typed ? typed[2].trim() : typedNames,
    o = parsed.options,
    scaled = !!o.scaledsch;
  if (o.schoenfeld && o.scaledsch)
    throw invalid("only one statistic may be specified");
  if (model.kind !== "stcox")
    throw invalid(`option ${scaled ? "scaledsch" : "schoenfeld"} not allowed`);
  if (model.survival.method === "marginal")
    throw new StataError(
      "Schoenfeld residuals not available after estimation using option exactm or\nexactp with command stcox",
      322,
    );
  const k = model.names.length,
    stub = /^(\S+)\*$/.exec(names),
    list = stub
      ? Array.from({ length: k }, (_, j) => `${stub[1]}${j + 1}`)
      : names.split(/\s+/).filter(Boolean);
  if (!stub && names.includes("*")) throw invalid(`${names} invalid name`);
  // The names are checked before their number.
  const data = session.data;
  for (const name of list) {
    if (!/^[A-Za-z_]\w{0,31}$/.test(name))
      throw invalid(`${name} invalid name`);
    if (data.has(name))
      throw new StataError(`variable ${name} already defined`, 110);
  }
  if (list.length > k)
    throw new StataError(`you must specify ${k} new variables`, 103);
  if (list.length < k)
    throw list.length > 1
      ? new StataError(
          `too few variables specified\n${indented(
            `The current estimation results for {bf:cox} have ${k} equations so you must specify ${k} new variables, or you can use the equation() option and specify one variable at a time.`,
            4,
            session.settings.linesize ?? 79,
          )}`,
          102,
        )
      : new StataError(`you must specify ${k} new variables`, 102);
  const { theta, V, active } = model.survival,
    residuals = schoenfeld(model),
    failures = residuals.length,
    wanted = new Set(session.rows(parsed, null)),
    columns = list.map(() => new Array(data.n).fill(MISSING));
  for (const x of residuals) {
    const row = model.sample[x.i];
    if (!wanted.has(row)) continue;
    const r = scaled
      ? theta.map(
          (b, a) =>
            b + failures * V[a].reduce((t, v, c) => t + v * x.residual[c], 0),
        )
      : x.residual;
    // A covariate left out (a factor's base level) has a residual of 0.
    model.names.forEach((name, j) => {
      const a = active.indexOf(name);
      columns[j][row] = a >= 0 ? r[a] : 0;
    });
  }
  list.forEach((name, j) => {
    data.generate(name, columns[j], { type: typed ? typed[1] : "float" });
    data.get(name).label =
      `${scaled ? "Scaled Schoenfeld" : "Schoenfeld"} residual, ${model.names[j]}`;
  });
}

/**
 * A paragraph as SMCL's {p 4 4 2} lays out an error: indented, its lines
 * no wider than the line size, measured (as Stata does) with the markup
 * {bf:...} in them, which is then dropped.
 */
function indented(text, indent, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && indent + line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines
    .map((l) => `${" ".repeat(indent)}${l.replace(/\{bf:([^}]*)\}/g, "$1")}`)
    .join("\n");
}
/** Schoenfeld residuals at each failure, as stcox_p computes them. */
function schoenfeld(model) {
  const { T, T0, D, X, theta, method } = model.survival,
    n = T.length,
    k = theta.length,
    // Centred covariates, which leave the residuals as they are.
    means = new Array(k).fill(0);
  for (const x of X) x.forEach((v, a) => (means[a] += v / n));
  const Xc = X.map((x) => x.map((v, a) => v - means[a])),
    r = Xc.map((x) => Math.exp(x.reduce((a, v, j) => a + v * theta[j], 0))),
    byExit = [...Array(n).keys()].sort((a, b) => T[b] - T[a]),
    byEntry = [...Array(n).keys()].sort((a, b) => T0[b] - T0[a]),
    failing = new Map();
  for (const i of byExit)
    if (D[i]) {
      if (!failing.has(T[i])) failing.set(T[i], []);
      failing.get(T[i]).push(i);
    }
  const out = [],
    S1 = new Array(k).fill(0);
  let S0 = 0,
    pe = 0,
    pn = 0;
  const change = (i, sign) => {
    S0 += sign * r[i];
    for (let a = 0; a < k; a++) S1[a] += sign * r[i] * Xc[i][a];
  };
  for (const [time, dead] of failing) {
    while (pe < n && T[byExit[pe]] >= time) change(byExit[pe++], 1);
    while (pn < n && T0[byEntry[pn]] >= time) change(byEntry[pn++], -1);
    const d = dead.length;
    let mean;
    if (method === "efron" && d > 1) {
      let D0 = 0;
      const D1 = new Array(k).fill(0);
      for (const i of dead) {
        D0 += r[i];
        for (let a = 0; a < k; a++) D1[a] += r[i] * Xc[i][a];
      }
      mean = new Array(k).fill(0);
      for (let q = 0; q < d; q++) {
        const w = q / d,
          phi = S0 - w * D0;
        for (let a = 0; a < k; a++) mean[a] += (S1[a] - w * D1[a]) / phi / d;
      }
    } else mean = S1.map((v) => v / S0);
    for (const i of dead)
      out.push({ i, time, residual: Xc[i].map((v, a) => v - mean[a]) });
  }
  // In the order of the estimation sample, as Stata sums them.
  return out.sort((x, y) => x.i - y.i);
}

function phtest(session, text, ctx) {
  const model = estimates(session);
  if (model.kind !== "stcox")
    throw new StataError("last estimates not found", 301);
  // stphtest checks the estimation sample: observations of it dropped, or
  // a covariate changed in it, and the test is refused; a sort is not a
  // change.
  const changed =
    model.reducedSample ||
    !model.sample?.length ||
    (model.fitValues &&
      model.columns.some((c, k) =>
        model.sample.some((i, r) => {
          const now = c.value(i),
            then = model.fitValues[k][r];
          return now !== then && !(Number.isNaN(now) && Number.isNaN(then));
        }),
      ));
  if (changed) throw new StataError("data have changed since estimation", 459);
  const parsed = session.parse(
      "[, Detail KM LOG RANK | TIME(string) PLOT(string) USEOLDBASE]",
      text,
    ),
    o = parsed.options;
  if (["km", "log", "rank"].filter((name) => o[name]).length > 1)
    throw invalid(
      "may only specify one of options km, log, plot, rank, and time()",
    );
  if (model.survival.method === "marginal")
    throw new StataError(
      "Schoenfeld residuals not available after estimation using option exactm or\nexactp with command stcox",
      322,
    );
  const residuals = schoenfeld(model),
    { theta, V, T, T0, D, active } = model.survival,
    k = theta.length,
    failures = residuals.length;
  // The function of time the residuals are set against.
  let g, title;
  if (o.log) {
    g = residuals.map((x) => Math.log(x.time));
    title = "Log of analysis time";
  } else if (o.rank) {
    const times = residuals.map((x) => x.time),
      sorted = [...times].sort((a, b) => a - b);
    g = times.map((t) => {
      const first = sorted.indexOf(t),
        last = sorted.lastIndexOf(t);
      return (first + last) / 2 + 1;
    });
    title = "Rank of analysis time";
  } else if (o.km) {
    const table = survivor(
        countTable(
          T.map((_, j) => j),
          { t: T, t0: T0, d: D },
        ),
        95,
      ),
      before = new Map();
    let previous = 1;
    for (const r of table) {
      before.set(r.t, previous);
      previous = r.s;
    }
    g = residuals.map((x) => 1 - before.get(x.time));
    title = "1 - Kaplan–Meier estimate";
  } else {
    g = residuals.map((x) => x.time);
    title = "Analysis time";
  }
  const mean = g.reduce((a, b) => a + b, 0) / failures,
    centred = g.map((v) => v - mean),
    gden = centred.reduce((a, v) => a + v * v, 0),
    gv = new Array(k).fill(0);
  residuals.forEach((x, m) =>
    x.residual.forEach((v, a) => (gv[a] += centred[m] * v)),
  );
  ctx.out("");
  ctx.out("Test of proportional-hazards assumption");
  ctx.out("");
  ctx.out(`Time function: ${title}`);
  const detail = !!o.detail;
  ctx.out(`${"-".repeat(13)}${"-"}${"-".repeat(detail ? 42 : 34)}`);
  ctx.out(
    detail
      ? "             |        rho     chi2       df    Prob>chi2"
      : "             |     chi2       df       Prob>chi2",
  );
  ctx.out(`${"-".repeat(13)}+${"-".repeat(detail ? 42 : 34)}`);
  const matrix = [];
  if (detail) {
    // A row for each coefficient of e(b), base levels and omitted ones
    // shown missing.
    let a = -1;
    for (let j = 0; j < model.names.length; j++) {
      const shown = abbrev(model.names[j], 12);
      if (!model.estimable[j]) {
        matrix.push([MISSING, MISSING, 1, MISSING]);
        ctx.out(
          `${column(column(column(column(shown.padStart(12) + " |", 18) + fmt(MISSING, "%8.5f"), 26) + fmt(MISSING, "%9.2f"), 39) + fmt(1, "%5.0f"), 51)}${fmt(MISSING, "%5.4f")}`,
        );
        continue;
      }
      a++;
      // The scaled residuals: beta + d V s.
      const scaled = residuals.map(
          (x) =>
            theta[a] +
            failures * x.residual.reduce((t, v, b) => t + V[a][b] * v, 0),
        ),
        snum = scaled.reduce((t, v, m) => t + centred[m] * v, 0),
        chi2 = (snum * snum) / (failures * V[a][a] * gden),
        sm = scaled.reduce((t, v) => t + v, 0) / failures,
        sxy = scaled.reduce((t, v, m) => t + (v - sm) * centred[m], 0),
        sxx = scaled.reduce((t, v) => t + (v - sm) ** 2, 0),
        rho = sxy / Math.sqrt(sxx * gden),
        p = chi2tail(1, chi2),
        name = shown;
      matrix.push([rho, chi2, 1, p]);
      ctx.out(
        `${column(column(column(column(name.padStart(12) + " |", 18) + fmt(rho, "%8.5f"), 26) + fmt(chi2, "%9.2f"), 39) + fmt(1, "%5.0f"), 51)}${fmt(p, "%5.4f")}`,
      );
    }
    ctx.out(`${"-".repeat(13)}+${"-".repeat(42)}`);
  }
  const scale = failures / gden,
    chi2 = gv.reduce(
      (t, x, a) => t + x * gv.reduce((u, y, b) => u + scale * V[a][b] * y, 0),
      0,
    ),
    // The global test has the model's rank: none after a fit with no
    // failures, where Stata shows chi2 and its p missing.
    df = model.rank,
    p = chi2tail(df, chi2);
  if (detail) {
    ctx.out(
      `${column(column(column(" Global test |", 26) + fmt(chi2, "%9.2f"), 39) + fmt(df, "%5.0f"), 51)}${fmt(p, "%5.4f")}`,
    );
    ctx.out(`${"-".repeat(13)}-${"-".repeat(42)}`);
  } else {
    ctx.out(
      `${column(column(column(" Global test |", 15) + fmt(chi2, "%9.2f"), 28) + fmt(df, "%5.0f"), 43)}${fmt(p, "%5.4f")}`,
    );
    ctx.out(`${"-".repeat(13)}-${"-".repeat(34)}`);
  }
  session.results.r = {
    p,
    df,
    chi2,
    ...(detail
      ? {
          "matrix:phtest": {
            rowNames: model.names,
            colNames: ["rho", "chi2", "df", "p"],
            values: matrix,
          },
        }
      : {}),
  };
}

/**
 * estat concordance after stcox, as stcstat.ado computes Harrell's C:
 * the subjects in order of their predicted hazard ratio, every pair whose
 * order of failure is known (both failed at different times, or one failed
 * no later than the other's time) is usable; it is as expected when the
 * one that failed first has the higher hazard, and a tie in the hazards
 * counts a half. Somers' D is 2C - 1. Gönen and Heller's K is refused.
 */
function concordance(session, text, ctx) {
  const settings = stSettings(session),
    parsed = session.parse(
      "[if] [in] [, ALL noSHow Harrell USEADO | GHeller SE]",
      text,
    ),
    o = parsed.options,
    model = estimates(session);
  if (model.kind !== "stcox")
    throw new StataError("last estimates not found", 301);
  const data = session.data,
    esample = data.esample,
    rows = session.rows(parsed, null).filter((i) => {
      if (!o.all && esample?.[i] !== 1) return false;
      return !isMissing(linearAt(model, i, false));
    });
  if (data.chars?.get("_dta")?.get("st_w"))
    throw new StataError(
      "estat concordance may not be used with weighted data",
      498,
    );
  const t0 = data.get("_t0").data;
  if (rows.some((i) => t0[i] !== 0))
    throw new StataError(
      "estat concordance may not be used with late entry or time-varying data",
      498,
    );
  const h = new Map(rows.map((i) => [i, Math.exp(linearAt(model, i, false))])),
    ordered = [...rows].sort((a, b) => h.get(a) - h.get(b) || a - b),
    t = data.get("_t").data,
    d = data.get("_d").data,
    linesize = session.settings.linesize ?? 79;
  // Observations of the fit left out, or others taken in.
  const marked = esample
    ? Array.from(esample).reduce((n, v) => n + (v === 1 ? 1 : 0), 0)
    : 0;
  if (rows.length !== marked || rows.some((i) => esample?.[i] !== 1))
    renderSmcl(
      "{p 0 6 2}note: different samples used to fit model and to calculate C statistic.{p_end}",
      linesize,
    )
      .split("\n")
      .forEach((line) => ctx.out(line));
  stHeader(ctx, settings, o.show === false);
  ctx.out("");
  ctx.out("Harrell's C concordance statistic");
  let D = 0,
    T = 0,
    E = 0;
  const n = ordered.length;
  for (let a = 0; a < n; a++) {
    const i = ordered[a],
      ti = t[i],
      di = d[i] !== 0 && !isMissing(d[i]),
      hi = h.get(i);
    for (let b = a + 1; b < n; b++) {
      const j = ordered[b],
        tj = t[j],
        dj = d[j] !== 0 && !isMissing(d[j]);
      let kind = di && dj ? 1 : di && ti <= tj ? 2 : dj && ti >= tj ? 3 : 0;
      // Two failures at the same time are not compared.
      if (kind === 1 && Math.abs(tj - ti) < 1e-12) kind = 0;
      if (!kind) continue;
      const tied = hi === h.get(j);
      D++;
      if (tied) T++;
      else if ((kind === 1 && ti > tj) || (kind === 3 && ti >= tj)) E++;
    }
  }
  const C = (E + T / 2) / D,
    somers = 2 * (C - 0.5),
    wide = applyFormat(D, "%21.0f").trim(),
    digits = applyFormat(D, "%8.0f").trim() === wide ? 8 : wide.length,
    count = (v) => applyFormat(v, `%${digits}.0f`),
    fixed = (v) => applyFormat(v, `%${digits}.4f`),
    row = (label, value) => ctx.out(`${label.padEnd(37)} = ${value}`);
  ctx.out("");
  row("  Number of subjects (N)", count(n));
  row("  Number of comparison pairs (P)", count(D));
  row("  Number of orderings as expected (E)", count(E));
  row("  Number of tied predictions (T)", count(T));
  ctx.out("");
  row("          Harrell's C = (E + T/2) / P", fixed(C));
  row("                            Somers' D", fixed(somers));
  // As stcstat.ado returns them; return list shows the last first.
  session.results.r = { N: n, D: somers, C, n_P: D, n_E: E, n_T: T };
}

/**
 * predict and estat after stcox and streg: the forms survival computes.
 * Returns true when it handled the command.
 */
export function survivalPostestimation(session, name, text, ctx) {
  const model = session.estimates;
  if (!model || (model.kind !== "stcox" && model.kind !== "streg"))
    return false;
  if (name === "predict") {
    survivalPredict(session, text, ctx);
    return true;
  }
  const what = text.trim().split(/[\s,]/)[0];
  if (
    name === "estat" &&
    what &&
    "phtest".startsWith(what) &&
    what.length >= 3
  ) {
    if (model.kind !== "stcox")
      throw new StataError("last estimates not found", 301);
    phtest(session, text.trim().slice(what.length), ctx);
    return true;
  }
  if (
    name === "estat" &&
    what &&
    what.length >= 3 &&
    "concordance".startsWith(what) &&
    // After streg it is not valid, as estat says of what it lacks.
    model.kind === "stcox"
  ) {
    concordance(session, text.trim().slice(what.length), ctx);
    return true;
  }
  return false;
}

export const SURVIVAL_COMMANDS = withStyleNotes([
  { name: "stset", minimum: 5, run: stsetCommand },
  { name: "stdescribe", minimum: 5, run: stdescribe },
  { name: "stsum", minimum: 5, run: stsum },
  { name: "sts", minimum: 3, run: sts },
  { name: "stcox", minimum: 5, run: stcox },
  { name: "streg", minimum: 5, run: streg },
]);
