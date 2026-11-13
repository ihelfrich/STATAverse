// A Stata session: the dataset, macros, scalars, stored results and
// programs, and the control flow of a do-file. Commands themselves are in
// commands.js; this file decides which command runs, under which prefixes,
// and what happens when one fails.
import { Signal, StataError } from "./errors.js";
import { Dataset } from "./store.js";
import { splitCommands, parseBlocks } from "./dofile.js";
import { expandMacros, isMacroName, macroWords } from "./macros.js";
import { compileExpression } from "./expression.js";
import { applySyntax } from "./syntax.js";
import { parseNumlist } from "./numlist.js";
import { expandVarlist } from "./varlist.js";
import { applyFormat, stringOf } from "./format.js";
import { formatNumber } from "./values.js";
import { COMMANDS, extendedFunction } from "./commands.js";
import { changed } from "./data-commands.js";
import { timeSeriesOperator } from "./panel.js";
import { matrixAccess } from "./matrix.js";
import { coefficientIndex } from "./estimation.js";

const MAX_STEPS = 200000;
// c(current_date) in Stata's form, such as "10 Nov 2026".
function currentDate() {
  const now = new Date(),
    months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  return `${String(now.getDate()).padStart(2)} ${months[now.getMonth()]} ${now.getFullYear()}`;
}

