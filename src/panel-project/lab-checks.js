// The checks behind each step of the project lab. A check looks at the
// session itself: whether a variable exists, where it is missing, how many
// rows meet a condition, which estimator the last model used. None of them
// compares a result with a number recorded from the bundled panel, so the
// same checks hold on a student's own file.
//
// gatherFacts asks a session (in the lab, inside its worker) for what a
// step's checks need; assess turns those facts into the list a student
// reads. The facts are plain data, so they cross from the worker to the page.
//
// Rows are counted through the data browser's view of the session, which
// leaves r() as the student's commands left it, and results are read with
// display, which does the same.
import { EXPECTED_COLUMNS } from "./lab-steps.js";

const count = (n) => Number(n).toLocaleString("en-US");
const rows = (n, one = "row", many = "rows") =>
  `${count(n)} ${n === 1 ? one : many}`;
const VICE = 'regexm(lower(titleann), "vice[ -]*chair")';
const BIG4 =
  'regexm(lower(auditor_name), "deloitte|ernst|young|kpmg|pricewaterhouse|pwc")';
const MODEL_VARIABLES = [
  "dual_proxy",
  "turnover",
  "positive_cfo",
  "size",
  "lev",
  "roa",
  "loss",
  "big4",
  "industry2",
];
const INELIGIBLE = `(${MODEL_VARIABLES.map((name) => `missing(${name})`).join(
  " | ",
)} | fin_util != 0 | match_exec != 3 | match_audit != 3 | nas >= .)`;
const RATIOS = ["turnover", "lev", "roa"];
/** The fee in millions or in dollars: a Poisson model's slopes are the same. */
const FEES = ["nas_m", "nas"];
const CONTROLS = ["size", "lev", "roa", "loss", "big4"];

/** What a session can be asked, without changing it. */
function asker(session) {
  const tell = (source) => {
    const ran = session.run(source);
    return ran.rc
      ? null
      : ran.output
          .flatMap((record) => record.lines)
          .join("")
          .trim();
  };
  const ask = {
    variables() {
      return session.peek({ count: 0 }).columns.map((column) => ({
        name: column.name,
        type: column.type,
        format: column.format,
      }));
    },
    /** How many rows meet a condition; null when it cannot be evaluated. */
    count(condition) {
      try {
        return session.peek({ where: `if ${condition}`, count: 0 }).shown;
      } catch {
        return null;
      }
    },
    /** What display prints for its arguments; null when it fails. */
    show: (args) => tell(`display ${args}`),
    number(expression) {
      const text = tell(`display %24.16e (${expression})`);
      if (text === null || text === "" || text.startsWith(".")) return null;
      const value = Number(text);
      return Number.isFinite(value) ? value : null;
    },
    /** The values of a variable at given ranks (from 0) among the rows that meet a condition. */
    ordered(name, condition, from, howMany, descending = false) {
      try {
        const page = session.peek({
          where: `${name} if (${condition}) & ${name} < .`,
          order: { name, descending },
          from,
          count: howMany,
        });
        return { n: page.shown, values: page.rows.map((row) => row.raw[0]) };
      } catch {
        return null;
      }
    },
    /** The smallest and largest values. */
    range(name, condition) {
      const low = ask.ordered(name, condition, 0, 1),
        high = ask.ordered(name, condition, 0, 1, true);
      if (!low || !high || !low.n) return null;
      return { n: low.n, min: low.values[0], max: high.values[0] };
    },
    /** Percentiles as _pctile defines them. */
    percentiles(name, condition, wanted) {
      const all = ask.ordered(name, condition, 0, 0);
      if (!all || !all.n) return null;
      const n = all.n,
        values = wanted.map((p) => {
          const position = (n * p) / 100,
            whole = Math.floor(position),
            at = (k) =>
              ask.ordered(name, condition, Math.min(n, Math.max(1, k)) - 1, 1)
                .values[0];
          return position > whole
            ? at(whole + 1)
            : (at(whole) + at(whole + 1)) / 2;
        });
      return { n, values };
    },
    /** The model on top: what fitted it and on how many rows. */
    model(coefficients = []) {
      const said = ask.show(
        "\"`e(cmd)'|`e(depvar)'|`e(vce)'|`e(clustvar)'|`e(absvar)'|`e(model)'\"",
      );
      if (said === null) return null;
      const [cmd, depvar, vce, clustvar, absvar, kind] = said.split("|");
      if (!cmd) return null;
      return {
        cmd,
        depvar,
        vce,
        clustvar,
        absvar,
        kind,
        cmdline: ask.show('"`e(cmdline)\'"') ?? "",
        columns: ask.columns(),
        N: ask.number("e(N)"),
        clusters: ask.number("e(N_clust)"),
        b: Object.fromEntries(
          coefficients.map((name) => [name, ask.number(`_b[${name}]`)]),
        ),
      };
    },
    /**
     * A stored model, read by making it the one on top for a moment. The
     * model that was on top is put back.
     */
    stored(name, coefficients = [], extra = null) {
      return session.holding(() => {
        const HOLD = "lab_hold_",
          held = session.run(`estimates store ${HOLD}`).rc === 0;
        let model = null;
        if (session.run(`estimates restore ${name}`).rc === 0) {
          model = ask.model(coefficients);
          if (model && extra) Object.assign(model, extra(model));
        }
        if (held) {
          session.run(`estimates restore ${HOLD}`);
          session.run(`estimates drop ${HOLD}`);
        }
        return model;
      });
    },
    /** The names of the columns of e(b) of the model on top. */
    columns() {
      const said = ask.show('"`: colfullnames e(b)\'"');
      return said ? said.split(/\s+/).filter(Boolean) : [];
    },
    /**
     * The p-value of a test of the model on top, run and then forgotten:
     * r() is put back as the student's commands left it.
     */
    testP(terms) {
      return session.holding(() =>
        session.run(`quietly test ${terms}`).rc === 0
          ? ask.number("r(p)")
          : null,
      );
    },
  };
  return ask;
}

