// Resampling: sample, bsample, and the bootstrap, jackknife and simulate
// prefixes. sample and bsample draw from the uniform stream in the order
// Stata's own programs do, so that after the same set seed they choose the
// same observations and bootstrap standard errors agree with Stata's.
import { StataError } from "./errors.js";
import { applyFormat } from "./format.js";
import { Ftail, chi2tail, invttail, ttail } from "./distributions.js";
import { invnormal, normal } from "./functions-normal.js";
import { Generator } from "./random.js";
import {
  RULE,
  abbreviate,
  hooks,
  invertSymmetric,
  quadratic,
  tableWidth,
  termRows,
} from "./estimation.js";
import { count, percentile } from "./reports.js";
import { clauses, splitAtComma } from "./syntax.js";
import { fileName, settle } from "./data-commands.js";
import { findFile } from "./files.js";
import { Dataset } from "./store.js";
import { MISSING, isMissing, isName, isStringType } from "./values.js";

const g = (value, format = "%9.0g") => applyFormat(value, format).trim();
const SPLIT =
  "-------------+----------------------------------------------------------------";
const uniform = (session) =>
  (session.state.rng ??= new Generator(session.state.seed)).uniform();

/** Replaces the data with the listed observations, repeats allowed. */
function takeRows(data, index) {
  // Plain loops: a jackknife takes the rows once per replicate.
  const m = index.length;
  for (const v of data.variables) {
    const from = v.data,
      to = isStringType(v.type) ? new Array(m) : new Float64Array(m);
    for (let k = 0; k < m; k++) to[k] = from[index[k]];
    v.data = to;
  }
  data.permuteMarks(index);
  data.n = m;
  data.sortedBy = [];
}

/**
 * The observations of a bootstrap sample of the same size, in the order
 * Stata's bsample leaves them: each observation draws a target position and
 * a tie-breaker; the last observation drawn to each position is kept, as
 * many times as observations drew it, the extra copies following the rest.
 */
function bootstrapIndex(session, n) {
  const r = Array.from({ length: n }, () =>
      Math.trunc(uniform(session) * n + 1),
    ),
    w = Array.from({ length: n }, () => uniform(session)),
    order = r.map((_, i) => i).sort((a, b) => r[a] - r[b] || w[a] - w[b]),
    kept = [],
    copies = [];
  let run = 0;
  order.forEach((i, p) => {
    run++;
    if (p === n - 1 || r[order[p + 1]] !== r[i]) {
      kept.push(i);
      for (let c = 1; c < run; c++) copies.push(i);
      run = 0;
    }
  });
  return [...kept, ...copies];
}

/**
 * The observations of a bootstrap sample of `size` drawn from n, as
 * bsample's SRSWR leaves them: the sample of n, then, for a smaller size,
 * the first observations after one more random ordering.
 */
function simpleSample(session, n, size) {
  const index = bootstrapIndex(session, n);
  if (size === null || size === n) return index;
  const key = index.map(() => uniform(session)),
    order = index.map((_, k) => k).sort((a, b) => key[a] - key[b]);
  return order.slice(0, size).map((k) => index[k]);
}

// The resampling of strata and clusters follows bsample.ado line by line,
// on a table of rows: o, the observation; s, its stratum; clid, its
// cluster's number in its stratum; obsid, its place in the stratum (or the
// data); r and w, bsample's working variables. Stata's missing value sorts
// after every number, as Infinity does.
const NONE = Infinity;
const resampleError = (message) => new StataError(message, 498);

/** Runs of equal keys in a sorted table, as `by` forms them. */
function runs(table, key) {
  const out = [];
  table.forEach((row, k) => {
    if (k && key(row) === key(table[k - 1])) out.at(-1).push(row);
    else out.push([row]);
  });
  return out;
}
/** keep if w, then expand w: each copy after the rest, as expand adds them. */
function expandRows(table) {
  const kept = table.filter((row) => row.w !== 0),
    copies = [];
  for (const row of kept)
    for (let c = 1; c < row.w; c++) copies.push({ ...row });
  return [...kept, ...copies];
}
/**
 * NewClustID: numbers the clusters of the sample 1, 2, ... in each
 * stratum (in a random order when fewer are drawn than there are), keeps
 * the first nsamp and, across strata (uniq), numbers them again.
 */
function newClusterIds(session, table, { nclust, nsamp, random, uniq }) {
  table.sort((a, b) => a.s - b.s || a.clid - b.clid || a.obsid - b.obsid);
  for (const run of runs(table, (row) => `${row.s}:${row.clid}:${row.obsid}`))
    run.forEach((row, k) => (row.r = (row.clid - 1) * nclust(row) + k));
  table.sort((a, b) => a.s - b.s || a.r - b.r || a.obsid - b.obsid);
  let key = (row) => `${row.s}:${row.r}`;
  if (random) {
    // cond(_n == 1, uniform(), w[_n-1]) draws for every row, as Stata
    // evaluates both of cond()'s branches.
    for (const run of runs(table, key))
      run.forEach((row, k) => {
        const u = uniform(session);
        row.w = k ? run[k - 1].w : u;
      });
    table.sort(
      (a, b) => a.s - b.s || a.w - b.w || a.r - b.r || a.obsid - b.obsid,
    );
    key = (row) => `${row.s}:${row.w}:${row.r}`;
  }
  const counts = new Map();
  for (const run of runs(table, key)) {
    const id = (counts.get(run[0].s) ?? 0) + 1;
    counts.set(run[0].s, id);
    for (const row of run) row.clid = id;
  }
  table = table.filter((row) => row.clid <= nsamp(row));
  if (uniq)
    runs(table, key).forEach((run, k) => {
      for (const row of run) row.clid = k + 1;
    });
  return table;
}

/**
 * A bootstrap sample of the observations 0..n-1, which are in order of
 * their strata and clusters: strata and clusters hold each observation's
 * stratum (1, 2, ...) and cluster key, or are null. size is the number of
 * observations (or clusters) to draw in each stratum, null for all. Returns
 * the observations in the order bsample leaves them and, with clusters,
 * the new cluster number of each.
 */
