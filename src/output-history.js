import { estimatedBytes, RESOURCE_LIMITS } from "./resource-limits.js";
const sizes = new WeakMap();
/** Keep receipts separate from the full numerical output they describe. */
export function historyReceipt({
  kind,
  command,
  source,
  effect,
  code,
  message,
}) {
  return { kind, command, source, effect, code, message };
}
function cost(result) {
  return (
    1 +
    (result.rows?.reduce((n, row) => n + (row.values?.length || 1), 0) || 0) +
    (result.model ? result.model.n * (result.model.predictors.length + 1) : 0) +
    (result.entries?.length || 0) * 4 +
    (result.summaryRows?.length || 0) *
      ((result.specs?.length || 0) * 2 + (result.by?.length || 0) + 1)
  );
}
export function retainResults(
  results,
  { entries = 200, cells = 500000, bytes = RESOURCE_LIMITS.resultBytes } = {},
) {
  const size = (result) => {
    if (!sizes.has(result)) sizes.set(result, estimatedBytes(result));
    return sizes.get(result);
  };
  let retainedBytes = results.reduce((n, result) => n + size(result), 0);
  let total = results.reduce((n, result) => n + cost(result), 0);
  let start = 0;
  while (
    start < results.length - 1 &&
    (results.length - start > entries || total > cells || retainedBytes > bytes)
  ) {
    retainedBytes -= size(results[start]);
    total -= cost(results[start++]);
  }
  return start ? results.slice(start) : results;
}
