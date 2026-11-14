// How a command was asked to compute its standard errors. A request the
// command does not act on is refused: printing the conventional standard
// errors under vce(cluster id) would be a wrong answer with no warning.
import { StataError } from "./errors.js";
import { isMissing, isStringType } from "./values.js";

const ROBUST = /^r(o(b(u(st?)?)?)?)?$/,
  CLUSTER = /^cl(?:u(?:s(?:t(?:er?)?)?)?)?\s+(\S+)$/;

/**
 * Reads `robust` and `vce()`. `plain` matches the names of the command's own
 * conventional variance (oim, unadjusted, conventional). Returns whether a
 * robust variance was asked for and the cluster variable, if any. multiway
 * false is for commands that, in Stata, refuse more than one cluster
 * variable; for the others it is a feature not yet here.
 */
export function readVce(session, options, plain, { multiway = true } = {}) {
  // cluster(id) is the older spelling of vce(cluster id).
  const text = (
    options.vce ?? (options.cluster ? `cluster ${options.cluster}` : "")
  ).trim();
  if (!text) return { robust: !!options.robust, cluster: null };
  if (ROBUST.test(text)) return { robust: true, cluster: null };
  const match = CLUSTER.exec(text);
  if (match)
    return {
      robust: true,
      cluster: session.data.get(session.varlist(match[1])[0]),
    };
  if (plain.test(text)) return { robust: !!options.robust, cluster: null };
  refuseVce(text, plain, multiway);
}
/**
 * Refuses vce(text): what is not a vce() at all with Stata's own messages,
 * and a variance Stata has but this command here lacks with a hint.
 */
export function refuseVce(text, plain, multiway) {
  const [type, ...more] = text.split(/\s+/);
  if (CLUSTER.test(`${type} x`)) {
    if (!more.length)
      throw new StataError(
        "option vce(cluster clustvar) incorrectly specified",
        198,
      );
    if (!multiway)
      throw new StataError("multiway cluster VCE not allowed", 198);
  } else if (ROBUST.test(type) || plain.test(type))
    throw new StataError("option vce() incorrectly specified", 198);
  else if (!VCETYPES.test(type))
    throw new StataError(`vcetype ${type} not allowed`, 198);
  throw new StataError(`vce(${text}) is not available yet`, 198);
}
/** Variance types Stata's estimation commands know but this one lacks. */
const VCETYPES =
  /^(opg|b(o(o(t(s(t(r(ap?)?)?)?)?)?)?)?|bs|j(a(c(k(k(n(i(fe?)?)?)?)?)?)?)?|jk|hac)$/;

/** Whether observation `i` has no value of the cluster variable. */
export const noCluster = (variable, i) =>
  isStringType(variable.type)
    ? variable.data[i] === ""
    : isMissing(variable.data[i]);

/**
 * The middle of a clustered sandwich: the scores are added within each
 * cluster and the outer products of those sums are added over clusters.
 * `score(k)` is the score of the k-th observation, `rows[k]` its place in
 * the data. Returns the matrix and the number of clusters.
 */
export function clusterMeat(variable, rows, score, size) {
  const sums = new Map();
  rows.forEach((row, k) => {
    const key = variable.data[row],
      sum = sums.get(key) ?? new Array(size).fill(0);
    score(k).forEach((v, a) => (sum[a] += v));
    sums.set(key, sum);
  });
  const meat = Array.from({ length: size }, () => new Array(size).fill(0));
  for (const sum of sums.values())
    for (let a = 0; a < size; a++)
      for (let c = 0; c < size; c++) meat[a][c] += sum[a] * sum[c];
  return { meat, clusters: sums.size };
}

/**
 * The sandwich variance V M V of a maximum-likelihood fit, from the inverse
 * of its information V and each observation's score. M adds the weighted
 * scores within each cluster (each observation is its own when there is no
 * cluster variable) and the outer products of those sums; the result is
 * scaled by G / (G - 1), G being the number of clusters. weights (or null)
 * and rows, the observations' places in the data, follow the scores.
 * Returns the variance and the number of clusters.
 */
export function sandwich(V, scores, weights, cluster, rows) {
  const size = V.length,
    own = { data: scores.map((_, k) => k) },
    weighted = (k) =>
      weights ? scores[k].map((v) => v * weights[k]) : scores[k],
    { meat, clusters } = clusterMeat(
      cluster ?? own,
      cluster ? rows : own.data,
      weighted,
      size,
    ),
    product = (a, b) =>
      a.map((row) =>
        b[0].map((_, c) => row.reduce((t, v, k) => t + v * b[k][c], 0)),
      ),
    scale = clusters / (clusters - 1);
  return {
    V: product(product(V, meat), V).map((row) => row.map((v) => v * scale)),
    clusters,
  };
}

/** The line Stata prints above a table of clustered standard errors. */
export const clusterNote = (clusters, name, count) =>
  `(Std. err. adjusted for ${count(clusters)} clusters in ${name})`.padStart(
    78,
  );