function resample(
  session,
  n,
  { strata = null, clusters = null, size = null, idcluster = false },
) {
  const stratum = (i) => (strata ? strata[i] : 1),
    sizes = new Map();
  for (let i = 0; i < n; i++)
    sizes.set(stratum(i), (sizes.get(stratum(i)) ?? 0) + 1);
  if (!clusters && !strata) {
    if (size !== null && size <= 0)
      throw resampleError("resample size must be greater than zero");
    if (size !== null && size > n)
      throw resampleError(
        "resample size must not be greater than number of observations",
      );
    return { rows: simpleSample(session, n, size), ids: null };
  }
  if (!clusters) {
    if (size !== null && size <= 0)
      throw resampleError("resample size(s) must be greater than zero");
    if (size !== null && [...sizes.values()].some((N) => size > N))
      throw resampleError(
        "resample sizes must not be greater than number of observations with strata",
      );
    const r = Array.from({ length: n }, (_, i) =>
        Math.trunc(uniform(session) * sizes.get(stratum(i)) + 1),
      ),
      w = Array.from({ length: n }, () => uniform(session)),
      order = r
        .map((_, i) => i)
        .sort((a, b) => stratum(a) - stratum(b) || r[a] - r[b] || w[a] - w[b]),
      kept = [],
      copies = [];
    let run = 0;
    order.forEach((i, p) => {
      run++;
      const next = order[p + 1];
      if (
        next === undefined ||
        stratum(next) !== stratum(i) ||
        r[next] !== r[i]
      ) {
        kept.push(i);
        for (let c = 1; c < run; c++) copies.push(i);
        run = 0;
      }
    });
    let rows = [...kept, ...copies];
    const nsamp = (s) => size ?? sizes.get(s);
    // by strata: on data expand has put out of order fails, so the sample
    // is shuffled within strata whenever an observation was drawn twice.
    if (copies.length || [...sizes].some(([s, N]) => nsamp(s) !== N)) {
      const key = rows.map(() => uniform(session)),
        taken = new Map();
      rows = rows
        .map((_, k) => k)
        .sort((a, b) => stratum(rows[a]) - stratum(rows[b]) || key[a] - key[b])
        .map((k) => rows[k])
        .filter((i) => {
          const c = (taken.get(stratum(i)) ?? 0) + 1;
          taken.set(stratum(i), c);
          return c <= nsamp(stratum(i));
        });
    }
    return { rows, ids: null };
  }
  // Clusters, numbered within their strata.
  let table = [],
    clid = 0,
    position = 0;
  const nclust = new Map();
  for (let i = 0; i < n; i++) {
    const first = !i || stratum(i) !== stratum(i - 1);
    if (first) {
      clid = 0;
      position = 0;
    }
    if (first || clusters[i] !== clusters[i - 1]) clid++;
    position++;
    nclust.set(stratum(i), clid);
    table.push({
      o: i,
      s: stratum(i),
      clid,
      obsid: position,
      r: NONE,
      w: NONE,
    });
  }
  if ([...nclust.values()].some((c) => c === 1))
    throw new StataError("singleton cluster detected", 460);
  if (size !== null && size <= 0)
    throw resampleError("resample size(s) must be greater than zero");
  if (size !== null && [...nclust.values()].some((c) => size > c))
    throw resampleError(
      "resample size must not be greater than number of clusters",
    );
  const nsamp = (row) => size ?? nclust.get(row.s),
    ncl = (row) => nclust.get(row.s),
    random = size !== null && [...nclust.values()].some((c) => size !== c);
  if (!strata) {
    // ClustSRSWR: the first nclust rows draw a cluster and a tie-breaker
    // each and are sorted among themselves; the count of each cluster
    // drawn is then passed through obsid and clid to every observation.
    const N = ncl(table[0]),
      head = table.slice(0, N);
    for (const row of head) row.r = Math.trunc(uniform(session) * N + 1);
    for (const row of head) row.w = uniform(session);
    head.sort((a, b) => a.r - b.r || a.w - b.w || a.obsid - b.obsid);
    table = [...head, ...table.slice(N)];
    for (let j = 0; j < N; j++)
      table[j].w = j && table[j].r === table[j - 1].r ? table[j - 1].w + 1 : 1;
    for (let j = 0; j < N - 1; j++) if (table[j + 1].w !== 1) table[j].w = 0;
    for (let j = 0; j < N; j++) table[j].r = table[table[j].obsid - 1].w;
    for (const row of table) row.w = table[row.clid - 1].r;
  } else {
    // StrClustSRSWR: the same within each stratum, its rows sorted whole.
    for (const row of table)
      if (row.obsid <= ncl(row))
        row.r = Math.trunc(uniform(session) * ncl(row) + 1);
    for (const row of table)
      if (row.obsid <= ncl(row)) row.w = uniform(session);
    table.sort(
      (a, b) => a.s - b.s || a.r - b.r || a.w - b.w || a.obsid - b.obsid,
    );
    for (const block of runs(table, (row) => row.s)) {
      const N = ncl(block[0]);
      block.forEach((row, j) => {
        if (j < N)
          row.w = j && row.r === block[j - 1].r ? block[j - 1].w + 1 : 1;
      });
      block.forEach((row, j) => {
        if (!(block[j + 1]?.w === 1 || j + 1 === N) || j + 1 > N) row.w = 0;
      });
      block.forEach((row, j) => {
        if (j < N) row.r = block[row.obsid - 1].w;
      });
      for (const row of block) row.w = block[row.clid - 1].r;
    }
  }
  table = expandRows(table);
  if (random || idcluster)
    table = newClusterIds(session, table, {
      nclust: ncl,
      nsamp,
      random,
      uniq: !!strata,
    });
  return { rows: table.map((row) => row.o), ids: table.map((row) => row.clid) };
}

/**
 * Puts the data in order of their strata and clusters, as bootstrap and
 * bsample sort them (stably), and returns each observation's stratum
 * number and cluster key, or null.
 */
function arrange(session, strataNames, clusterNames) {
  const data = session.data,
    columns = (names) => names.map((name) => data.get(name).data),
    s = columns(strataNames),
    c = columns(clusterNames),
    compare = (cols) => (a, b) => {
      for (const col of cols)
        if (col[a] !== col[b]) return col[a] < col[b] ? -1 : 1;
      return 0;
    },
    byStrata = compare(s),
    order = Array.from({ length: data.n }, (_, i) => i).sort(
      (a, b) => byStrata(a, b) || compare(c)(a, b) || a - b,
    );
  takeRows(data, order);
  const key = (cols, i) => JSON.stringify(cols.map((col) => col[i])),
    sAfter = columns(strataNames),
    cAfter = columns(clusterNames);
  let stratum = 0;
  const strata = strataNames.length
      ? Array.from({ length: data.n }, (_, i) => {
          if (!i || key(sAfter, i) !== key(sAfter, i - 1)) stratum++;
          return stratum;
        })
      : null,
    clusters = clusterNames.length
      ? Array.from({ length: data.n }, (_, i) => key(cAfter, i))
      : null;
  return { strata, clusters, nstrata: stratum, order };
}

function bsample(session, text, ctx) {
  const m = /^\s*([^,]*?)\s*(,[\s\S]*)?$/.exec(text),
    data = session.data;
  if (/(?:^|\s)(?:if|in)\s/.test(` ${m[1]} `))
    throw new StataError(
      "bsample with if or in is not available yet",
      198,
      "Keep the observations to resample first, then bsample.",
    );
  const options = session.parse(
      "[, CLuster(varlist) IDcluster(string) STRata(varlist) | Weight(string)]",
      m[2] ?? "",
    ).options,
    clusterNames = options.cluster ?? [],
    strataNames = options.strata ?? [],
    idcluster = options.idcluster?.trim();
  if (idcluster && !clusterNames.length)
    throw new StataError("option idcluster() requires option cluster()", 198);
  if (idcluster && !isName(idcluster))
    throw new StataError(`${idcluster} invalid name`, 198);
  let size = null;
  if (m[1]) {
    size = session.scalar(m[1]);
    if (Math.abs(size - Math.trunc(size)) >= 1e-7)
      throw new StataError(`expression: ${m[1]}: is not an integer`, 198);
  }
  if (!data.n) return;
  // An observation without a stratum is not resampled.
  if (strataNames.length) {
    const columns = strataNames.map((name) => data.get(name));
    takeRows(
      data,
      Array.from({ length: data.n }, (_, i) => i).filter((i) =>
        columns.every((v) =>
          isStringType(v.type) ? v.data[i] !== "" : !isMissing(v.data[i]),
        ),
      ),
    );
  }
  if (!strataNames.length && !clusterNames.length) {
    if (size !== null && size <= 0)
      throw new StataError("resample size must be greater than zero", 498);
    if (size !== null && size > data.n)
      throw new StataError(
        "resample size must not be greater than number of observations",
        498,
      );
    return takeRows(data, simpleSample(session, data.n, size));
  }
  const { strata, clusters } = arrange(session, strataNames, clusterNames),
    { rows, ids } = resample(session, data.n, {
      strata,
      clusters,
      size,
      idcluster: !!idcluster,
    });
  takeRows(data, rows);
  if (idcluster) setClusterIds(data, idcluster, ids);
}

/** The new cluster numbers, in a variable of their own. */
function setClusterIds(data, name, ids) {
  const most = Math.max(0, ...ids),
    type = most <= 100 ? "byte" : most <= 32740 ? "int" : "long";
  if (data.has(name))
    data.variables = data.variables.filter((v) => v.name !== name);
  data.generate(name, ids, { type });
  data.get(name).label = "Bootstrap sample cluster id";
}

/** dots(#) as a number of replications per mark, 0 for none. */
function dotsEvery(options) {
  if (options.dots === undefined) return options.nodots ? 0 : 1;
  if (options.nodots)
    throw new StataError(
      "only one of options dots() or nodots is allowed",
      198,
    );
  const given = options.dots.trim(),
    every = Number(given);
  if (!/^\d+$/.test(given) || !Number.isInteger(every))
    throw new StataError(
      `invalid dots() option;\n${given} found where non-negative integer expected`,
      198,
    );
  return every;
}

/**
 * seed(#): set seed #. As set seed reads a number, a fraction is cut to its
 * whole part and a sign dropped; a seed's state string is refused.
 */
function applySeed(session, text) {
  if (text === undefined) return;
  const given = text.trim();
  if (/^X/.test(given))
    throw new StataError(
      `seed(${given.slice(0, 12)}...) is not available in the browser yet`,
      198,
      "Give seed() a whole number, or type set seed # before the command.",
    );
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(given))
    throw new StataError(`'${given}' found where integer < 2^31 expected`, 198);
  const seed = Math.trunc(Math.abs(Number(given)));
  if (!(seed <= 2147483647))
    throw new StataError("seed must be between 0 and 2,147,483,647", 198);
  session.settings.seed = seed;
  session.state.seed = seed;
  session.state.rng = null;
}

// The time stamp a saved dataset carries: 13 Nov 2026 17:08.
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
function stamp(now = new Date()) {
  const two = (k) => String(k).padStart(2, "0");
  return `${two(now.getDate())} ${MONTHS[now.getMonth()]} ${now.getFullYear()} ${two(now.getHours())}:${two(now.getMinutes())}`;
}

