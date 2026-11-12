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
 * robust variance was asked for and the cluster variable, if any.
 */
export function readVce(session, options, plain) {
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
  throw new StataError(`vce(${text}) is not available yet`, 198);
}

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

/** The line Stata prints above a table of clustered standard errors. */
export const clusterNote = (clusters, name, count) =>
  `(Std. err. adjusted for ${count(clusters)} clusters in ${name})`.padStart(
    78,
  );