const GATHER = {
  meet: (ask) => ({
    n: ask.count("1"),
    panel: ask.show("\"`: char _dta[_TSpanel]'|`: char _dta[_TStvar]'\""),
  }),
  lag: (ask) => ({
    present: ask.count("lag_at < ."),
    differs: ask.count("lag_at != L.at"),
    declared: ask.count("L.fyear < . | 1") !== null,
  }),
  window: (ask) => ({
    n: ask.count("1"),
    inWindow: ask.count("fyear >= 2005 & fyear <= 2023"),
    outside: ask.count("fyear < 2005 | fyear > 2023"),
    first: ask.count("fyear == 2005"),
    firstLagged: ask.count("fyear == 2005 & lag_at < ."),
  }),
  outcome: (ask) => ({
    negative: ask.count("nas < 0"),
    invented: ask.count(
      "nas < . & !(non_audit_fees >= 0 & non_audit_fees < .)",
    ),
    lost: ask.count("missing(nas) & non_audit_fees >= 0 & non_audit_fees < ."),
    changed: ask.count("nas < . & nas != non_audit_fees"),
    logWrong: ask.count(
      "lnnas < . & (!(nas > 0 & nas < .) | abs(lnnas - ln(nas)) > 1e-6)",
    ),
    logLost: ask.count("missing(lnnas) & nas > 0 & nas < ."),
    zeros: ask.count("nas == 0"),
    logs: ask.count("lnnas < ."),
  }),
  titles: (ask) => ({
    other: ask.count("dual_proxy < . & dual_proxy != 0 & dual_proxy != 1"),
    blank: ask.count('dual_proxy < . & strtrim(titleann) == ""'),
    vice: ask.count(`dual_proxy < . & ${VICE}`),
    missed: ask.count(
      `dual_proxy == 0 & strpos(lower(titleann), "chair") > 0 & !${VICE}`,
    ),
    wrong: ask.count('dual_proxy == 1 & strpos(lower(titleann), "chair") == 0'),
    lost: ask.count(`missing(dual_proxy) & strtrim(titleann) != "" & !${VICE}`),
    ones: ask.count("dual_proxy == 1"),
    zeros: ask.count("dual_proxy == 0"),
  }),
  ratios: (ask) => ({
    undefinedRows: ask.count(
      "turnover < . & !(at > 0 & at < . & lag_at > 0 & lag_at < .)",
    ),
    lost: ask.count(
      "missing(turnover) & sale < . & at > 0 & at < . & lag_at > 0 & lag_at < .",
    ),
    wrong: ask.count(
      "turnover < . & at > 0 & at < . & lag_at > 0 & lag_at < . & abs(turnover - sale/((at + lag_at)/2)) > 1e-6 * max(1, abs(turnover))",
    ),
    present: ask.count("turnover < ."),
    cashMissing: ask.count("positive_cfo < . & oancf >= ."),
    cashWrong: ask.count("oancf < . & positive_cfo != (oancf > 0)"),
  }),
  controls: (ask) => ({
    size: ask.count(
      "(at > 0 & at < .) != (size < .) | (size < . & abs(size - ln(at)) > 1e-6)",
    ),
    lev: ask.count(
      "(at > 0 & at < . & dltt < .) != (lev < .) | (lev < . & abs(lev - dltt/at) > 1e-6 * max(1, abs(lev)))",
    ),
    roa: ask.count(
      "(at > 0 & at < . & ni < .) != (roa < .) | (roa < . & abs(roa - ni/at) > 1e-6 * max(1, abs(roa)))",
    ),
    lossMissing: ask.count("loss < . & ni >= ."),
    lossWrong: ask.count("ni < . & loss != (ni < 0)"),
    bigBlank: ask.count('big4 < . & strtrim(auditor_name) == ""'),
    bigLost: ask.count('missing(big4) & strtrim(auditor_name) != ""'),
    bigMissed: ask.count(`big4 == 0 & ${BIG4}`),
    bigWrong: ask.count(`big4 == 1 & !${BIG4}`),
    industry: ask.count(
      "(sich >= 100 & sich <= 9999) != (industry2 < .) | (industry2 < . & industry2 != floor(sich/100))",
    ),
    flag: ask.count(
      "fin_util != ((sich >= 6000 & sich <= 6999) | (sich >= 4900 & sich <= 4999))",
    ),
  }),
  sample: (ask) => ({
    eligibleOther: ask.count("eligible != 0 & eligible != 1"),
    baselineOther: ask.count("baseline_sample != 0 & baseline_sample != 1"),
    eligibleWrong: ask.count(`eligible == 1 & ${INELIGIBLE}`),
    eligibleLost: ask.count(`eligible != 1 & !${INELIGIBLE}`),
    baselineWrong: ask.count(
      "baseline_sample == 1 & !(eligible == 1 & nas > 0 & nas < .)",
    ),
    baselineLost: ask.count(
      "baseline_sample != 1 & eligible == 1 & nas > 0 & nas < .",
    ),
    n: ask.count("1"),
    both: ask.count("match_exec == 3 & match_audit == 3"),
    industrial: ask.count("match_exec == 3 & match_audit == 3 & fin_util == 0"),
    eligible: ask.count("eligible == 1"),
    zero: ask.count("eligible == 1 & nas == 0"),
    baseline: ask.count("baseline_sample == 1"),
  }),
  winsorize: (ask) => ({
    ratios: Object.fromEntries(
      RATIOS.map((name) => {
        const raw = `${name}_raw`,
          sample = "baseline_sample == 1",
          cut = ask.percentiles(raw, sample, [1, 99]);
        if (!cut) return [name, null];
        const [low, high] = cut.values,
          literal = (x) => x.toPrecision(17);
        return [
          name,
          {
            n: cut.n,
            low,
            high,
            capped: ask.range(name, sample),
            raw: ask.range(raw, sample),
            moved: ask.count(`${sample} & ${name} != ${raw}`),
            inside: ask.count(
              `${sample} & ${name} != ${raw} & ${raw} >= ${literal(low)} & ${raw} <= ${literal(high)}`,
            ),
          },
        ];
      }),
    ),
    millions: ask.count(
      "(nas < .) != (nas_m < .) | (nas_m < . & abs(nas_m - nas/1000000) > 1e-9 * max(1, abs(nas_m)))",
    ),
  }),
  baseline: (ask) => ({
    // What test left behind is read before anything else.
    testTerms: ask.number("r(df)"),
    testP: ask.number("r(p)"),
    // The test the step asks for, made again on the same model, to see
    // whether the student's was that one.
    expectedP: ask.testP("turnover positive_cfo"),
    model: ask.model(["dual_proxy", "turnover", "positive_cfo", ...CONTROLS]),
    baseline: ask.count("baseline_sample == 1"),
  }),
  robustness: (ask) => ({
    baselineRows: ask.count("baseline_sample == 1"),
    eligible: ask.count("eligible == 1"),
    zero: ask.count("eligible == 1 & nas == 0"),
    dateOther: ask.count("date_ok < . & date_ok != 0 & date_ok != 1"),
    dated: ask.count("baseline_sample == 1 & date_ok == 1"),
    baseline: ask.stored("baseline", ["dual_proxy", "turnover"]),
    firm_fe: ask.stored("firm_fe", ["dual_proxy", "turnover"]),
    all_fees: ask.stored("all_fees", ["dual_proxy", "turnover"]),
    date_screen: ask.stored("date_screen", ["dual_proxy", "turnover"]),
    uncapped: ask.stored("uncapped", [
      "dual_proxy",
      "turnover_raw",
      "lev_raw",
      "roa_raw",
    ]),
  }),
  extension: (ask) => ({
    other: ask.count("any_fee < . & any_fee != 0 & any_fee != 1"),
    wrong: ask.count(
      "(eligible == 1) != (any_fee < .) | (any_fee < . & any_fee != (nas > 0))",
    ),
    baselineRows: ask.count("baseline_sample == 1"),
    buys: ask.stored("buys"),
    amount: ask.stored("amount"),
  }),
};