/**
 * saving(filename [, replace double every(#)]): where the replicates go.
 * An existing file needs replace, which says when there was none.
 */
function savingTarget(session, text) {
  if (text === undefined) return null;
  const [name, rest] = splitAtComma(text),
    options = session.parse(
      "[, replace DOUBle EVery(integer 1)]",
      rest === null ? "" : `,${rest}`,
    ).options,
    file = fileName(name),
    files = (session.files ??= new Map()),
    exists = !!findFile(files, file);
  return {
    file,
    exists,
    replace: !!options.replace,
    type: options.double ? "double" : "float",
    check() {
      if (exists && !options.replace)
        throw new StataError(`file ${file} already exists`, 602);
    },
    note(ctx) {
      if (options.replace && !exists) ctx.out(`(file ${file} not found)`);
    },
    /** Writes the replicates: columns of { name, label, values }. */
    write(columns, label) {
      const data = new Dataset({ defaultType: session.data.defaultType });
      data.n = columns[0]?.values.length ?? 0;
      for (const column of columns) {
        data.generate(
          column.name,
          column.values.map((v) =>
            v === null || v === undefined ? MISSING : v,
          ),
          { type: this.type },
        );
        data.get(column.name).label = column.label;
      }
      data.label = label;
      const when = stamp();
      files.set(findFile(files, file) || file, {
        ...data.snapshot(),
        timestamp: when,
      });
      return { data, when };
    },
  };
}
/** The variables a saved file holds: _b_x for _b[x], or the names given. */
function savedColumns(parts, model, all) {
  const names = parts.coefficients
    ? model.names.map((name) =>
        `_b_${name.replace(/^_/, "").replace(/[^A-Za-z0-9_]/g, "_")}`.slice(
          0,
          32,
        ),
      )
    : parts.items.map((item) => item.name);
  return names.map((name, k) => ({
    name,
    label: (parts.coefficients
      ? `_b[${model.names[k]}]`
      : parts.items[k].expression
    ).slice(0, 80),
    values: all.map((values) => (values ? values[k] : null)),
  }));
}

function sample(session, text, ctx) {
  const m = /^\s*([^,]*?)\s*(,[\s\S]*)?$/.exec(text),
    isCount = /^,\s*c(o(u(nt?)?)?)?\s*$/.test(m[2] ?? ""),
    data = session.data;
  if (m[2] && !isCount)
    throw new StataError("sample with by() is not available yet", 198);
  const amount = session.scalar(m[1]);
  if (isMissing(amount) || amount < 0)
    throw new StataError("invalid syntax", 198);
  if (!data.n) return;
  const keep = Math.min(
      data.n,
      isCount ? Math.trunc(amount) : Math.trunc((data.n * amount) / 100 + 0.5),
    ),
    // Two uniform keys per observation; the second only separates ties.
    first = Array.from({ length: data.n }, () => uniform(session)),
    second = Array.from({ length: data.n }, () => uniform(session)),
    order = first
      .map((_, i) => i)
      .sort((a, b) => first[a] - first[b] || second[a] - second[b]),
    dropped = data.n - keep;
  takeRows(data, order.slice(0, keep));
  ctx.out(`(${count(dropped)} observation${dropped === 1 ? "" : "s"} deleted)`);
}

/** "left: command", split at the first colon outside quotes and brackets. */
function splitPrefix(text) {
  let depth = 0,
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if ("([".includes(c)) depth++;
    else if (")]".includes(c)) depth--;
    else if (c === ":" && !depth)
      return [text.slice(0, i), text.slice(i + 1).trim()];
  }
  throw new StataError("a command is required after the colon", 198);
}
/** The statistics asked for: name=exp or a bare expression. */
function expressionList(given, stem) {
  // Spaces around = belong to one item: "b = r(mean)" is "b=r(mean)".
  const text = given.replace(/\s*=\s*/g, "="),
    items = [];
  let depth = 0,
    start = 0;
  const flush = (end) => {
    const piece = text.slice(start, end).trim();
    if (piece) items.push(piece);
    start = end + 1;
  };
  [...text].forEach((c, i) => {
    if ("([".includes(c)) depth++;
    else if (")]".includes(c)) depth--;
    else if (/\s/.test(c) && !depth) flush(i);
  });
  flush(text.length);
  let unnamed = 0;
  return items.map((item) => {
    let m;
    if ((m = /^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(item)))
      // Stata shows the expression without the parentheses around it.
      return {
        name: m[1],
        expression: m[2]
          .trim()
          .replace(/^\(([^()]*(?:\([^()]*\)[^()]*)*)\)$/, "$1"),
      };
    return {
      name: `${stem}${++unnamed}`,
      expression: item.replace(/^\(([\s\S]*)\)$/, "$1"),
    };
  });
}
function prefixParts(session, text, stem, declaration) {
  const [left, command] = splitPrefix(text),
    comma = left.indexOf(","),
    head = (comma < 0 ? left : left.slice(0, comma)).trim(),
    options = session.parse(
      `[, ${declaration}]`,
      comma < 0 ? "" : left.slice(comma),
    ).options,
    coefficients = !head || /^_b$/.test(head);
  if (!command) throw new StataError("a command is required", 198);
  return {
    command,
    options,
    coefficients,
    items: coefficients ? [] : expressionList(head, stem),
  };
}
/**
 * The line of dots: a mark for every `every` replications and for the
 * last, the count in place of the mark at each tenth, and where one failed
 * its mark: x for an error (or a statistic missing or rejected), n for a
 * jackknife replicate whose sample size was not one fewer. A legend of the
 * marks shown follows.
 */
const MARKS = {
  x: (prefix, name) => `x: Error occurred when ${prefix} executed ${name}.`,
  n: () =>
    "n: Sample size for the replicate did not equal the expected sample size.",
};
const dots = (session, ctx, title, total, failed, every = 1, legend = null) => {
  const width = session.settings.linesize ?? 80,
    seen = new Set();
  let line = `${title} (${count(total)}): `,
    bad = null;
  for (let k = 1; k <= total; k++) {
    if (failed.has(k)) bad ??= failed.get(k);
    if (k % every !== 0 && k !== total) continue;
    const mark = bad ?? (k % (10 * every) === 0 ? String(k) : ".");
    if (bad) seen.add(bad);
    bad = null;
    if (line.length + mark.length > width) {
      ctx.out(line);
      line = "";
    }
    line += mark;
  }
  ctx.out(`${line} done`);
  if (legend)
    for (const mark of Object.keys(MARKS))
      if (seen.has(mark)) ctx.out(MARKS[mark](legend.prefix, legend.name));
};
/** The note under a table when some replicates gave no statistics. */
function incomplete(ctx, failed, prefix) {
  if (!failed.size) return;
  ctx.out(
    `Note: One or more parameters could not be estimated in ${count(failed.size)} ${prefix} replicate${failed.size === 1 ? "" : "s"};`,
  );
  ctx.out("      standard-error estimates include only complete replications.");
}
/**
 * Wraps a note as Stata wraps a paragraph, two columns short of the line
 * size, later lines indented under the first.
 */
function wrapped(session, ctx, text, indent) {
  const width = session.settings.linesize ?? 80;
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width - 2) {
      ctx.out(line);
      line = " ".repeat(indent) + word;
    } else line = line ? `${line} ${word}` : word;
  }
  ctx.out(line);
}

/** The statistics of the run just made, or null if one is missing. */
function statistics(session, parts) {
  if (parts.coefficients) {
    const model = session.estimates;
    if (!model) throw new StataError("last estimates not found", 301);
    return model.b.slice();
  }
  const values = parts.items.map((item) => session.scalar(item.expression));
  return values.some((v) => typeof v !== "number" || isMissing(v))
    ? null
    : values;
}
/**
 * Runs the command on a sample and returns the statistics, or null if it
 * fails or reject() rejects them.
 */
function evaluate(session, ctx, parts, command = parts.command) {
  try {
    session.runLine(`quietly ${command}`, ctx.frame, []);
  } catch (error) {
    if (error instanceof StataError) return null;
    throw error;
  }
  const values = statistics(session, parts);
  return values && parts.reject && rejected(session, parts.reject)
    ? null
    : values;
}
/** reject(exp) is true, as assert reads it: anything but zero. */
function rejected(session, expression) {
  let value;
  try {
    value = session.scalar(expression);
  } catch (error) {
    if (!(error instanceof StataError)) throw error;
    throw new StataError(`reject() incorrectly specified: ${expression}`, 198);
  }
  if (typeof value !== "number")
    throw new StataError(`reject() incorrectly specified: ${expression}`, 198);
  return value !== 0;
}
/**
 * The run on the whole sample. Its failure stops the prefix with the
 * command's message and, as Stata adds, which prefix ran it; a statistic
 * missing there stops it too. "(running ... on estimation sample)" comes
 * first, unless the dots are off.
 */