// What r() holds after a command fails. Stata has no single rule: a built-in
// command (summarize, count, generate, list) leaves the previous r() alone,
// while most commands written as ado-files (ttest, ci, tabstat, regress, the
// graph commands) clear it, because an r-class program posts its results
// when it ends, failed or not, and others call an r-class helper first. That
// happens only once the command gets past its first checks, so the same
// return code can leave r() in one failure and clear it in another: an
// unknown variable usually fails before that point, a bad option or empty
// sample after it. Some leave the r(N) = 0 of the count they ran. Recorded
// from Stata 19 by making each command fail after summarize; a command not
// listed keeps r(). Each rule gets the return code and { body, error,
// session } and returns what r() becomes, or undefined to keep it.
const cleared = () => ({}),
  noObservations =
    (posted, otherwise = () => undefined) =>
    (code, failure) =>
      code === 2000 ? { ...posted } : otherwise(code, failure),
  // An unknown variable leaves r(); anything else clears it.
  unknownKeeps =
    (otherwise = cleared) =>
    (code, failure) =>
      code === 111 ? undefined : otherwise(code, failure),
  // The words before if, in, a weight or the options.
  varlistPart = (body) => body.split(/\s(?:if|in)\s|\[|,/)[0],
  // regress clears r() for an unknown variable in its varlist, but not for
  // one in if or in the weight.
  regressRule = (code, { body, session }) => {
    if (code !== 111) return {};
    const unknown = varlistPart(body)
      .split(/\s+/)
      .filter(Boolean)
      .some((word) => {
        const name = word.replace(/^.*\./, "").replace(/^\(|\)$/g, "");
        if (!/^[A-Za-z_]\w*\*?$/.test(name)) return false;
        try {
          session.varlist(name);
          return false;
        } catch {
          return true;
        }
      });
    return unknown ? {} : undefined;
  };
const FAILED_R = new Map([
  ...[
    "ttest",
    "ttesti",
    "ci",
    "pwcorr",
    "spearman",
    "prtest",
    "prtesti",
    "bitest",
    "bitesti",
    "signtest",
    "robvar",
    "sdtest",
    "ranksum",
    "signrank",
    "oneway",
    "kwallis",
    "tabi",
    "centile",
    "tabulate",
    "tabstat",
    "codebook",
    "ds",
    "describe",
    "lookfor",
    "duplicates",
    "separate",
    "split",
    "gsort",
    "insobs",
    "numlabel",
    "append",
    "import",
    "tsset",
    "xtsum",
    "dfuller",
    "corrgram",
    "tssmooth",
    "xtreg",
    "prais",
    "test",
    "testparm",
    "lincom",
    "nlcom",
    "testnl",
    "estat",
    "margins",
    "lrtest",
    "hausman",
    "bootstrap",
    "bs",
    "jackknife",
    "kdensity",
    "scatter",
    "line",
    "twoway",
    "graph",
    "avplot",
    "lvr2plot",
    "rvfplot",
    "tsline",
  ].map((name) => [name, cleared]),
  ["regress", regressRule],
  ...["tobit", "lowess", "qnorm", "pnorm"].map((name) => [
    name,
    unknownKeeps(),
  ]),
  // An unknown estimator such as ivregress zzfoo, and a replay with no
  // estimator, keep r() too.
  [
    "ivregress",
    unknownKeeps((code, { body }) =>
      code === 301 || (code === 198 && !/^\s*(2sls|liml|gmm)\b/.test(body))
        ? undefined
        : {},
    ),
  ],
  // A new variable that exists or is not a name keeps r(); a failure in the
  // function or its options clears it.
  [
    "egen",
    (code, { body }) => {
      const words = body.split("=")[0].trim().split(/\s+/),
        name = /^(byte|int|long|float|double|str\d+)$/.test(words[0])
          ? words[1]
          : words[0];
      return code === 110 ||
        (code === 198 && !/^[A-Za-z_]\w*$/.test(name ?? ""))
        ? undefined
        : {};
    },
  ],
  ["mean", noObservations({ N: 0 }, cleared)],
  ["proportion", noObservations({ N: 0 }, cleared)],
  ["areg", noObservations({ N: 0 }, cleared)],
  ["glm", noObservations({ N: 0, sum_w: 0, sum: 0 }, unknownKeeps())],
  ["correlate", noObservations({ N: 0 })],
  // The variance computation failing at an extreme quantile clears r().
  ["qreg", noObservations({ N: 0 }, (code) => (code === 498 ? {} : undefined))],
  ["cloglog", noObservations({ N: 0 })],
  ["poisson", noObservations({ N: 0, sum_w: 0, sum: 0 })],
  ["nbreg", noObservations({ N: 0, sum_w: 0, sum: 0 })],
  ...["logit", "logistic", "probit", "ologit", "oprobit", "mlogit"].map(
    (name) => [name, noObservations({})],
  ),
  // A misspelt option leaves r(); a missing variable or no data clears it.
  ["anova", (code) => (code === 198 ? undefined : {})],
  ["histogram", noObservations({ N: 0 }, unknownKeeps())],
  // A using file that is not there clears r(); an unknown key variable not.
  ["merge", (code) => (code === 601 ? {} : undefined)],
  // estimates restore of a name that was never stored clears r().
  [
    "estimates",
    (code, { body }) =>
      code === 111 && /^\s*res(t(o(re?)?)?)?\s/.test(body) ? {} : undefined,
  ],
]);

// Graph commands clear r() when they draw, as Stata's do; kdensity and
// avplot post their own results instead. graph clears it for the graphs it
// draws and for graph display, not for export, drop or dir.
const DRAWING_CLEARS_R = new Set([
  "scatter",
  "line",
  "twoway",
  "histogram",
  "lowess",
  "qnorm",
  "pnorm",
  "rvfplot",
  "lvr2plot",
  "tsline",
]);
const drawsGraph = (name, body) =>
  DRAWING_CLEARS_R.has(name) ||
  (name === "graph" &&
    /^\s*(tw(o(w(ay?)?)?)?|bar|hbar|box|hbox|dot|pie|di(s(p(l(ay?)?)?)?)?)\b/.test(
      body,
    ));

function findCommand(word) {
  return COMMANDS.find(
    (c) => word.length >= c.minimum && c.name.startsWith(word),
  );
}

export class Session {
  constructor() {
    this.data = new Dataset();
    this.scalars = new Map();
    this.results = { r: {}, e: {}, s: {} };
    this.globals = new Map();
    this.programs = new Map();
    this.settings = { level: 95, seed: 123456789 };
    this.preserved = [];
    this.rc = 0;
    this.steps = 0;
    this.temporary = 0;
    this.state = {};
  }

  // ----- expressions -----
  scope() {
    return {
      dataset: this.data,
      scalars: this.scalars,
      results: this.results,
      state: this.state,
      rc: () => this.rc,
      matrix: matrixAccess(this),
      coefficient: (kind, name) => {
        const model = this.estimates;
        // Without a model, Stata reports the name as not found.
        if (!model) throw new StataError(`[${name}] not found`, 111);
        const at = coefficientIndex(model, name);
        if (at < 0) throw new StataError(`[${name}] not found`, 111);
        return kind === "_b" ? model.b[at] : Math.sqrt(model.V[at][at]);
      },
      series: (operator, order, name) =>
        timeSeriesOperator(this, operator, order, name),
      system: (name) =>
        ({
          N: this.data.n,
          k: this.data.variables.length,
          level: this.settings.level,
          pi: Math.PI,
          type: this.data.defaultType,
          rc: this.rc,
          changed: Number(changed(this)),
          filename: this.data.filename ?? "",
          filedate: this.data.filedate ?? "",
          current_date: currentDate(),
          current_time: new Date().toTimeString().slice(0, 8),
          stata_version: 17,
          version: 17,
          os: "Browser",
          machine_type: "STATAverse",
          pwd: "/stataverse",
          dirsep: "/",
          rng: "default",
          rng_current: "mt64",
          linesize: this.settings.linesize ?? 80,
          more: "off",
          maxvar: 5000,
          alpha: "a b c d e f g h i j k l m n o p q r s t u v w x y z",
          ALPHA: "A B C D E F G H I J K L M N O P Q R S T U V W X Y Z",
          Mons: "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec",
        })[name],
      format: (args, { node, numeric, mismatch, invalid }) => {
        if (args.length < 1 || args.length > 2) throw invalid();
        const value = numeric(args[0]);
        if (args[1] && args[1].type !== "string") throw mismatch();
        const format = args[1]?.evaluate;
        // The format is evaluated before the value: Stata evaluates a
        // function's arguments last to first.
        return node("string", (i, env) => {
          const shown = format ? format(i, env) : undefined;
          return stringOf(value(i, env), shown);
        });
      },
    };
  }
  compile(text) {
    return compileExpression(text, this.scope());
  }
  /** The value of an expression outside any observation. */
  scalar(text) {
    return this.compile(text).evaluate(0, {
      start: 0,
      count: this.data.n,
      sums: [],
    });
  }
  /** Context for applySyntax; if and =exp are compiled so errors surface. */
  context() {
    return {
      names: this.data.names,
      types: Object.fromEntries(
        this.data.variables.map((v) => [v.name, v.type]),
      ),
      n: this.data.n,
      level: this.settings.level,
      defaultType: this.data.defaultType,
      expression: (text) => {
        this.compile(text);
      },
    };
  }
  parse(declaration, text) {
    return applySyntax(declaration, text, this.context());
  }
  varlist(text) {
    return expandVarlist(text, this.data.names);
  }

  /**
   * Calls visit(i, env) for each observation that passes if and in, group by
   * group. parsed is an applySyntax result; by is the by-prefix, if any.
   * parsed.only, a Set of row indices, further limits the rows; commands use
   * it to run a sub-model on another model's estimation sample.
   */
  select(parsed, by, visit) {
    if (by && parsed.in)
      throw new StataError("'in' may not be combined with 'by'", 190);
    const condition = parsed.if ? this.compile(parsed.if) : null;
    if (condition && condition.type !== "numeric")
      throw new StataError("type mismatch", 109);
    const [first, last] = parsed.in ?? [1, this.data.n],
      groups = by ? by.groups : [{ start: 0, count: this.data.n }];
    for (const group of groups) {
      const env = { start: group.start, count: group.count, sums: [] },
        testEnv = { start: group.start, count: group.count, sums: [] };
      for (let i = group.start; i < group.start + group.count; i++) {
        if (i < first - 1 || i > last - 1) continue;
        // A graph's by() draws each panel from its own rows.
        if (this.panelRows && !this.panelRows.has(i)) continue;
        if (parsed.only && !parsed.only.has(i)) continue;
        if (condition && condition.evaluate(i, testEnv) === 0) continue;
        visit(i, env, group);
      }
    }
  }
  rows(parsed, by) {
    const rows = [];
    this.select(parsed, by, (i) => rows.push(i));
    return rows;
  }
  /** Consecutive groups of equal values of the named variables. */
  groupsOf(names) {
    const columns = names.map((name) => this.data.get(name).data),
      groups = [];
    for (let i = 0; i < this.data.n; i++) {
      const last = groups.at(-1);
      if (last && columns.every((column) => column[i] === column[i - 1]))
        last.count++;
      else groups.push({ start: i, count: 1 });
    }
    return groups;
  }

  // ----- running -----
  /**
   * Runs do-file text. Returns { output, rc }, where output has one entry
   * per executed command: { command, lines, rc }.
   */
  run(source) {
    const output = [],
      frame = this.frame();
    this.steps = 0;
    this.line = 0;
    this.inProgram = 0;
    let rc = 0;
    try {
      this.runNodes(parseBlocks(splitCommands(source)), frame, output);
    } catch (error) {
      if (error instanceof Signal && error.kind === "exit") rc = error.code;
      else if (error instanceof Signal) rc = 0;
      else if (error instanceof StataError) rc = error.code;
      else throw error;
    }
    return { output, rc, locals: frame.locals };
  }
  frame() {
    return { locals: new Map(), lastIf: null, returns: null };
  }
  macroEnv(frame) {
    return {
      locals: frame.locals,
      globals: this.globals,
      evaluate: (text) => {
        const value = this.scalar(text);
        return typeof value === "string"
          ? value
          : applyFormat(value, "%18.0g").trim();
      },
      extended: (text) => extendedFunction(this, frame, text),
      result: (kind, name) => {
        if (kind === "c") return this.scope().system(name) ?? "";
        const value = this.results[kind]?.[name];
        if (value === undefined) return "";
        return typeof value === "string"
          ? value
          : applyFormat(value, "%18.0g").trim();
      },
    };
  }
  expand(text, frame) {
    return expandMacros(text, this.macroEnv(frame));
  }

  runNodes(nodes, frame, output) {
    for (let k = 0; k < nodes.length; k++) {
      const node = nodes[k];
      // The line of the do-file being run; not of a program or another file.
      if (!this.doDepth && !this.inProgram) this.line = node.line;
      if (++this.steps > MAX_STEPS)
        throw new StataError(
          "this do-file ran more commands than the browser allows",
          901,
        );
      if (node.kind === "program") {
        if (this.programs.has(node.name))
          throw new StataError(`program ${node.name} already defined`, 110);
        this.programs.set(node.name, {
          body: parseBlocks(node.body),
          options: node.options,
        });
      } else if (node.kind === "input") this.input(node, frame, output);
      else if (node.kind === "block") this.runBlock(node, frame, output);
      else this.runLine(node.text, frame, output);
    }
  }

  record(output, command, lines, rc, graph, line = this.line) {
    const entry = { command, lines, rc };
    if (graph) entry.graph = graph;
    if (line) entry.line = line;
    output.push(entry);
  }

  /** One command line, with its prefixes. Errors stop the run unless captured. */
  runLine(raw, frame, output, inherited = {}) {
    const text = this.expand(raw, frame).trim();
    if (!text) return;
    const at = this.line,
      lines = [],
      flags = { quiet: false, capture: false, by: null, ...inherited };
    try {
      this.dispatch(text, frame, flags, lines, output);
    } catch (error) {
      if (!(error instanceof StataError)) {
        if (error instanceof Signal) {
          this.record(output, raw, lines, 0, undefined, at);
          throw error;
        }
        throw error;
      }
      if (flags.capture) {
        this.rc = error.code;
        this.record(
          output,
          raw,
          flags.noisy
            ? [...lines, ...(error.message ? [error.message] : [])]
            : [],
          0,
          undefined,
          at,
        );
        return;
      }
      this.record(
        output,
        raw,
        [
          ...lines,
          ...(error.message ? [error.message] : []),
          `r(${error.code});`,
        ],
        error.code,
        undefined,
        at,
      );
      throw error;
    }
    if (flags.capture) this.rc = 0;
    // quietly silences text, not graphs.
    this.record(
      output,
      raw,
      flags.quiet || (flags.capture && !flags.noisy) ? [] : lines,
      0,
      flags.graph,
      at,
    );
  }

  dispatch(text, frame, flags, lines, output) {
    let rest = text;
    for (;;) {
      const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest)?.[0] ?? "";
      const after = rest.slice(word.length);
      if (/^cap(t(u(re?)?)?)?$/.test(word)) {
        flags.capture = true;
        rest = after.trim();
      } else if (/^qui(e(t(ly?)?)?)?$/.test(word)) {
        flags.quiet = true;
        rest = after.trim();
      } else if (/^n(o(i(s(i(ly?)?)?)?)?)?$/.test(word) && word.length <= 7) {
        flags.quiet = false;
        flags.noisy = true;
        rest = after.trim();
      } else if (/^(by|bys(o(rt?)?)?)$/.test(word) && /:/.test(after)) {
        const colon = after.indexOf(":");
        flags.by = this.byPrefix(after.slice(0, colon), word !== "by");
        rest = after.slice(colon + 1).trim();
      } else if (/^vers(i(on?)?)?$/.test(word) && /^\s+[\d.]+\s*:/.test(after))
        rest = after.replace(/^\s+[\d.]+\s*:/, "").trim();
      else break;
      rest = rest.replace(/^:\s*/, "");
    }
    if (!rest) return;
    const word = /^[A-Za-z_#][A-Za-z_0-9]*/.exec(rest)?.[0];
    if (!word)
      throw new StataError(
        `${rest.split(/\s/)[0]} is not a valid command name`,
        199,
      );
    const body = rest.slice(word.length).replace(/^\s+/, ""),
      ctx = {
        frame,
        by: flags.by,
        out: (line) => lines.push(line),
        // Every graph is kept by its name(), or as Graph, for graph combine,
        // display, dir, rename and drop. nodraw keeps it without showing it.
        graph: (picture) => {
          const named = /\bname\(\s*([A-Za-z_]\w*)\s*(,\s*replace\s*)?\)/.exec(
              body,
            ),
            name = named?.[1] ?? "Graph";
          this.graphs ??= new Map();
          if (named && !named[2] && this.graphs.has(name))
            throw new StataError(`graph ${name} already exists`, 110);
          this.graphs.set(name, picture);
          if (!/,[\s\S]*\bnodraw\b/.test(body)) flags.graph = picture;
        },
        output,
        flags,
      };
    const command = findCommand(word);
    if (command) {
      // With no observations there are no groups, and by runs nothing:
      // even generate creates no variable.
      if (flags.by && !flags.by.groups.length && command.byable) return;
      if (flags.by && !command.byable)
        throw new StataError(
          `${command.name} may not be combined with by`,
          190,
        );
      let value;
      try {
        value = command.run(this, body, ctx);
      } catch (error) {
        if (error instanceof StataError) {
          const left = FAILED_R.get(command.name)?.(error.code, {
            body,
            error,
            session: this,
          });
          if (left) this.results.r = left;
        }
        throw error;
      }
      if (drawsGraph(command.name, body)) this.results.r = {};
      return value;
    }
    if (this.programs.has(word)) return this.call(word, body, ctx);
    throw new StataError(`command ${word} is unrecognized`, 199);
  }

  byPrefix(text, sort) {
    const m = /^\s*([^(,]*?)\s*(?:\(([^)]*)\))?\s*(?:,\s*(\w+))?\s*$/.exec(
      text,
    );
    if (!m) throw new StataError("invalid by prefix", 198);
    if (m[3] && !/^s(o(rt?)?)?$/.test(m[3]))
      throw new StataError(`option ${m[3]} not allowed`, 198);
    const keys = this.varlist(m[1]),
      extra = m[2] ? this.varlist(m[2]) : [];
    if (!keys.length) throw new StataError("varlist required", 100);
    const all = [...keys, ...extra];
    const already = all.every((name, k) => this.data.sortedBy[k] === name);
    // Data already in this order are left alone, keeping any further keys.
    if (sort || m[3]) {
      if (!already) this.data.sort(all);
    } else if (!all.every((name, k) => this.data.sortedBy[k] === name))
      throw new StataError("not sorted", 5);
    return { keys, groups: this.groupsOf(keys) };
  }

  runBlock(node, frame, output) {
    const header = this.expand(node.header, frame).trim();
    let m;
    const body = () => this.runNodes(node.body, frame, output);
    const loop = (iterate) => {
      try {
        iterate();
      } catch (error) {
        if (!(error instanceof Signal && error.kind === "break")) throw error;
      }
    };
    const once = () => {
      try {
        body();
      } catch (error) {
        if (!(error instanceof Signal && error.kind === "continue"))
          throw error;
      }
    };
    if ((m = /^foreach\s+(\S+)\s+(in|of)\s+(.*)$/.exec(header))) {
      if (!isMacroName(m[1])) throw new StataError(`${m[1]} invalid name`, 198);
      const items = this.foreachList(m[2], m[3], frame);
      loop(() => {
        for (const item of items) {
          frame.locals.set(m[1], item);
          once();
        }
      });
      // The loop macro does not outlive the loop.
      frame.locals.delete(m[1]);
    } else if (
      (m = /^forv(?:a(?:l(?:u(?:es?)?)?)?)?\s+(\S+)\s*=\s*(.*)$/.exec(header))
    ) {
      if (!isMacroName(m[1])) throw new StataError(`${m[1]} invalid name`, 198);
      // forvalues counts upward through a/b; unlike a numlist, 5/1 is empty.
      const range = /^\s*(\S+)\s*\/\s*(\S+)\s*$/.exec(m[2]),
        values = range
          ? Number(range[1]) > Number(range[2])
            ? []
            : parseNumlist(`${range[1]}(1)${range[2]}`)
          : parseNumlist(m[2]);
      loop(() => {
        for (const value of values) {
          frame.locals.set(m[1], formatNumber(value));
          once();
        }
      });
      frame.locals.delete(m[1]);
    } else if ((m = /^while\s+(.*)$/.exec(header))) {
      loop(() => {
        while (this.truth(this.expand(node.header, frame).trim().slice(5))) {
          if (++this.steps > MAX_STEPS)
            throw new StataError(
              "this loop ran longer than the browser allows",
              901,
            );
          once();
        }
      });
    } else if ((m = /^if\s+(.*)$/.exec(header))) {
      // The outcome is recorded after the body runs, so that an if inside
      // the body cannot decide whether this block's else runs.
      const taken = this.truth(m[1]);
      if (taken) body();
      frame.lastIf = taken;
    } else if ((m = /^else(?:\s+if\s+(.*))?$/.exec(header))) {
      if (frame.lastIf === null) throw new StataError("else without if", 198);
      if (!frame.lastIf) {
        const taken = m[1] === undefined ? true : this.truth(m[1]);
        if (taken) body();
        frame.lastIf = taken;
      }
    } else if (
      /^(cap(t(u(re?)?)?)?|qui(e(t(ly?)?)?)?|n(o(i(s(i(ly?)?)?)?)?)?)(\s+(cap(t(u(re?)?)?)?|qui(e(t(ly?)?)?)?|n(o(i(s(i(ly?)?)?)?)?)?))*$/.test(
        header,
      )
    ) {
      const capture = /\bcap/.test(header),
        quiet = /\bqui/.test(header) || (capture && !/\bn/.test(header)),
        inner = [];
      try {
        this.runNodes(node.body, frame, inner);
        if (capture) this.rc = 0;
      } catch (error) {
        if (!(error instanceof StataError) || !capture) {
          if (!quiet) for (const entry of inner) output.push(entry);
          throw error;
        }
        this.rc = error.code;
      }
      if (!quiet) for (const entry of inner) output.push(entry);
    } else
      throw new StataError(`${header.split(/\s/)[0]} { is not supported`, 199);
  }

  truth(text) {
    const value = this.scalar(text);
    if (typeof value === "string") throw new StataError("type mismatch", 109);
    return value !== 0;
  }

  foreachList(keyword, text, frame) {
    if (keyword === "in") return macroWords(text).map((w) => w.text);
    const m = /^(\w+)\s*(.*)$/.exec(text);
    if (!m) throw new StataError("invalid syntax", 198);
    const [, kind, rest] = m;
    if (/^loc(al?)?$/.test(kind))
      return macroWords(frame.locals.get(rest.trim()) ?? "").map((w) => w.text);
    if (/^glo(b(al?)?)?$/.test(kind))
      return macroWords(this.globals.get(rest.trim()) ?? "").map((w) => w.text);
    if (/^var(l(i(st?)?)?)?$/.test(kind)) return this.varlist(rest);
    if (/^new(l(i(st?)?)?)?$/.test(kind))
      return rest.split(/\s+/).filter(Boolean);
    if (/^num(l(i(st?)?)?)?$/.test(kind))
      return parseNumlist(rest).map(formatNumber);
    throw new StataError(`foreach ... of ${kind} is not supported`, 198);
  }

  // ----- programs -----
  call(name, argumentsText, ctx) {
    const program = this.programs.get(name),
      frame = this.frame();
    // `0' is what the caller typed; `1', `2', ... are its words.
    frame.locals.set("0", argumentsText);
    macroWords(argumentsText).forEach((word, k) =>
      frame.locals.set(String(k + 1), word.text),
    );
    frame.program = { name, options: program.options, by: ctx.by };
    // What return scalar, local and add have set, posted as r() at the end.
    frame.returns = { r: {} };
    const inner = [],
      rclass = /\brclass\b/.test(program.options);
    this.inProgram = (this.inProgram ?? 0) + 1;
    try {
      this.runNodes(program.body, frame, inner);
    } catch (error) {
      this.inProgram -= 1;
      for (const record of inner) record.lines.forEach(ctx.out);
      // An r-class program posts what it has returned so far even when it
      // fails, as Stata does: r() is then empty or holds only those values.
      // A plain exit is the program's normal end. e() and s() need nothing
      // here: ereturn and sreturn set them as they run, so they survive a
      // failure, and an estimation command run inside keeps what it posted.
      const exit = error instanceof Signal && error.kind === "exit";
      if (rclass && (exit || error instanceof StataError))
        this.results.r = frame.returns.r;
      if (exit && error.code) throw new StataError("", error.code);
      if (!exit) throw error;
      return;
    }
    this.inProgram -= 1;
    for (const record of inner) record.lines.forEach(ctx.out);
    if (rclass) this.results.r = frame.returns.r;
  }

  // ----- data entry -----
  input(node, frame, output) {
    const header = this.expand(node.text, frame).replace(/^inp(ut?)?\s*/, ""),
      specs = [];
    let type = null;
    for (const token of header.split(/\s+/).filter(Boolean)) {
      if (/^(byte|int|long|float|double|str\d*|strL)$/.test(token))
        type = token;
      else {
        specs.push({ name: token, type });
        type = null;
      }
    }
    const fresh = specs.filter((s) => !this.data.has(s.name));
    if (fresh.length !== specs.length && fresh.length)
      throw new StataError("input may not mix new and existing variables", 198);
    const rows = node.rows.map((row) => macroWords(this.expand(row, frame)));
    const start = fresh.length ? 0 : this.data.n;
    if (
      fresh.length &&
      this.data.variables.length &&
      rows.length !== this.data.n
    )
      throw new StataError("input must supply every observation", 198);
    if (!this.data.variables.length || !fresh.length)
      this.data.setObservations(start + rows.length);
    specs.forEach((spec, k) => {
      const text = spec.type ? /^str/.test(spec.type) : false,
        values = rows.map((row) => {
          const cell = row[k];
          if (text) return cell?.text ?? "";
          if (!cell) return this.scalar(".");
          const value = this.scalar(cell.text);
          if (typeof value === "string")
            throw new StataError(
              `'${cell.text}' cannot be read as a number`,
              198,
            );
          return value;
        });
      if (fresh.length)
        this.data.generate(spec.name, values, {
          type: spec.type && spec.type !== "str" ? spec.type : undefined,
          string: text,
        });
      else {
        const all = Array.from(this.data.get(spec.name).data);
        values.forEach((v, i) => (all[start + i] = v));
        this.data.replace(
          spec.name,
          all,
          values.map((_, i) => start + i),
        );
      }
    });
    this.record(output, node.text, [], 0);
  }
}