/**
 * What some steps' checks need to know about the session as it stood when
 * the step began, gathered before the student's lines run.
 */
const BEFORE = {
  window: (ask) => ({ inWindow: ask.count("fyear >= 2005 & fyear <= 2023") }),
};

/** The facts of a step's start, or null when the step needs none. */
export function gatherBefore(session, id) {
  return BEFORE[id]?.(asker(session)) ?? null;
}

/**
 * What a step's checks need to know about a session. `ran` is the commands
 * of the student's run, each { command, rc }; `before` is what
 * gatherBefore found when the step began, if anything.
 */
export function gatherFacts(session, id, ran = [], before = null) {
  const ask = asker(session);
  return {
    variables: ask.variables(),
    ran: ran.map(({ command, rc }) => ({ command, rc })),
    before,
    ...GATHER[id](ask),
  };
}

// ----- from facts to what the student reads -----

function checker(facts) {
  const list = [],
    names = new Map(facts.variables.map((v) => [v.name, v]));
  return {
    list,
    has: (name) => names.has(name),
    /**
     * One check. `needs` names variables that must exist first; a check
     * whose variables are not there says so and is not otherwise made.
     */
    add(label, { needs = [], ok, why = "", advisory = false }) {
      const absent = needs.filter((name) => !names.has(name));
      if (absent.length)
        return list.push({
          label,
          ok: false,
          advisory,
          why: `${absent.map((name) => `<code>${name}</code>`).join(" and ")} ${absent.length > 1 ? "do" : "does"} not exist yet.`,
        });
      const passed = typeof ok === "function" ? ok() : ok;
      list.push({
        label,
        ok: !!passed,
        advisory,
        why: passed ? "" : typeof why === "function" ? why() : why,
      });
    },
  };
}

/** Whether a command of the run finished, by what it starts with. */
const finished = (facts, pattern) =>
  facts.ran.some(({ command, rc }) => !rc && pattern.test(command.trim()));
const stores = (name) =>
  new RegExp(
    `^est(?:i(?:m(?:a(?:t(?:es?)?)?)?)?)?\\s+sto(?:re?)?\\s+${name}\\b`,
  );
const zero = (n) => n === 0;
const clustered = (model, by = "firmid") =>
  model?.vce === "cluster" && model.clustvar === by;
/** Whether a model has dummies for a factor variable, whatever the typing. */
const dummies = (model, name) =>
  !!model?.columns?.some((column) =>
    new RegExp(`^(?:[^:]*:)?\\d+[a-z]*\\.${name}$`).test(column),
  );
/** Whether the student's last test was the joint test the step asks for. */
const sameTest = (f) =>
  f.testP !== null &&
  f.expectedP !== null &&
  f.expectedP !== undefined &&
  Math.abs(f.testP - f.expectedP) <= 1e-9 * Math.max(1e-12, f.expectedP);
const fixed3 = (x) => (x === null || x === undefined ? "." : x.toFixed(3));