function observe(session, ctx, parts, command, prefix, quiet) {
  const name = commandName(parts.command),
    running = () => {
      if (!quiet) ctx.out(`(running ${name} on estimation sample)`);
    };
  // The prefix clears e() first, so that e(N) is a count of this run.
  session.estimates = null;
  session.results.e = {};
  try {
    session.runLine(`quietly ${command}`, ctx.frame, []);
  } catch (error) {
    if (!(error instanceof StataError)) throw error;
    // jackknife reads over() before it runs the command.
    if (prefix === "jackknife" && /invalid over\(\) option/.test(error.message))
      throw error;
    running();
    throw new StataError(
      `${error.message}\nan error occurred when ${prefix} executed ${name}`,
      error.code,
      error.hint,
    );
  }
  running();
  if (!parts.coefficients)
    for (const item of parts.items) {
      const value = session.scalar(item.expression);
      if (typeof value !== "number" || isMissing(value))
        throw new StataError(
          prefix === "bootstrap"
            ? `'${item.expression}' evaluated to missing in full sample`
            : `statistic ${item.expression} evaluated to missing in full sample`,
          322,
        );
    }
  const values = statistics(session, parts);
  if (parts.reject && rejected(session, parts.reject))
    throw new StataError(
      `${prefix} rejected results from ${name} while using the entire dataset`,
      9,
    );
  return values;
}
/**
 * The if and in of the command a prefix runs: the rows they select, and
 * the command without them, which the prefix runs on those rows.
 */
function commandSample(session, command) {
  const [head, options] = splitAtComma(command),
    all = clauses(head),
    found = all.filter((c) => c.kind === "if" || c.kind === "in");
  if (!found.length) return { rows: null, stripped: command };
  const end = (c) => all.find((d) => d.at > c.at)?.at ?? head.length;
  let kept = head;
  for (const c of [...found].reverse())
    kept = kept.slice(0, c.at) + kept.slice(end(c));
  const qualifiers = found.map((c) => head.slice(c.at, end(c))).join(" "),
    parsed = session.parse("[if] [in]", ` ${qualifiers}`);
  return {
    rows: session.rows(parsed, null),
    stripped: `${kept.trim()}${options === null ? "" : `, ${options.trim()}`}`,
  };
}
// Stata keeps the replicates in single precision unless saving() asks for
// double, which shows in about the seventh digit of the standard errors.
const stored = (values, double) =>
  values && !double ? values.map(Math.fround) : values;
const commandName = (command) => /^\s*(\w+)/.exec(command)?.[1] ?? "";

/** The header a refitted regress prints under bootstrap or jackknife. */
function modelHeader(ctx, model, reps, test, nstrata = 0) {
  const four = (value) => applyFormat(value, "%6.4f").trim(),
    pairs = [
      ["Number of obs", count(model.N)],
      ["Replications", count(reps)],
      [test.label, applyFormat(test.value, "%7.2f").trim()],
      [test.pLabel, four(test.p)],
      ...(model.command === "regress"
        ? [
            ["R-squared", four(model.r2)],
            ["Adj R-squared", four(model.r2_a)],
            ["Root MSE", four(model.rmse)],
          ]
        : []),
    ];
  // The models fitted by likelihood report it, and their pseudo R2. With
  // sampling weights it is a pseudolikelihood, and poisson then has no
  // pseudo R2: the line takes the place of the p-value's.
  const likelihood = model.r2_p !== undefined && model.ll !== undefined,
    last = likelihood && isMissing(model.r2_p) ? pairs.pop() : null,
    log = `${model.wtype === "pweight" ? "Log pseudolikelihood" : "Log likelihood"} = ${g(model.ll, "%10.0g")}`;
  if (likelihood && !last) pairs.push(["Pseudo R2", four(model.r2_p)]);
  // The numbers keep a blank after the =: a negative one (Adj R-squared
  // = -0.0017) widens their column, and the column moves left.
  const digits = Math.max(
      7,
      ...pairs.map(([, value]) =>
        value.startsWith("-") ? value.length + 1 : 0,
      ),
    ),
    at = 63 - digits,
    side = ([label, value]) => `${label.padEnd(14)}=${value.padStart(digits)}`,
    lines = pairs.slice(0, likelihood && !last ? -1 : undefined).map(side);
  // With strata the title stands alone, their number beside the first
  // line.
  const heading = model.title ?? "Linear regression";
  if (nstrata) {
    ctx.out(heading);
    ctx.out("");
  }
  lines.forEach((line, k) =>
    ctx.out(
      `${(k ? "" : nstrata ? `Number of strata = ${count(nstrata)}` : heading).padEnd(at)}${line}`,
    ),
  );
  if (last) ctx.out(`${log.padEnd(at)}${side(last)}`);
  else if (likelihood) ctx.out(`${log.padEnd(at)}${side(pairs.at(-1))}`);
  ctx.out("");
}

/**
 * The first column of a resampled coefficient table, as wide as the fitted
 * command makes it (see tableWidth): the models fitted by likelihood count
 * their dependent variable, regress and xtreg do not.
 */
const LIKELIHOOD = ["logit", "probit", "poisson", "logistic"];
function columns(session, model) {
  const w = tableWidth(
    session,
    model,
    LIKELIHOOD.includes(model.command) ? [model.depvar] : [],
  );
  return {
    w,
    rule: "-".repeat(66 + w),
    split: `${"-".repeat(w + 1)}+${"-".repeat(64)}`,
    depvar: abbreviate(model.depvar, w).padStart(w),
  };
}
/**
 * The header of a table of statistics: the title (or the number of strata)
 * and the counts, right-aligned together so that they end in column 78;
 * then the command and the statistics' legend. noheader and nolegend leave
 * out either part.
 */
function resultsHeader(ctx, title, n, reps, command, items, layout = {}) {
  const { nstrata = 0, header = true, legend = true } = layout,
    width = Math.max(count(n).length, count(reps).length),
    obs = `Number of obs = ${count(n).padStart(width)}`,
    at = 78 - obs.length;
  if (header) {
    if (nstrata) {
      ctx.out(title);
      ctx.out("");
    }
    ctx.out(
      `${(nstrata ? `Number of strata = ${count(nstrata)}` : title).padEnd(at)}${obs}`,
    );
    ctx.out(`${" ".repeat(at)}Replications  = ${count(reps).padStart(width)}`);
    ctx.out("");
  }
  if (legend) {
    ctx.out(`      Command: ${command.replace(/ {2,}/g, " ")}`);
    for (const item of items)
      ctx.out(`${abbreviate(item.name, 12).padStart(13)}: ${item.expression}`);
    ctx.out("");
  }
}
const tableRow = (label, b, se, statistic, p, low, high) =>
  `${label}|${g(b).padStart(11)}${g(se).padStart(11)}${applyFormat(statistic, "%9.2f")}${applyFormat(p, "%8.3f")}${g(low).padStart(13)}${g(high).padStart(12)}`;
/**
 * A coefficient's row; with the exponentiated form the fitted command was
 * asked for (odds ratios, incidence-rate ratios), the coefficient and its
 * interval are exponentiated and the standard error is exp(b) se, by the
 * delta method, while the test stays on the coefficient.
 */
function coefficientRow(label, b, se, statistic, p, critical, eform) {
  const show = eform ? Math.exp : (v) => v;
  return tableRow(
    label,
    show(b),
    eform ? Math.exp(b) * se : se,
    statistic,
    p,
    show(b - critical * se),
    show(b + critical * se),
  );
}
/** The heading of the coefficient column: eform's label, or `word`. */
const coefficientHead = (eform, word) =>
  eform ? word(eform[1]).padStart(10).padEnd(11) : word("Coefficient");

/** The covariance of the replicate statistics about their mean. */
function covariance(replicates, scale, center = null) {
  const k = replicates[0].length,
    mean =
      center ??
      Array.from(
        { length: k },
        (_, j) => replicates.reduce((t, r) => t + r[j], 0) / replicates.length,
      );
  return Array.from({ length: k }, (_, a) =>
    Array.from(
      { length: k },
      (_, c) =>
        scale *
        replicates.reduce((t, r) => t + (r[a] - mean[a]) * (r[c] - mean[c]), 0),
    ),
  );
}
/** The Wald statistic that all slopes are zero. */
function wald(model) {
  const at = model.names
      .map((name, k) => (name !== "_cons" && model.estimable[k] ? k : -1))
      .filter((k) => k >= 0),
    inverse = invertSymmetric(at.map((r) => at.map((c) => model.V[r][c])));
  return {
    df: at.length,
    value: inverse
      ? quadratic(
          at.map((k) => model.b[k]),
          inverse,
        )
      : MISSING,
  };
}

