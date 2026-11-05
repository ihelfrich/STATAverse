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
    (result.entries?.length || 0) * 4
  );
}
export function retainResults(results, { entries = 200, cells = 500000 } = {}) {
  let total = results.reduce((n, result) => n + cost(result), 0);
  let start = 0;
  while (
    start < results.length - 1 &&
    (results.length - start > entries || total > cells)
  )
    total -= cost(results[start++]);
  return start ? results.slice(start) : results;
}