const ASSESS = {
  meet(f, c) {
    const [panel = "", time = ""] = (f.panel ?? "").split("|");
    c.add("The file is in memory", {
      ok: f.n > 0,
      why: "There are no observations in memory. The first line of the step loads the file.",
    });
    c.add("The panel is declared: firm, then fiscal year", {
      needs: ["firmid", "fyear"],
      ok: panel === "firmid" && time === "fyear",
      why: panel
        ? `The panel is set with <code>${panel}</code> as the unit and <code>${time || "nothing"}</code> as the time variable. The firm identifier goes first and the fiscal year second.`
        : "The data are not <code>xtset</code> yet. Fill in the two names on the <code>xtset</code> line.",
    });
    c.add("The two merge indicators are tabulated together", {
      needs: ["match_exec", "match_audit"],
      ok: finished(
        f,
        /^ta(?:b(?:u(?:l(?:a(?:te?)?)?)?)?)?\s+match_\w+\s+match_\w+/,
      ),
      why: "Cross the two indicators in one table: <code>tab match_exec match_audit</code>.",
      advisory: true,
    });
  },
  lag(f, c) {
    c.add("<code>lag_at</code> exists", { needs: ["lag_at"], ok: true });
    c.add("It holds each firm's assets from the year before", {
      needs: ["lag_at", "at"],
      ok: zero(f.differs),
      why: () =>
        f.differs === null
          ? "The lag operator needs the panel to be declared. Run step 1 again, then this step."
          : `<code>lag_at</code> differs from <code>L.at</code> in ${rows(f.differs)}. A subscript such as <code>at[_n-1]</code> takes the row above, which belongs to another firm at the top of each firm's block and to the wrong year after a gap. <code>L.at</code> uses the panel declaration.`,
    });
    c.add("Some rows have a lag", {
      needs: ["lag_at"],
      ok: f.present > 0,
      why: "Every value of <code>lag_at</code> is missing.",
    });
  },
  window(f, c) {
    c.add("No row lies outside 2005 to 2023", {
      needs: ["fyear"],
      ok: zero(f.outside),
      why: () =>
        `${rows(f.outside)} outside the window ${f.outside === 1 ? "is" : "are"} still in memory.`,
    });
    if (f.before?.inWindow != null)
      c.add("Every row from 2005 to 2023 is still there", {
        needs: ["fyear"],
        ok: f.inWindow === f.before.inWindow,
        why: () =>
          `The step began with ${rows(f.before.inWindow)} from 2005 to 2023, and ${count(f.inWindow)} of them are left. <code>&gt;</code> and <code>&lt;</code> leave out the end years themselves; <code>&gt;=</code> and <code>&lt;=</code> keep them.`,
      });
    c.add("Rows remain", {
      ok: f.n > 0,
      why: "Nothing is left in memory. <code>keep if</code> keeps the rows where the condition is true.",
    });
    c.add("The lag was taken before the early years were dropped", {
      needs: ["lag_at"],
      ok: !(f.first > 0 && f.firstLagged === 0),
      why: "No 2005 row has a value of <code>lag_at</code>. If the file holds 2004, the lag was made after that year was dropped: restart from step 2.",
      advisory: true,
    });
  },
  outcome(f, c) {
    c.add("<code>nas</code> is never negative", {
      needs: ["nas"],
      ok: zero(f.negative),
      why: () =>
        `${rows(f.negative)} of <code>nas</code> ${f.negative === 1 ? "is" : "are"} negative.`,
    });
    c.add(
      "<code>nas</code> equals the fee wherever the fee is zero or more, and is missing elsewhere",
      {
        needs: ["nas", "non_audit_fees"],
        ok: zero(f.invented) && zero(f.lost) && zero(f.changed),
        why: () =>
          f.lost
            ? `${rows(f.lost)} with a valid fee ${f.lost === 1 ? "has" : "have"} no <code>nas</code>. Zero is a valid fee: the condition is <code>>= 0</code>.`
            : f.invented
              ? `${rows(f.invented)} ${f.invented === 1 ? "has" : "have"} a value of <code>nas</code> where the fee is negative or missing.`
              : `<code>nas</code> differs from <code>non_audit_fees</code> in ${rows(f.changed)}.`,
      },
    );
    c.add(
      "<code>lnnas</code> is the log of every positive fee, and missing elsewhere",
      {
        needs: ["lnnas", "nas"],
        ok: zero(f.logWrong) && zero(f.logLost) && f.logs > 0,
        why: () =>
          f.logLost
            ? `${rows(f.logLost)} with a positive fee ${f.logLost === 1 ? "has" : "have"} no log.`
            : f.logWrong
              ? `<code>lnnas</code> is not <code>ln(nas)</code> in ${rows(f.logWrong)}.`
              : "Every value of <code>lnnas</code> is missing.",
      },
    );
  },
  titles(f, c) {
    c.add("<code>dual_proxy</code> is 0, 1 or missing", {
      needs: ["dual_proxy"],
      ok: zero(f.other),
      why: () =>
        `${rows(f.other)} ${f.other === 1 ? "holds" : "hold"} another value.`,
    });
    c.add(
      "Every title that mentions a chair is coded 1, whatever its capitals",
      {
        needs: ["dual_proxy", "titleann"],
        ok: zero(f.missed) && zero(f.wrong) && f.ones > 0,
        why: () =>
          f.missed
            ? `${rows(f.missed)} whose title mentions a chair ${f.missed === 1 ? "is" : "are"} coded 0. <code>strpos()</code> is case-sensitive: search the lower-case copy of the title for <code>"chair"</code>.`
            : f.wrong
              ? `${rows(f.wrong)} coded 1 ${f.wrong === 1 ? "has" : "have"} no chair in the title.`
              : "No row is coded 1.",
      },
    );
    c.add("Vice chairs and blank titles are missing, and nothing else is", {
      needs: ["dual_proxy", "titleann"],
      ok: zero(f.vice) && zero(f.blank) && zero(f.lost),
      why: () =>
        f.vice
          ? `${rows(f.vice)} with a vice chair in the title still ${f.vice === 1 ? "has" : "have"} a value. Set them to missing, which Stata writes as a period.`
          : f.blank
            ? `${rows(f.blank)} with a blank title ${f.blank === 1 ? "has" : "have"} a value. The <code>if title != ""</code> on the <code>gen</code> line leaves them missing.`
            : `${rows(f.lost)} with a usable title ${f.lost === 1 ? "is" : "are"} missing.`,
    });
  },
  ratios(f, c) {
    c.add("<code>turnover</code> is sales over average assets", {
      needs: ["turnover", "sale", "at", "lag_at"],
      ok: zero(f.wrong) && zero(f.lost) && f.present > 0,
      why: () =>
        f.wrong
          ? `<code>turnover</code> is not <code>sale / ((at + lag_at)/2)</code> in ${rows(f.wrong)}.`
          : f.lost
            ? `${rows(f.lost)} with sales and both asset figures ${f.lost === 1 ? "has" : "have"} no turnover.`
            : "Every value of <code>turnover</code> is missing.",
    });
    c.add("It is missing unless both asset figures are positive", {
      needs: ["turnover", "at", "lag_at"],
      ok: zero(f.undefinedRows),
      why: () =>
        `${rows(f.undefinedRows)} ${f.undefinedRows === 1 ? "has" : "have"} a turnover although assets, or last year's assets, are missing or not positive.`,
    });
    c.add("<code>positive_cfo</code> is missing where cash flow is missing", {
      needs: ["positive_cfo", "oancf"],
      ok: zero(f.cashMissing),
      why: () =>
        `<code>positive_cfo</code> has a value in ${rows(f.cashMissing)} where <code>oancf</code> is missing. Stata counts a missing value as larger than any number, so <code>oancf > 0</code> is true there and those rows were given a 1. End the line with <code>if oancf &lt; .</code>`,
    });
    c.add("Elsewhere it is 1 for a positive cash flow and 0 otherwise", {
      needs: ["positive_cfo", "oancf"],
      ok: zero(f.cashWrong),
      why: () =>
        `<code>positive_cfo</code> disagrees with <code>oancf > 0</code> in ${rows(f.cashWrong)}.`,
    });
  },
  controls(f, c) {
    const ratio = (name, formula, top) =>
      c.add(
        `<code>${name}</code> is <code>${formula}</code> where assets are positive`,
        {
          needs: [name, "at", top],
          ok: zero(f[name]),
          why: () =>
            `${rows(f[name])} ${f[name] === 1 ? "does" : "do"} not fit: either the value is not <code>${formula}</code>, or it is defined where assets are missing or not positive.`,
        },
      );
    c.add("<code>size</code> is log assets where assets are positive", {
      needs: ["size", "at"],
      ok: zero(f.size),
      why: () =>
        `${rows(f.size)} ${f.size === 1 ? "does" : "do"} not fit <code>ln(at)</code>.`,
    });
    ratio("lev", "dltt/at", "dltt");
    ratio("roa", "ni/at", "ni");
    c.add(
      "<code>loss</code> is 1 for negative income and missing where income is missing",
      {
        needs: ["loss", "ni"],
        ok: zero(f.lossMissing) && zero(f.lossWrong),
        why: () =>
          f.lossMissing
            ? `<code>loss</code> has a value in ${rows(f.lossMissing)} where <code>ni</code> is missing. End the line with <code>if ni &lt; .</code>`
            : `<code>loss</code> disagrees with <code>ni &lt; 0</code> in ${rows(f.lossWrong)}.`,
      },
    );
    c.add("<code>big4</code> finds all four firms under every spelling", {
      needs: ["big4", "auditor_name"],
      ok:
        zero(f.bigMissed) &&
        zero(f.bigWrong) &&
        zero(f.bigBlank) &&
        zero(f.bigLost),
      why: () =>
        f.bigMissed
          ? `${rows(f.bigMissed)} with a Big Four auditor ${f.bigMissed === 1 ? "is" : "are"} coded 0. Type <code>tab auditor if big4 == 0</code> in the command line to see which names the pattern misses.`
          : f.bigWrong
            ? `${rows(f.bigWrong)} coded 1 ${f.bigWrong === 1 ? "names" : "name"} another auditor.`
            : f.bigBlank
              ? `${rows(f.bigBlank)} with no auditor name ${f.bigBlank === 1 ? "has" : "have"} a value.`
              : `${rows(f.bigLost)} with an auditor name ${f.bigLost === 1 ? "is" : "are"} missing.`,
    });
    c.add("<code>industry2</code> is the first two digits of the SIC code", {
      needs: ["industry2", "sich"],
      ok: zero(f.industry),
      why: () =>
        `${rows(f.industry)} ${f.industry === 1 ? "does" : "do"} not fit <code>floor(sich/100)</code>.`,
    });
    c.add("<code>fin_util</code> flags SIC 6000 to 6999 and 4900 to 4999", {
      needs: ["fin_util", "sich"],
      ok: zero(f.flag),
      why: () =>
        `The flag is wrong in ${rows(f.flag)}. Utilities are 4900 to 4999.`,
    });
  },
  sample(f, c) {
    c.add(
      "<code>eligible</code> marks only complete, matched, non-financial rows with a usable fee",
      {
        needs: ["eligible", "nas", "fin_util", ...MODEL_VARIABLES],
        ok: zero(f.eligibleOther) && zero(f.eligibleWrong),
        why: () =>
          f.eligibleWrong
            ? `${rows(f.eligibleWrong)} marked eligible ${f.eligibleWrong === 1 ? "breaks" : "break"} one of the rules: a missing model variable, a financial firm or utility, an unmatched merge, or no usable fee.`
            : "<code>eligible</code> should be 0 or 1 in every row.",
      },
    );
    c.add("and leaves out no row that meets them", {
      needs: ["eligible", "nas", "fin_util", ...MODEL_VARIABLES],
      ok: zero(f.eligibleLost),
      why: () =>
        `${rows(f.eligibleLost)} that ${f.eligibleLost === 1 ? "meets" : "meet"} every rule ${f.eligibleLost === 1 ? "is" : "are"} not marked eligible. A matched merge is coded 3, and a zero fee is usable.`,
    });
    c.add(
      "<code>baseline_sample</code> is the eligible rows with a positive fee",
      {
        needs: ["baseline_sample", "eligible", "nas"],
        ok:
          zero(f.baselineOther) &&
          zero(f.baselineWrong) &&
          zero(f.baselineLost),
        why: () =>
          f.baselineWrong
            ? `${rows(f.baselineWrong)} in the baseline sample ${f.baselineWrong === 1 ? "is" : "are"} not eligible or ${f.baselineWrong === 1 ? "has" : "have"} no positive fee. A condition such as <code>nas > 0</code> is also true where <code>nas</code> is missing unless <code>eligible</code> is part of it.`
            : f.baselineLost
              ? `${rows(f.baselineLost)} eligible with a positive fee ${f.baselineLost === 1 ? "is" : "are"} left out.`
              : "<code>baseline_sample</code> should be 0 or 1 in every row.",
      },
    );
    c.add("The baseline sample is not empty", {
      needs: ["baseline_sample"],
      ok: f.baseline > 0,
      why: "No row is in the baseline sample.",
    });
  },
  winsorize(f, c) {
    for (const name of RATIOS) {
      const r = f.ratios[name],
        close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
      c.add(
        `<code>${name}</code> lies between its 1st and 99th percentiles, with the original kept in <code>${name}_raw</code>`,
        {
          needs: [name, `${name}_raw`, "baseline_sample"],
          ok: () =>
            !!r?.capped &&
            (r.capped.min >= r.low || close(r.capped.min, r.low)) &&
            (r.capped.max <= r.high || close(r.capped.max, r.high)) &&
            zero(r.inside) &&
            !(r.n >= 200 && r.raw.min >= r.low && r.raw.max <= r.high),
          why: () =>
            !r?.capped
              ? "The baseline sample has no values to take percentiles from."
              : r.n >= 200 && r.raw.min >= r.low && r.raw.max <= r.high
                ? `<code>${name}_raw</code> has nothing beyond its own 1st and 99th percentiles, so it was copied after the cap. Make the copy first, as the first line of the loop does.`
                : r.inside
                  ? `${rows(r.inside)} between the two percentiles ${r.inside === 1 ? "was" : "were"} changed. Only values beyond a cap move.`
                  : `In the baseline sample <code>${name}</code> runs from ${fixed3(r.capped.min)} to ${fixed3(r.capped.max)}; the percentiles are ${fixed3(r.low)} and ${fixed3(r.high)}. Ask <code>_pctile</code> for <code>p(1 99)</code> and take the upper one from <code>r(r2)</code>.`,
        },
      );
    }
    c.add("<code>nas_m</code> is the fee in millions of dollars", {
      needs: ["nas_m", "nas"],
      ok: zero(f.millions),
      why: () =>
        `${rows(f.millions)} ${f.millions === 1 ? "does" : "do"} not fit <code>nas/1000000</code>.`,
    });
  },
  baseline(f, c) {
    const m = f.model;
    c.add("The last model is a linear regression of <code>lnnas</code>", {
      needs: ["lnnas"],
      ok: m?.cmd === "regress" && m.depvar === "lnnas",
      why: m
        ? `The model in memory is <code>${m.cmd}</code> with <code>${m.depvar}</code> as the outcome.`
        : "No model has been fitted yet.",
    });
    c.add(
      "with the chair proxy, turnover, the cash-flow indicator and the five controls",
      {
        ok: !!m && Object.values(m.b).every((b) => b !== null),
        why: () =>
          m
            ? `Not in the model: ${Object.entries(m.b)
                .filter(([, b]) => b === null)
                .map(([name]) => `<code>${name}</code>`)
                .join(", ")}.`
            : "No model has been fitted yet.",
      },
    );
    c.add("industry and year dummies", {
      ok: dummies(m, "industry2") && dummies(m, "fyear"),
      why: "Add <code>i.industry2</code> and <code>i.fyear</code> to the list of regressors.",
    });
    c.add("and standard errors clustered by firm", {
      ok: clustered(m),
      why:
        m?.vce === "cluster"
          ? `The errors are clustered by <code>${m.clustvar}</code>. The firm is <code>firmid</code>.`
          : "The option is <code>vce(cluster firmid)</code>.",
    });
    c.add("It uses exactly the baseline sample", {
      needs: ["baseline_sample"],
      ok: !!m && m.N === f.baseline && f.baseline > 0,
      why: () =>
        m
          ? `The model used ${rows(m.N)}; <code>baseline_sample</code> marks ${rows(f.baseline)}. End the variable list with <code>if baseline_sample</code>.`
          : "No model has been fitted yet.",
    });
    c.add("The model is stored as <code>baseline</code>", {
      ok: finished(f, stores("baseline")),
      why: "After the regression, <code>est store baseline</code> keeps it for the table in the next step.",
    });
    c.add("The two coefficients are tested together", {
      ok: f.testTerms === 2 && sameTest(f),
      why: () =>
        f.testTerms === 2
          ? "The last test was of two coefficients, but not of <code>turnover</code> and <code>positive_cfo</code> on this model: <code>test turnover positive_cfo</code>."
          : "Name both coefficients after <code>test</code>: <code>test turnover positive_cfo</code>.",
    });
  },
  robustness(f, c) {
    const fe = f.firm_fe,
      all = f.all_fees,
      date = f.date_screen,
      raw = f.uncapped,
      absent = (name) =>
        `No model is stored as <code>${name}</code>. The <code>est store ${name}</code> line follows the model it keeps.`;
    c.add("<code>firm_fe</code> absorbs the firm and clusters by firm", {
      ok:
        !!fe &&
        ((fe.cmd === "areg" && fe.absvar === "firmid") ||
          (fe.cmd === "xtreg" && fe.kind === "fe")) &&
        clustered(fe),
      why: () =>
        !fe
          ? absent("firm_fe")
          : fe.cmd === "areg" && fe.absvar !== "firmid"
            ? `<code>firm_fe</code> absorbs <code>${fe.absvar}</code>. The firm is <code>firmid</code>.`
            : !clustered(fe)
              ? "<code>firm_fe</code> needs <code>vce(cluster firmid)</code>."
              : `<code>firm_fe</code> was fitted with <code>${fe.cmd}</code>. Use <code>areg</code> with <code>absorb(firmid)</code>.`,
    });
    c.add("and uses the baseline sample", {
      ok: !!fe && fe.N === f.baselineRows,
      why: () =>
        fe
          ? `It used ${rows(fe.N)}; the baseline sample has ${rows(f.baselineRows)}.`
          : absent("firm_fe"),
    });
    c.add(
      "<code>all_fees</code> is a Poisson model of the fee that includes the zero-fee rows",
      {
        ok:
          !!all &&
          all.cmd === "poisson" &&
          FEES.includes(all.depvar) &&
          all.N <= f.eligible &&
          (f.zero === 0 || all.N > f.baselineRows),
        why: () =>
          !all
            ? absent("all_fees")
            : all.cmd !== "poisson"
              ? `<code>all_fees</code> was fitted with <code>${all.cmd}</code>.`
              : !FEES.includes(all.depvar)
                ? all.depvar === "lnnas"
                  ? "Its outcome is <code>lnnas</code>, the log of the fee. A Poisson model takes the fee itself, <code>nas_m</code>, and the log has no value where the fee is zero."
                  : `Its outcome is <code>${all.depvar}</code>. The fee itself is <code>nas_m</code> (or <code>nas</code>: in a Poisson model the unit changes only the constant).`
                : `It used ${rows(all.N)}. The eligible sample has ${rows(f.eligible)}, of which ${count(f.zero)} have a zero fee: fit it <code>if eligible</code>.`,
      },
    );
    // A file without the two dates has the step without its date screen.
    if (c.has("fiscal_ye") && c.has("datadate"))
      c.add(
        "<code>date_screen</code> is the baseline model on the rows where the year-ends agree",
        {
          needs: ["date_ok"],
          ok:
            !!date &&
            date.cmd === "regress" &&
            date.depvar === "lnnas" &&
            date.N === f.dated &&
            zero(f.dateOther),
          why: () =>
            !date
              ? absent("date_screen")
              : date.N !== f.dated
                ? `It used ${rows(date.N)}; ${rows(f.dated)} of the baseline sample ${f.dated === 1 ? "has" : "have"} <code>date_ok == 1</code>. A bare <code>& date_ok</code> also takes the rows where it is missing.`
                : `<code>date_screen</code> should be the same <code>reg lnnas</code> model as the baseline.`,
        },
      );
    c.add("<code>uncapped</code> uses the three <code>_raw</code> ratios", {
      ok:
        !!raw &&
        raw.cmd === "regress" &&
        ["turnover_raw", "lev_raw", "roa_raw"].every((n) => raw.b[n] !== null),
      why: () =>
        !raw
          ? absent("uncapped")
          : `Not in the model: ${["turnover_raw", "lev_raw", "roa_raw"]
              .filter((n) => raw.b[n] === null)
              .map((n) => `<code>${n}</code>`)
              .join(", ")}.`,
    });
    c.add("The models are shown side by side", {
      ok: finished(f, /^est(?:i(?:m(?:a(?:t(?:es?)?)?)?)?)?\s+tab(?:le?)?\b/),
      why: "The <code>est table</code> command at the end prints them together.",
    });
  },
  extension(f, c) {
    const buys = f.buys,
      amount = f.amount;
    c.add(
      "<code>any_fee</code> is 1 for a positive fee, 0 for none, on the eligible rows only",
      {
        needs: ["any_fee", "eligible", "nas"],
        ok: zero(f.other) && zero(f.wrong),
        why: () =>
          `${rows(f.wrong ?? f.other)} ${(f.wrong ?? f.other) === 1 ? "does" : "do"} not fit <code>nas > 0 if eligible</code>.`,
      },
    );
    c.add(
      "<code>buys</code> is a logit of <code>any_fee</code>, clustered by firm",
      {
        ok:
          buys?.cmd === "logit" && buys.depvar === "any_fee" && clustered(buys),
        why: buys
          ? `<code>buys</code> was fitted with <code>${buys.cmd}</code> on <code>${buys.depvar}</code>.`
          : "No model is stored as <code>buys</code>.",
      },
    );
    c.add(
      "The two indicators enter the logit as factor variables, <code>i.dual_proxy</code> and <code>i.positive_cfo</code>",
      {
        ok:
          !!buys &&
          dummies(buys, "dual_proxy") &&
          dummies(buys, "positive_cfo"),
        why: "Without the <code>i.</code> prefix, <code>margins</code> treats the indicator as a continuous variable and reports a slope instead of the change from 0 to 1.",
        advisory: true,
      },
    );
    c.add("Marginal effects were computed", {
      ok: finished(f, /^margins\b/),
      why: "Fill in the first name in <code>margins, dydx(…)</code>.",
    });
    c.add(
      "<code>amount</code> is a Poisson model on the rows with a positive fee",
      {
        ok:
          amount?.cmd === "poisson" &&
          FEES.includes(amount.depvar) &&
          amount.N > 0 &&
          amount.N === f.baselineRows,
        why: () =>
          !amount
            ? "No model is stored as <code>amount</code>."
            : amount.cmd !== "poisson" || !FEES.includes(amount.depvar)
              ? `<code>amount</code> was fitted with <code>${amount.cmd}</code> on <code>${amount.depvar}</code>.`
              : `It used ${rows(amount.N)}; the baseline sample, the rows with a positive fee, has ${rows(f.baselineRows)}. Fit it <code>if baseline_sample</code> and nothing more.`,
      },
    );
  },
};