/**
 * What bootstrap keeps beside e(b) and e(V), as _bs_sum.ado computes it
 * from the replicates: their mean, number, bias and standard deviation,
 * the median bias z0, and the normal, percentile and bias-corrected
 * intervals, each a matrix named by the statistics.
 */
function bootstrapMatrices(names, observed, replicates, level) {
  const k = names.length,
    zalpha = invnormal((100 + level) / 200),
    row = (values) => ({ rowNames: ["y1"], colNames: names, values: [values] }),
    pair = (low, high) => ({
      rowNames: ["ll", "ul"],
      colNames: names,
      values: [low, high],
    }),
    stats = Array.from({ length: k }, (_, j) => {
      const x = replicates.map((r) => r[j]),
        n = x.length,
        mean = x.reduce((t, v) => t + v, 0) / n,
        sd = Math.sqrt(x.reduce((t, v) => t + (v - mean) ** 2, 0) / (n - 1)),
        sorted = [...x].sort((a, b) => a - b),
        b = observed[j],
        below = x.filter((v) => v <= b).length,
        // _pctile takes percentiles strictly between 0 and 100.
        pctile = (p) => (p > 0 && p < 100 ? percentile(sorted, p) : MISSING);
      let z0 = MISSING,
        bc = [MISSING, MISSING];
      if (below > 0 && below < n) {
        z0 = invnormal(below / n);
        bc = [
          pctile(100 * normal(2 * z0 - zalpha)),
          pctile(100 * normal(2 * z0 + zalpha)),
        ];
      }
      return {
        n,
        mean,
        sd,
        bias: mean - b,
        z0,
        normal: [b - zalpha * sd, b + zalpha * sd],
        percentile: [
          percentile(sorted, (100 - level) / 2),
          percentile(sorted, (100 + level) / 2),
        ],
        bc,
      };
    }),
    each = (f) => stats.map(f);
  return {
    b_bs: row(each((s) => s.mean)),
    reps: row(each((s) => s.n)),
    bias: row(each((s) => s.bias)),
    z0: row(each((s) => s.z0)),
    se: row(each((s) => s.sd)),
    ci_normal: pair(
      each((s) => s.normal[0]),
      each((s) => s.normal[1]),
    ),
    ci_percentile: pair(
      each((s) => s.percentile[0]),
      each((s) => s.percentile[1]),
    ),
    ci_bc: pair(
      each((s) => s.bc[0]),
      each((s) => s.bc[1]),
    ),
  };
}
/** Matrices as e() holds them: "matrix:name" keys. */
const asResults = (matrices) =>
  Object.fromEntries(
    Object.entries(matrices).map(([name, value]) => [`matrix:${name}`, value]),
  );

/** reject(exp) or reject(if exp), as _prefix_reject reads it. */
const rejection = (text) =>
  text === undefined ? null : text.trim().replace(/^if\s+/, "") || null;

/** The heading of the error column: Bootstrap, or Bstrap * with mse. */
const errorHead = (prefix, mse) =>
  prefix === "bootstrap"
    ? mse
      ? "Bstrap *"
      : "Bootstrap                         Normal-based"
    : mse
      ? "Jknife *"
      : "Jackknife";

