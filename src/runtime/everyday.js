// Commands students reach for early: mean, ci means, pwcorr, spearman and
// clonevar, and the ones that have no meaning in a browser (help, browse,
// ssc install) but should say so plainly rather than stop a do-file.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { invttail, ttail } from "./distributions.js";
import { count, moments } from "./reports.js";
import { MISSING, isMissing, isStringType } from "./values.js";

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

function mean(session, text, ctx) {
  const parsed = session.parse(
      "varlist [if] [in] [, Level(cilevel) | OVer(string) VCE(string)]",
      text,
    ),
    level = parsed.options.level,
    variables = numeric(session, parsed.varlist),
    // mean uses the observations complete on every variable named.
    rows = session
      .rows(parsed, null)
      .filter((i) => variables.every((v) => !isMissing(v.data[i]))),
    n = rows.length;
  if (!n) throw new StataError("no observations", 2000);
  const critical = invttail(n - 1, (1 - level / 100) / 2),
    rule = "-".repeat(62);
  ctx.out("");
  ctx.out(`Mean estimation${`Number of obs = ${count(n)}`.padStart(47)}`);
  ctx.out("");
  ctx.out(rule);
  ctx.out(
    `             |       Mean   Std. err.     [${g(level)}% conf. interval]`,
  );
  ctx.out("-------------+------------------------------------------------");
  for (const variable of variables) {
    const m = moments(rows.map((i) => variable.data[i])),
      se = m.sd / Math.sqrt(n);
    ctx.out(
      `${variable.name.padStart(12)} |${g(m.mean).padStart(11)}${g(se).padStart(11)}${g(m.mean - critical * se).padStart(14)}${g(m.mean + critical * se).padStart(12)}`,
    );
  }
  ctx.out(rule);
  ctx.out("");
}

function ci(session, text, ctx) {
  const m = /^\s*(\w+)\s*([\s\S]*)$/.exec(text);
  if (!m) throw new StataError("invalid syntax", 198);
  if (!"means".startsWith(m[1]) || m[1].length < 4) {
    if (/^(prop|var)/.test(m[1]))
      throw new StataError(`ci ${m[1]} is not available yet; ci means is`, 198);
    // The older form: ci varlist.
    m[2] = text;
  }
  const parsed = session.parse("[varlist] [if] [in] [, Level(cilevel)]", m[2]),
    level = parsed.options.level,
    rows = session.rows(parsed, null);
  ctx.out("");
  ctx.out(
    `    Variable |        Obs        Mean    Std. err.       [${g(level)}% conf. interval]`,
  );
  ctx.out(
    "-------------+---------------------------------------------------------------",
  );
  let last = null;
  for (const name of parsed.varlist) {
    const variable = session.data.get(name);
    if (isStringType(variable.type)) continue;
    const stats = moments(
      rows.map((i) => variable.data[i]).filter((v) => !isMissing(v)),
    );
    if (!stats.n) {
      ctx.out(`${name.padStart(12)} |${"0".padStart(11)}`);
      continue;
    }
    const se = stats.sd / Math.sqrt(stats.n),
      critical = invttail(stats.n - 1, (1 - level / 100) / 2),
      lb = stats.mean - critical * se,
      ub = stats.mean + critical * se;
    ctx.out(
      `${name.padStart(12)} |${count(stats.n).padStart(11)}${g(stats.mean).padStart(12)}${g(se).padStart(12)}${g(lb).padStart(16)}${g(ub).padStart(12)}`,
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

export const EVERYDAY_COMMANDS = [
  { name: "mean", minimum: 4, run: mean },
  { name: "ci", minimum: 2, run: ci },
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
  { name: "timer", minimum: 5, run: quiet },
  {
    name: "about",
    minimum: 5,
    run: note(
      "STATAverse runtime: a browser implementation of part of Stata's language, checked against Stata 17. It is not Stata.",
    ),
  },
];