/** What the lab shows beside the checks, computed from the student's own session. */
const REPORT = {
  sample: (f) =>
    f.baseline === null || f.eligible === null
      ? null
      : {
          title: "Where the rows go",
          head: ["Stage", "Firm-years"],
          rows: [
            ["In memory", f.n],
            ["Found in both source files", f.both],
            ["Not financial or utility", f.industrial],
            ["Eligible: nothing missing, usable fee", f.eligible],
            ["of which the fee is zero", f.zero],
            ["Baseline sample: positive fee", f.baseline],
          ].map(([label, n]) => [label, n === null ? "." : count(n)]),
        },
  baseline(f) {
    const m = f.model;
    if (!m || m.b.dual_proxy === null || m.b.turnover === null) return null;
    const percent = (b) => `${(100 * (Math.exp(b) - 1)).toFixed(1)}%`,
      // In the sentence the direction is said in words.
      size = (b) => `${Math.abs(100 * (Math.exp(b) - 1)).toFixed(1)}%`;
    return {
      title: "Reading your coefficients",
      head: ["Regressor", "Coefficient", "100 × (exp(b) − 1)"],
      rows: [
        ["dual_proxy", fixed3(m.b.dual_proxy), percent(m.b.dual_proxy)],
        ["turnover", fixed3(m.b.turnover), percent(m.b.turnover)],
      ],
      note: `Firm-years with a chair in the chief executive's title pay ${size(m.b.dual_proxy)} ${m.b.dual_proxy < 0 ? "less" : "more"} in non-audit fees than otherwise similar firm-years, and one more unit of turnover goes with ${size(m.b.turnover)} ${m.b.turnover < 0 ? "less" : "more"}. ${
        !sameTest(f)
          ? ""
          : `The joint test of turnover and the cash-flow indicator has p = ${f.testP.toFixed(3)}.`
      }`,
    };
  },
  robustness(f) {
    const models = [
      ["baseline", "Pooled, industry and year dummies"],
      ["firm_fe", "Firm fixed effects"],
      ["all_fees", "Poisson, zero fees included"],
      ["date_screen", "Year-ends agree"],
      ["uncapped", "Ratios not capped"],
    ].filter(([name]) => f[name]);
    if (!models.length) return null;
    return {
      title: "The chair coefficient, model by model",
      head: ["Model", "What it is", "Chair proxy", "Firm-years"],
      rows: models.map(([name, what]) => [
        name,
        what,
        fixed3(f[name].b.dual_proxy),
        f[name].N === null ? "." : count(f[name].N),
      ]),
      note: "Compare the first two rows. The pooled coefficient uses differences between firms; the fixed-effects coefficient uses only changes within a firm.",
    };
  },
};