function bootstrap(session, text, ctx) {
  const parts = prefixParts(
      session,
      text,
      "_bs_",
      "Reps(integer 50) Level(cilevel) NODOTS DOTS(string) noHEader noLEGend noTABle SEED(string) SAving(string) STRata(varlist) CLuster(varlist) IDcluster(string) SIze(string) MSE REJect(string) noDROP FORCE GRoup(string) | BCA",
    ),
    options = parts.options,
    { reps, level } = options,
    data = session.data,
    name = commandName(parts.command),
    before = session.estimates,
    every = dotsEvery(options),
    quiet = every === 0,
    strataNames = options.strata ?? [],
    clusterNames = options.cluster ?? [],
    idcluster = options.idcluster?.trim(),
    nodrop = options.drop === false,
    mse = !!options.mse;
  parts.reject = rejection(options.reject);
  if (reps < 2)
    throw new StataError(
      "option reps() requires an integer greater than 1",
      198,
    );
  if (idcluster && !clusterNames.length)
    throw new StataError("option idcluster() requires option cluster()", 198);
  if (options.group !== undefined && !idcluster)
    throw new StataError("option group() requires option idcluster()", 198);
  if (options.group !== undefined)
    throw new StataError(
      "option group() is not available in the browser yet",
      198,
      "Resample the clusters with cluster() and idcluster(); the groups within them keep their own identifiers.",
    );
  if (idcluster && !isName(idcluster))
    throw new StataError(`${idcluster} invalid name`, 198);
  // Stata resamples observations, which a weight would stand in for.
  if (clauses(splitAtComma(parts.command)[0]).some((c) => c.kind === "weight"))
    throw new StataError("weights not allowed with bootstrap estimation", 101);
  const saving = savingTarget(session, options.saving),
    double = saving?.type === "double";
  // idcluster() names the clusters of the data in memory too, as
  // egen group() numbers them, when it is a new variable.
  if (idcluster && !data.has(idcluster))
    session.runLine(
      `quietly egen ${idcluster} = group(${clusterNames.join(" ")})`,
      ctx.frame,
      [],
    );
  // The if and in of the command choose the observations resampled, and
  // the command runs on them without its if and in; nodrop keeps every
  // observation and the command as typed.
  const sample = nodrop
      ? { rows: null, stripped: parts.command }
      : commandSample(session, parts.command),
    command = sample.stripped,
    snapshot = data.snapshot({ marks: true }),
    title = `Bootstrap replications (${count(reps)}): `,
    replicates = [],
    all = [],
    failed = new Map();
  let observed,
    model = null,
    kept = null,
    n,
    nstrata = 0,
    nclust = 0,
    size = null;
  try {
    if (sample.rows) takeRows(data, sample.rows);
    observed = observe(session, ctx, parts, command, "bootstrap", quiet);
    model = session.estimates;
    kept = { e: { ...session.results.e }, r: { ...session.results.r } };
    if (parts.coefficients && !model)
      throw new StataError("expression list required", 198);
    saving?.check();
    applySeed(session, options.seed);
    if (!model && !nodrop) {
      ctx.out("");
      wrapped(
        session,
        ctx,
        `warning: ${name} does not set e(sample), so no observations will be excluded from the resampling because of missing values or other reasons. To exclude observations, press Break, save the data, drop any observations that are to be excluded, and rerun bootstrap.`,
        9,
      );
    }
    saving?.note(ctx);
    // An estimation command is resampled within its estimation sample.
    if (model?.sample && !nodrop)
      takeRows(
        data,
        [...new Set(model.sample)].sort((a, b) => a - b),
      );
    n = data.n;
    let layout = { strata: null, clusters: null };
    if (strataNames.length || clusterNames.length) {
      for (const cname of clusterNames) {
        const v = data.get(cname);
        if (
          Array.from({ length: data.n }).some((_, i) =>
            isStringType(v.type) ? v.data[i] === "" : isMissing(v.data[i]),
          )
        )
          throw new StataError(
            `missing values in cluster variable ${cname} not allowed`,
            459,
          );
      }
      layout = arrange(session, strataNames, clusterNames);
      nstrata = strataNames.length ? layout.nstrata : 0;
      if (clusterNames.length)
        nclust = new Set(
          layout.clusters.map((c, i) => `${layout.strata?.[i] ?? 1}:${c}`),
        ).size;
    }
    if (options.size !== undefined && options.size.trim() !== "_N") {
      size = session.scalar(options.size);
      if (layout.clusters) {
        const per = new Map();
        layout.clusters.forEach((c, i) => {
          const s = layout.strata?.[i] ?? 1;
          if (!per.has(s)) per.set(s, new Set());
          per.get(s).add(c);
        });
        if ([...per.values()].some((set) => size > set.size))
          throw new StataError(
            "size() must not be greater than number of clusters",
            498,
          );
      }
    }
    // A blank line before the dots, or else before the header.
    if (!quiet || options.header !== false) ctx.out("");
    const base = data.snapshot();
    for (let rep = 1; rep <= reps; rep++) {
      let drawn;
      try {
        drawn = resample(session, n, {
          ...layout,
          size,
          idcluster: !!idcluster,
        });
      } catch (error) {
        // The first sample's error follows the title of the dots.
        if (error instanceof StataError && !quiet)
          throw new StataError(`${title}${error.message}`, error.code);
        throw error;
      }
      takeRows(data, drawn.rows);
      if (idcluster) setClusterIds(data, idcluster, drawn.ids);
      const values = stored(evaluate(session, ctx, parts, command), double);
      all.push(values);
      if (values) replicates.push(values);
      else failed.set(rep, "x");
      data.restore(base);
    }
  } finally {
    data.restore(snapshot);
    session.estimates = model ?? before;
    if (kept) {
      session.results.e = kept.e;
      session.results.r = kept.r;
    }
    // e(sample) names the rows of the data in memory.
    if (model?.sample && sample.rows)
      model.sample = model.sample.map((i) => sample.rows[i]);
  }
  if (replicates.length < 2)
    throw new StataError(
      "insufficient observations to compute bootstrap standard errors\nno results will be saved",
      2000,
    );
  // mse: the replicates' spread about the observed value, over their
  // number.
  const V = mse
      ? covariance(replicates, 1 / replicates.length, observed)
      : covariance(replicates, 1 / (replicates.length - 1)),
    critical = invnormal(1 - (1 - level / 100) / 2),
    eform = parts.coefficients ? model.eform : null,
    row = (label, k) => {
      const se = Math.sqrt(V[k][k]),
        z = observed[k] / se;
      return coefficientRow(
        label,
        observed[k],
        se,
        z,
        2 * normal(-Math.abs(z)),
        critical,
        eform,
      );
    };
  if (!quiet) {
    dots(session, ctx, "Bootstrap replications", reps, failed, every, {
      prefix: "bootstrap",
      name,
    });
    ctx.out("");
  }
  if (saving)
    saving.write(savedColumns(parts, model, all), `bootstrap: ${name}`);
  const design = {
      nstrata,
      cluster: clusterNames.length
        ? `(Replications based on ${count(nclust)} clusters in ${clusterNames.join(" ")})`
        : null,
    },
    designResults = {
      ...(clusterNames.length ? { N_clust: nclust } : {}),
      ...(strataNames.length ? { N_strata: nstrata } : {}),
    },
    designMacros = {
      ...(size !== null ? { size: options.size.trim() } : {}),
      ...(strataNames.length ? { strata: strataNames.join(" ") } : {}),
      ...(clusterNames.length
        ? { clustvar: clusterNames.join(" "), cluster: clusterNames.join(" ") }
        : {}),
    },
    names = parts.coefficients
      ? model.names
      : parts.items.map((item) => item.name),
    extras = asResults(bootstrapMatrices(names, observed, replicates, level)),
    shown = {
      header: options.header !== false,
      legend: options.legend !== false,
      table: options.table !== false,
    };
  if (parts.coefficients) {
    model.V = V;
    model.vce = "bootstrap";
    model.vcetype = mse ? "Bstrap *" : "Bootstrap";
    model.dist = "z";
    const test = wald(model),
      p = chi2tail(test.df, test.value);
    Object.assign(session.results.e, {
      N_reps: replicates.length,
      N_misreps: failed.size,
      ...designResults,
      chi2: test.value,
      p,
      level,
      bs_version: 3,
      k_eq: 1,
      k_exp: 0,
      k_eexp: model.names.length,
      k_extra: 0,
      cmdline: `bootstrap ${text.trim()}`,
      chi2type: "Wald",
      cmdname: name,
      prefix: "bootstrap",
      ...Object.fromEntries(
        model.names.map((coef, k) => [`exp${k + 1}`, `_b[${coef}]`]),
      ),
      command: command.replace(/ {2,}/g, " "),
      vcetype: mse ? "Bstrap *" : "Bootstrap",
      ...(mse ? { mse: "mse" } : {}),
      vce: "bootstrap",
      ...designMacros,
      ...extras,
    });
    delete session.results.e.F;
    delete session.results.e.df_r;
    // ratio shows its own table, as Stata's prefixes leave it to.
    if (model.resampledDisplay) {
      model.resampledDisplay(ctx, level, {
        method: "bootstrap",
        reps: replicates.length,
        se: model.b.map((_, k) => Math.sqrt(V[k][k])),
        critical,
        note: design.cluster,
        nstrata: design.nstrata,
        mse,
      });
      incomplete(ctx, failed, "bootstrap");
      ctx.out("");
      return;
    }
    if (shown.header)
      modelHeader(
        ctx,
        // nodrop resamples every observation, which the header counts.
        nodrop ? { ...model, N: n } : model,
        replicates.length,
        {
          label: `Wald chi2(${test.df})`,
          value: test.value,
          pLabel: "Prob > chi2",
          p,
        },
        design.nstrata,
      );
    if (!shown.table) return;
    const table = columns(session, model);
    if (design.cluster) ctx.out(design.cluster.padStart(table.rule.length));
    ctx.out(table.rule);
    ctx.out(
      `${" ".repeat(table.w + 1)}|   Observed   ${errorHead("bootstrap", mse)}`,
    );
    ctx.out(
      `${table.depvar} | ${coefficientHead(eform, (v) => v.toLowerCase())}  std. err.      z    P>|z|     [${g(level)}% conf. interval]`,
    );
    ctx.out(table.split);
    // A coefficient fixed at zero is a ratio of one.
    termRows(
      session,
      model,
      (k) => row("", k).slice(1),
      table.w,
      eform ? 1 : 0,
    ).forEach(ctx.out);
    ctx.out(table.rule);
    if (eform && model.constant) ctx.out(eform[2]);
    incomplete(ctx, failed, "bootstrap");
  } else {
    resultsHeader(
      ctx,
      "Bootstrap results",
      n,
      replicates.length,
      command,
      parts.items,
      { nstrata: design.nstrata, ...shown },
    );
    if (shown.table) {
      if (design.cluster) ctx.out(design.cluster.padStart(RULE.length));
      ctx.out(RULE);
      ctx.out(`             |   Observed   ${errorHead("bootstrap", mse)}`);
      ctx.out(
        `             | coefficient  std. err.      z    P>|z|     [${g(level)}% conf. interval]`,
      );
      ctx.out(SPLIT);
      parts.items.forEach((item, k) =>
        ctx.out(row(`${abbreviate(item.name, 12).padStart(12)} `, k)),
      );
      ctx.out(RULE);
      incomplete(ctx, failed, "bootstrap");
    }
    // e() holds the bootstrap's own results, as Stata's does: e(b) and
    // e(V) of the statistics, and the matrices bstat reports.
    session.estimates = null;
    session.results.e = {
      level,
      N_reps: replicates.length,
      N_misreps: failed.size,
      ...designResults,
      bs_version: 3,
      rank: parts.items.length,
      k_eq: 1,
      k_exp: parts.items.length,
      k_eexp: 0,
      k_extra: 0,
      N: n,
      cmdline: `bootstrap ${text.trim()}`,
      cmd: "bootstrap",
      ...(size !== null ? { size: options.size.trim() } : {}),
      cmdname: name,
      prefix: "bootstrap",
      title: "Bootstrap results",
      ...Object.fromEntries(
        parts.items.map((item, k) => [`exp${k + 1}`, item.expression]),
      ),
      command: command.replace(/ {2,}/g, " "),
      ...(strataNames.length ? { strata: strataNames.join(" ") } : {}),
      ...(clusterNames.length
        ? { clustvar: clusterNames.join(" "), cluster: clusterNames.join(" ") }
        : {}),
      vcetype: mse ? "Bstrap *" : "Bootstrap",
      vce: "bootstrap",
      ...(mse ? { mse: "mse" } : {}),
      properties: "b V",
      "matrix:b": { rowNames: ["y1"], colNames: names, values: [observed] },
      "matrix:V": { rowNames: names, colNames: names, values: V },
      ...extras,
      "function:sample": true,
    };
    // e(sample) is every observation the replicates were drawn from.
    session.postedSample =
      sample.rows ?? Array.from({ length: data.n }, (_, i) => i);
  }
  ctx.out("");
}

