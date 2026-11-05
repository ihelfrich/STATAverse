export const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const fmt = (value, digits = 3) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "."
    : Number.isInteger(value)
      ? String(value)
      : Math.abs(value) >= 1e7 || Math.abs(value) < 0.0001
        ? value.toExponential(3)
        : value.toFixed(digits);
const h = escapeHTML;
const value = (v) => (typeof v === "number" ? fmt(v) : v === null ? "." : h(v));
export function table(headers, rows) {
  return `<div class="result-table-wrap"><table class="result-table"><thead><tr>${headers.map((x) => `<th scope="col">${h(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((x) => `<td>${x}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
export function resultHTML(result, index) {
  const r = result;
  let body = "";
  if (r.kind === "error")
    body = `<p class="result-error">${h(r.message)} <code>r(${r.code});</code></p><p class="result-text">${h(r.hint)}</p>`;
  else if (r.kind === "describe")
    body = `<div class="result-metrics"><div class="result-metric">Observations<strong>${r.n}</strong></div><div class="result-metric">Variables shown<strong>${r.columns.length}</strong></div></div>${table(
      ["Variable", "Type", "Label"],
      r.columns.map((c) => [h(c.name), h(c.type), h(c.label)]),
    )}`;
  else if (r.kind === "list")
    body = table(
      ["Obs.", ...r.names],
      r.rows.map((row) => [row.position, ...row.values.map(value)]),
    );
  else if (r.kind === "summarize")
    body =
      table(
        ["Variable", "Obs.", "Mean", "Std. dev.", "Min", "Max"],
        r.stats.map((s) => [
          h(s.name),
          s.n,
          fmt(s.mean),
          fmt(s.sd),
          fmt(s.min),
          fmt(s.max),
        ]),
      ) +
      `<p class="result-annotation">Obs. counts nonmissing values <em>separately for each variable</em>. Std. dev. describes the spread of the observations; it is not the standard error of the mean.</p>`;
  else if (r.kind === "count")
    body = `<p class="number-result">${r.n}</p><p class="result-text">${r.n} of ${r.total} observations satisfy this command. The dataset is unchanged. Matching rows are highlighted in the data browser.</p>`;
  else if (r.kind === "display")
    body = `<p class="number-result">${value(r.value)}</p>`;
  else if (r.kind === "tabulate")
    body =
      table(
        [r.name, "Frequency", "Percent", "Cumulative"],
        r.entries.map((e) => [
          value(e.value),
          e.count,
          fmt(e.percent, 2),
          fmt(e.cumulative, 2),
        ]),
      ) + `<p class="result-text">Total observations included: ${r.n}.</p>`;
  else if (r.kind === "codebook")
    body = r.variables
      .map(
        (v) =>
          `<p class="output-label">${h(v.name)} · ${h(v.type)}</p><p class="result-text">${h(v.label)}<br>${v.unique} distinct nonmissing values · ${v.missing} missing<br>Example values: ${v.examples.map(value).join(", ")}</p>`,
      )
      .join("");
  else if (r.kind === "duplicates")
    body =
      table(
        ["Copies", "Observations", "Surplus"],
        r.entries.map((e) => [e.copies, e.observations, e.surplus]),
      ) +
      `<p class="result-annotation">Copies is the number of times each ${h(r.names.join(" + "))} combination appears. Surplus counts observations beyond the first in each group. Review their meaning before removing any.</p>`;
  else if (r.kind === "correlate")
    body =
      `<p class="result-text">${r.n} complete observations across all listed variables.</p>` +
      table(
        ["", ...r.names],
        r.values.map((row, i) => [h(r.names[i]), ...row.map((v) => fmt(v))]),
      ) +
      `<p class="result-annotation">Correlation summarizes linear association. Its value alone does not establish causation.</p>`;
  else if (r.kind === "regress") {
    const m = r.model;
    body = `<p class="output-label">Outcome: ${h(m.dependent)} · ${m.robust ? "HC1 robust" : "Conventional OLS"} standard errors</p><div class="result-metrics"><div class="result-metric">Observations<strong>${m.n}</strong></div><div class="result-metric">R-squared<strong>${fmt(m.r2)}</strong></div><div class="result-metric">Root MSE<strong>${fmt(m.rmse)}</strong></div><div class="result-metric">Residual df<strong>${m.df}</strong></div></div>`;
    body += table(
      [
        "Variable",
        "Coefficient",
        "Std. err.",
        "t",
        "P>|t|",
        "95% lower",
        "95% upper",
      ],
      m.coefficients.map((c) => [
        `<button type="button" class="coef-select" data-result="${index}" data-coefficient="${h(c.name)}">${h(c.name)}</button>`,
        fmt(c.b),
        fmt(c.se),
        fmt(c.t),
        c.p === null ? "." : c.p < 0.001 ? "&lt;0.001" : fmt(c.p),
        fmt(c.lo),
        fmt(c.hi),
      ]),
    );
    body += `<div class="result-annotation" data-annotation="${index}">Select a variable name for an interpretation. ${r.omitted} selected row(s) were excluded for missing model variables. R-squared describes in-sample fit, not causal validity.</div>`;
  }
  if (r.message) body += `<p class="result-text">${h(r.message)}</p>`;
  return `<article class="result-card">${r.source ? `<span class="result-source">Line ${r.source.line}${r.source.endLine > r.source.line ? `–${r.source.endLine}` : ""}</span>` : ""}<pre class="result-command ${r.kind === "error" ? "error" : ""}">. ${h(r.command)}</pre>${body}</article>`;
}
export function explainCoefficient(model, name) {
  const c = model.coefficients.find((c) => c.name === name);
  if (!c) return "";
  if (name === "_cons")
    return `The intercept (${fmt(c.b)}) is the fitted ${model.dependent} when every included predictor is zero. That combination may lie outside the observed data and may not be substantively meaningful.`;
  const others = model.predictors.filter((x) => x !== name);
  return `A one-unit increase in ${name} is associated with ${fmt(Math.abs(c.b))} ${c.b >= 0 ? "more" : "fewer"} units of fitted ${model.dependent}${others.length ? `, holding ${others.join(" and ")} fixed` : ""}. The 95% confidence interval is [${fmt(c.lo)}, ${fmt(c.hi)}]. The standard error measures estimated sampling uncertainty under this covariance specification; it is not the spread of the raw observations. A small p-value tests a zero coefficient under the model assumptions and does not establish a causal effect.`;
}