/**
 * The checks of a step, made on the facts gathered from a session:
 * { checks: [{ label, ok, why, advisory }], passed, report }. A step is
 * passed when every check that is not advisory holds.
 */
export function assess(id, facts) {
  const c = checker(facts);
  ASSESS[id](facts, c);
  return {
    checks: c.list,
    passed: c.list.every((check) => check.ok || check.advisory),
    report: REPORT[id]?.(facts) ?? null,
  };
}

// ----- a student's own file -----

const isString = (type) => /^str/.test(type ?? "");

/**
 * How a file's columns compare with the ones the lab reads. Each row has
 * `state`: "ok", "missing", "type" (there, but text where numbers are
 * needed or the reverse) or "case" (there under other capitals).
 */
export function preflight(variables) {
  const exact = new Map(variables.map((v) => [v.name, v])),
    loose = new Map(variables.map((v) => [v.name.toLowerCase(), v]));
  return EXPECTED_COLUMNS.map((column) => {
    const found = exact.get(column.name) ?? loose.get(column.name),
      row = {
        name: column.name,
        what: column.what,
        kind: column.kind,
        optional: !!column.optional,
        needed: column.needed ?? "",
        found: found?.name ?? "",
        type: found?.type ?? "",
        format: found?.format ?? "",
      };
    if (!found) return { ...row, state: "missing" };
    if (found.name !== column.name) return { ...row, state: "case" };
    const text = isString(found.type),
      fits =
        column.kind === "any" ||
        (column.kind === "string" && text) ||
        (column.kind === "numeric" && !text) ||
        (column.kind === "date" && !text && /^%t/.test(found.format));
    return { ...row, state: fits ? "ok" : "type" };
  });
}