function jackknife(session, text, ctx) {
  const parts = prefixParts(
      session,
      text,
      "_jk_",
      "Level(cilevel) NODOTS DOTS(string) noHEader noLEGend noTABle CLuster(varlist) IDcluster(string) SAving(string) MSE KEEP RCLass ECLass N(string) REJect(string) noDROP FORCE",
    ),
    options = parts.options,
    level = options.level,
    data = session.data,
    name = commandName(parts.command),
    before = session.estimates,
    every = dotsEvery(options),
    quiet = every === 0,
    clusterNames = options.cluster ?? [],
    nodrop = options.drop === false,
    mse = !!options.mse,
    given = [
      options.eclass && "eclass",
      options.rclass && "rclass",
      options.n !== undefined && "n()",
    ].filter(Boolean);
  if (given.length > 1)
    throw new StataError(`options ${given.join(" ")} may not be combined`, 198);
  parts.reject = rejection(options.reject);
  const saving = savingTarget(session, options.saving),
    double = saving?.type === "double",
    // jackknife shows the command as typed, but runs it, as bootstrap
    // does, on the observations its if and in select.
    sample = nodrop
      ? { rows: null, stripped: parts.command }
      : commandSample(session, parts.command),
    command = sample.stripped,
    snapshot = data.snapshot({ marks: true }),
    replicates = [],
    all = [],
    failed = new Map();
  let observed,
    model = null,
    kept = null,
    nfunction = null,
    origin = null,
    n,
    groups;
  try {
    if (sample.rows) takeRows(data, sample.rows);
    observed = observe(session, ctx, parts, command, "jackknife", quiet);
    model = session.estimates;
    kept = { e: { ...session.results.e }, r: { ...session.results.r } };
    if (parts.coefficients && !model)
      throw new StataError("expression list required", 198);
    // Stata leaves out a frequency-weighted observation one unit at a time
    // and scales importance-weighted replicates; neither is done here.
    if (model?.wtype === "fweight" || model?.wtype === "iweight")
      throw new StataError(
        `jackknife with ${model.wtype}s is not available yet; pweights are`,
        198,
      );
    if (options.idcluster !== undefined && !clusterNames.length)
      throw new StataError(
        "option idcluster() requires the cluster() option",
        198,
      );
    if (options.keep && parts.coefficients)
      throw new StataError(
        "option keep is not available in the browser yet for coefficients",
        198,
        "Name the statistics, as in jackknife b=_b[x], keep: ..., to keep their pseudovalues.",
      );
    if (options.keep)
      for (const item of parts.items)
        if (data.has(item.name))
          throw new StataError(`variable ${item.name} already defined`, 110);
    saving?.check();
    // n(): the number of observations a run uses, r(N) or e(N) unless
    // given; a replicate that does not use one fewer is set aside.
    nfunction =
      options.n?.trim() ||
      (options.eclass
        ? "e(N)"
        : options.rclass
          ? "r(N)"
          : model
            ? "e(N)"
            : "r(N)");
    const full = Math.trunc(session.scalar(nfunction)),
      asked = given.length > 0;
    // Without n(), rclass or eclass, a command that leaves no count is not
    // checked.
    if (asked && (isMissing(full) || full === 0))
      throw new StataError(
        `number of obs ${nfunction} evaluated to ${isMissing(full) ? "missing" : "zero"} in full sample`,
        322,
      );
    // origin: the row of the data in memory each row used comes from.
    origin = sample.rows ?? Array.from({ length: data.n }, (_, i) => i);
    if (model?.sample && !nodrop) {
      const used = [...new Set(model.sample)].sort((a, b) => a - b);
      takeRows(data, used);
      origin = used.map((i) => origin[i]);
    }
    n = data.n;
    if (clusterNames.length) {
      // One replication leaves out each cluster, in their sorted order.
      for (const cname of clusterNames) {
        const v = data.get(cname);
        if (
          Array.from({ length: data.n }).some((_, i) =>
            isStringType(v.type) ? v.data[i] === "" : isMissing(v.data[i]),
          )
        )
          throw new StataError(
            `missing values not allowed in cluster variable ${cname}`,
            459,
          );
      }
      const { clusters, order } = arrange(session, [], clusterNames);
      origin = order.map((i) => origin[i]);
      groups = runs(
        clusters.map((key, i) => ({ key, i })),
        (row) => row.key,
      ).map((run) => new Set(run.map((row) => row.i)));
      if (groups.length <= 2)
        throw new StataError("jackknife requires more than 2 clusters", 459);
    } else groups = Array.from({ length: n }, (_, i) => new Set([i]));
    const base = data.snapshot(),
      groupOf = new Int32Array(n);
    groups.forEach((left, k) => left.forEach((i) => (groupOf[i] = k)));
    groups.forEach((left, k) => {
      const kept = new Int32Array(n - left.size);
      for (let i = 0, at = 0; i < n; i++) if (groupOf[i] !== k) kept[at++] = i;
      takeRows(data, kept);
      let values = stored(evaluate(session, ctx, parts, command), double);
      if (
        values &&
        (asked || !isMissing(full)) &&
        Math.trunc(session.scalar(nfunction)) !== full - left.size
      ) {
        values = null;
        failed.set(k + 1, "n");
      }
      all.push(values);
      if (values) replicates.push(values);
      else if (!failed.has(k + 1)) failed.set(k + 1, "x");
      data.restore(base);
    });
    // keep: each observation's pseudovalues, n b - (n - 1) b(-i), in
    // variables named for the statistics.
    if (options.keep) {
      // n counts the replicates that gave statistics.
      const G = all.filter(Boolean).length,
        rowsOf = groups.map((left) => [...left]);
      parts.items.forEach((item, j) => {
        const values = new Array(n).fill(MISSING);
        // A cluster's pseudovalue is kept in its first observation.
        all.forEach((r, k) => {
          if (!r) return;
          values[Math.min(...rowsOf[k])] = Math.fround(
            G * observed[j] - (G - 1) * r[j],
          );
        });
        item.pseudo = values;
      });
    }
  } finally {
    data.restore(snapshot);
    session.estimates = model ?? before;
    if (kept) {
      session.results.e = kept.e;
      session.results.r = kept.r;
    }
    if (model?.sample && sample.rows)
      model.sample = model.sample.map((i) => sample.rows[i]);
  }
  const used = replicates.length;
  if (used < 2)
    throw new StataError(
      "insufficient observations to compute jackknife standard errors\nno results will be saved",
      2000,
    );
  saving?.note(ctx);
  // mse: the spread about the observed value rather than the replicates'
  // mean.
  const V = covariance(replicates, (used - 1) / used, mse ? observed : null),
    df = used - 1,
    critical = invttail(df, (1 - level / 100) / 2),
    eform = parts.coefficients ? model.eform : null,
    clusterNote = clusterNames.length
      ? `(Replications based on ${count(groups.length)} clusters in ${clusterNames.join(" ")})`
      : null,
    row = (label, k) => {
      const se = Math.sqrt(V[k][k]),
        t = observed[k] / se;
      return coefficientRow(
        label,
        observed[k],
        se,
        t,
        2 * ttail(df, Math.abs(t)),
        critical,
        eform,
      );
    },
    shown = {
      header: options.header !== false,
      legend: options.legend !== false,
      table: options.table !== false,
    };
  if (!quiet) {
    ctx.out("");
    dots(session, ctx, "Jackknife replications", groups.length, failed, every, {
      prefix: "jackknife",
      name,
    });
  }
  ctx.out("");
  if (saving)
    saving.write(savedColumns(parts, model, all), `jackknife: ${name}`);
  const designResults = clusterNames.length ? { N_clust: groups.length } : {},
    designMacros = clusterNames.length
      ? { clustvar: clusterNames.join(" "), cluster: clusterNames.join(" ") }
      : {},
    names = parts.coefficients
      ? model.names
      : parts.items.map((item) => item.name),
    jackknifeMean = {
      rowNames: ["y1"],
      colNames: names,
      values: [
        names.map((_, j) => replicates.reduce((t, r) => t + r[j], 0) / used),
      ],
    };
  if (parts.coefficients) {
    model.V = V;
    model.vce = "jackknife";
    model.vcetype = mse ? "Jknife *" : "Jackknife";
    model.dist = "t";
    model.df_r = df;
    const test = wald(model),
      F = test.value / test.df,
      p = Ftail(test.df, df, F);
    Object.assign(session.results.e, {
      N_reps: used,
      N_misreps: failed.size,
      ...designResults,
      F,
      p,
      df_r: df,
      k_eq: 1,
      k_exp: 0,
      k_eexp: model.names.length,
      k_extra: 0,
      cmdline: `jackknife ${text.trim()}`,
      cmdname: name,
      prefix: "jackknife",
      nfunction,
      command: parts.command.replace(/ {2,}/g, " "),
      ...Object.fromEntries(
        model.names.map((coef, k) => [`exp${k + 1}`, `_b[${coef}]`]),
      ),
      vcetype: mse ? "Jknife *" : "Jackknife",
      ...(mse ? { mse: "mse" } : {}),
      vce: "jackknife",
      ...designMacros,
      "matrix:b_jk": jackknifeMean,
    });
    if (model.resampledDisplay) {
      model.resampledDisplay(ctx, level, {
        method: "jackknife",
        reps: used,
        se: model.b.map((_, k) => Math.sqrt(V[k][k])),
        critical,
        note: clusterNote,
        mse,
      });
      incomplete(ctx, failed, "jackknife");
      ctx.out("");
      return;
    }
    if (shown.header)
      modelHeader(ctx, model, used, {
        label: `F(${test.df}, ${df})`,
        value: F,
        pLabel: "Prob > F",
        p,
      });
    if (!shown.table) return;
    const table = columns(session, model);
    if (clusterNote) ctx.out(clusterNote.padStart(table.rule.length));
    ctx.out(table.rule);
    ctx.out(
      `${" ".repeat(table.w + 1)}|              ${errorHead("jackknife", mse)}`,
    );
    ctx.out(
      `${table.depvar} | ${coefficientHead(eform, (v) => v)}  std. err.      t    P>|t|     [${g(level)}% conf. interval]`,
    );
    ctx.out(table.split);
    // A coefficient fixed at zero is a ratio of one.
    termRows(
      session,
      model,
      (k) => row("", k).slice(1),
      table.w,
      eform ? 1 : 0,
    ).forEach(ctx.out);
    ctx.out(table.rule);
    if (eform && model.constant) ctx.out(eform[2]);
    incomplete(ctx, failed, "jackknife");
  } else {
    resultsHeader(
      ctx,
      "Jackknife results",
      n,
      used,
      parts.command,
      [...parts.items, { name: "n()", expression: nfunction }],
      shown,
    );
    if (shown.table) {
      if (clusterNote) ctx.out(clusterNote.padStart(RULE.length));
      ctx.out(RULE);
      ctx.out(`             |              ${errorHead("jackknife", mse)}`);
      ctx.out(
        `             | Coefficient  std. err.      t    P>|t|     [${g(level)}% conf. interval]`,
      );
      ctx.out(SPLIT);
      parts.items.forEach((item, k) =>
        ctx.out(row(`${abbreviate(item.name, 12).padStart(12)} `, k)),
      );
      ctx.out(RULE);
      incomplete(ctx, failed, "jackknife");
    }
    // keep: the pseudovalues join the data, in the rows that were used.
    if (options.keep)
      parts.items.forEach((item) => {
        const values = new Array(data.n).fill(MISSING);
        item.pseudo.forEach((v, i) => {
          values[origin[i]] = v;
        });
        data.generate(item.name, values, { type: "float" });
        data.get(item.name).label = `pseudovalues: ${item.expression}`.slice(
          0,
          80,
        );
      });
    // e() holds the jackknife's own results, as Stata's does.
    session.estimates = null;
    session.results.e = {
      df_r: df,
      N_reps: used,
      N_misreps: failed.size,
      ...designResults,
      rank: parts.items.length,
      k_eq: 1,
      k_exp: parts.items.length,
      k_eexp: 0,
      k_extra: 0,
      singleton: MISSING,
      N: n,
      cmdline: `jackknife ${text.trim()}`,
      cmd: "jackknife",
      prefix: "jackknife",
      cmdname: name,
      nfunction,
      command: parts.command.replace(/ {2,}/g, " "),
      ...Object.fromEntries(
        parts.items.map((item, k) => [`exp${k + 1}`, item.expression]),
      ),
      title: "Jackknife results",
      ...designMacros,
      vcetype: mse ? "Jknife *" : "Jackknife",
      ...(mse ? { mse: "mse" } : {}),
      vce: "jackknife",
      properties: "b V",
      "matrix:b": { rowNames: ["y1"], colNames: names, values: [observed] },
      "matrix:V": { rowNames: names, colNames: names, values: V },
      "matrix:b_jk": jackknifeMean,
      "function:sample": true,
    };
    // e(sample) is every observation the replicates were drawn from.
    session.postedSample =
      sample.rows ?? Array.from({ length: data.n }, (_, i) => i);
  }
  ctx.out("");
}