/** What the lines that prepare a file need to know about its dates. */
export function gatherFileFacts(session) {
  const ask = asker(session),
    variables = ask.variables(),
    date = variables.find((v) => v.name.toLowerCase() === "datadate"),
    facts = { variables, masks: null, digits: null };
  if (date && isString(date.type))
    facts.masks = Object.fromEntries(
      ["DMY", "YMD", "MDY"].map((mask) => [
        mask,
        ask.count(
          `${date.name} != "" & missing(date(${date.name}, "${mask}"))`,
        ),
      ]),
    );
  else if (date && !/^%t/.test(date.format))
    facts.digits = {
      all: ask.count(`${date.name} < .`),
      eight: ask.count(`${date.name} >= 18000101 & ${date.name} <= 21001231`),
    };
  return facts;
}

/**
 * The commands that bring a file's columns to the names and types the
 * steps read, where that can be done without guessing: capitals, an
 * identifier or a year-end held as text, a date held as text or as a
 * number such as 20231231. They are shown to the student and go into the
 * do-file, since Stata would need them too.
 */
export function prepareLines({ variables, masks, digits }) {
  const lines = [],
    table = preflight(variables),
    row = (name) => table.find((each) => each.name === name);
  for (const each of table)
    if (each.state === "case") lines.push(`rename ${each.found} ${each.name}`);
  const typeOf = (name) => (row(name).found ? row(name).type : null);
  if (typeOf("firmid") === null && typeOf("gvkey") !== null)
    lines.push(
      "* a number for each firm, made from the firm key",
      "egen long firmid = group(gvkey)",
    );
  else if (isString(typeOf("firmid")))
    lines.push(
      "* the panel identifier has to be a number",
      "rename firmid firmid_text",
      "egen long firmid = group(firmid_text)",
    );
  for (const each of table)
    if (
      each.kind === "numeric" &&
      each.found &&
      isString(each.type) &&
      each.name !== "firmid"
    )
      lines.push(`destring ${each.name}, replace`);
  if (typeOf("fiscal_ye") !== null && !isString(typeOf("fiscal_ye")))
    lines.push(
      "* the fee file's year-end as four characters, month then day",
      "tostring fiscal_ye, replace format(%04.0f)",
    );
  if (masks) {
    const [mask, failed] = Object.entries(masks)
      .filter(([, n]) => n !== null)
      .sort((a, b) => a[1] - b[1])[0] ?? ["DMY", 0];
    lines.push(
      `* the year-end date arrived as text${failed ? `; ${count(failed)} of its values are not dates` : ""}`,
      `generate long datadate_days = date(datadate, "${mask}")`,
      "drop datadate",
      "rename datadate_days datadate",
      "format datadate %td",
    );
  } else if (digits && digits.all > 0 && digits.eight === digits.all)
    lines.push(
      "* the year-end date arrived as a number such as 20231231",
      "tostring datadate, generate(datadate_text) format(%8.0f)",
      'generate long datadate_days = date(datadate_text, "YMD")',
      "drop datadate datadate_text",
      "rename datadate_days datadate",
      "format datadate %td",
    );
  else if (digits && digits.all > 0) lines.push("format datadate %td");
  return lines;
}