function simulate(session, text, ctx) {
  const parts = prefixParts(
      session,
      text,
      "_sim_",
      "Reps(integer 1) NODOTS DOTS(string) SAving(string) SEED(string) noLegend",
    ),
    options = parts.options,
    reps = options.reps,
    data = session.data,
    every = dotsEvery(options),
    name = commandName(parts.command),
    snapshot = data.snapshot({ marks: true }),
    results = [];
  if (parts.coefficients)
    throw new StataError("simulate needs a list of expressions", 198);
  if (reps < 1) throw new StataError("reps() must be positive", 198);
  const saving = savingTarget(session, options.saving);
  saving?.check();
  applySeed(session, options.seed);
  try {
    for (let rep = 0; rep < reps; rep++) {
      // The data are restored before each run; the random stream moves on.
      data.restore(snapshot);
      const values = evaluate(session, ctx, parts);
      if (!values) {
        data.restore(snapshot);
        session.runLine(parts.command, ctx.frame, []);
        throw new StataError("a statistic is missing", 198);
      }
      results.push(values);
    }
  } catch (error) {
    data.restore(snapshot);
    throw error;
  }
  ctx.out("");
  if (options.legend !== false) {
    ctx.out(`      Command: ${parts.command.replace(/ {2,}/g, " ")}`);
    for (const item of parts.items)
      ctx.out(`${item.name.padStart(13)}: ${item.expression}`);
  }
  saving?.note(ctx);
  ctx.out("");
  if (every) dots(session, ctx, "Simulations", reps, new Set(), every);
  // The results replace the data in memory, one observation per run.
  data.variables = [];
  data.n = reps;
  data.sortedBy = [];
  data.valueLabels = new Map();
  parts.items.forEach((item, k) => {
    data.generate(
      item.name,
      results.map((row) => row[k]),
      { type: saving?.type ?? "float" },
    );
    data.get(item.name).label = item.expression.slice(0, 80);
  });
  data.label = `simulate: ${name}`;
  if (saving) {
    const { when } = saving.write(
      parts.items.map((item, k) => ({
        name: item.name,
        label: item.expression.slice(0, 80),
        values: results.map((row) => row[k]),
      })),
      `simulate: ${name}`,
    );
    settle(data, saving.file, when);
  }
}

/** vce(bootstrap) and vce(jackknife) on an estimation command. */
export function resamplingVce(session, command, text, vce, ctx) {
  const m =
    /^\s*(bootstrap|boot|bs|jackknife|jknife|jack)\b\s*,?\s*([\s\S]*)$/.exec(
      vce,
    );
  if (!m) return false;
  const prefix = m[1].startsWith("b") ? "bootstrap" : "jackknife",
    output = [],
    prefixOptions = m[2].trim() ? [m[2].trim()] : [];
  let [head, rest] = splitAtComma(
    text.replace(/\bvce\s*\((?:[^()]|\([^()]*\))*\)/, ""),
  );
  // nodots and dots() among the command's options are the prefix's.
  if (rest !== null)
    rest = rest.replace(
      /(^|\s)(nodots|dots\s*\([^()]*\))(?=\s|$)/g,
      (_, b, o) => {
        prefixOptions.push(o);
        return b;
      },
    );
  const stripped = rest?.trim()
    ? `${head.trim()}, ${rest.trim()}`
    : head.trim();
  // The prefix's lines are shown even when it stops with an error, whose
  // message the command itself reports.
  let failure = null;
  try {
    session.runLine(
      `${prefix}${prefixOptions.length ? ", " + prefixOptions.join(" ") : ""}: ${command} ${stripped}`,
      ctx.frame,
      output,
    );
  } catch (error) {
    failure = error;
  }
  let lines = (output.at(-1)?.lines ?? []).flatMap((line) =>
    String(line).split("\n"),
  );
  if (failure instanceof StataError) {
    const at = lines.lastIndexOf(`r(${failure.code});`);
    if (at >= 0)
      lines = lines.slice(
        0,
        Math.max(0, at - failure.message.split("\n").length),
      );
  }
  lines.forEach((line) => ctx.out(line));
  if (failure) throw failure;
  return true;
}

hooks.resamplingVce = resamplingVce;

export const RESAMPLING_COMMANDS = [
  { name: "sample", minimum: 6, run: sample },
  { name: "bsample", minimum: 7, run: bsample },
  { name: "bootstrap", minimum: 4, run: bootstrap },
  { name: "bs", minimum: 2, run: bootstrap },
  { name: "jackknife", minimum: 4, run: jackknife },
  { name: "simulate", minimum: 4, run: simulate },
];
