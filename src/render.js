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
export function table(headers, rows, label = "") {
  return `<div class="result-table-wrap"${label ? ` tabindex="0" role="region" aria-label="${h(label)}"` : ""}><table class="result-table"><thead><tr>${headers.map((x) => `<th scope="col">${h(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((x) => `<td>${x}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
export function resultHTML(result, index, { complete = false } = {}) {
  if (result.suppressed || result.silent) return "";
  const r = result;
  let body = "";
  if (r.kind === "error")
    body = `<p class="result-error">${h(r.message)} <code>r(${r.code});</code></p><p class="result-text">${h(r.hint)}</p>`;
  else if (r.kind === "captured")
    body = `<p class="result-text">${h(r.message)} <code>r(${r.code});</code></p><p class="result-annotation">capture handled this error. Execution continued.${r.hint ? " " + h(r.hint) : ""}</p>`;
  else if (r.kind === "describe")
    body = `<div class="result-metrics"><div class="result-metric">Observations<strong>${r.n}</strong></div><div class="result-metric">Variables shown<strong>${r.columns.length}</strong></div></div>${table(
      ["Variable", "Type", "Label"],
      r.columns.map((c) => [h(c.name), h(c.type), h(c.label)]),
    )}`;
  else if (r.kind === "list")
    body =
      table(
        ["Obs.", ...r.names],
        (complete ? r.rows : r.rows.slice(0, 200)).map((row) => [
          row.position,
          ...row.values.map(value),
        ]),
      ) +
      (!complete && r.rows.length > 200
        ? `<p class="result-annotation">Showing the first 200 of ${r.rows.length} listed observations. Use an in range to inspect another section, or download Results and notes for the complete retained output.</p>`
        : "");
  else if (r.kind === "by") {
    const key = (k) => (k === "" ? '""' : value(k));
    body =
      r.inner === "count"
        ? table(
            [...r.by, "Observations"],
            r.groups.map((g) => [...g.keys.map(key), g.n]),
            "Counts by group",
          )
        : table(
            [...r.by, "Variable", "Obs.", "Mean", "Std. dev.", "Min", "Max"],
            r.groups.flatMap((g) =>
              g.stats.map((s) => [
                ...g.keys.map(key),
                h(s.name),
                s.n,
                fmt(s.mean),
                fmt(s.sd),
                fmt(s.min),
                fmt(s.max),
              ]),
            ),
            "Summary statistics by group",
          ) +
          `<p class="result-annotation">One row per group and variable. Obs. counts nonmissing values. Stata prints a separate table for each group; the numbers are the same.</p>`;
  } else if (r.kind === "tabstat") {
    const block = (label, values) =>
      r.statistics.map((statistic, s) => [
        ...(r.by ? [s === 0 ? label : ""] : []),
        h(statistic === "n" ? "N" : statistic),
        ...r.names.map((_name, v) => fmt(values[v][s])),
      ]);
    body =
      table(
        [...(r.by ? [r.by] : []), "Statistic", ...r.names],
        [
          ...r.groups.flatMap((g) =>
            block(g.key === "" ? '""' : value(g.key), g.values),
          ),
          ...block("Total", r.total),
        ],
        "Statistics table",
      ) +
      `<p class="result-annotation">Each statistic uses the nonmissing values of its own variable.${r.by ? " Observations with a missing group value are left out." : ""}</p>`;
  } else if (r.kind === "summarize")
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
  else if (["egen", "collapse"].includes(r.kind) && !r.rowwise) {
    const groups = complete ? r.summaryRows : r.summaryRows.slice(0, 200);
    body = `<div class="result-metrics"><div class="result-metric">Observations before<strong>${r.sourceRows}</strong></div><div class="result-metric">Selected<strong>${r.selectedRows}</strong></div><div class="result-metric">Groups<strong>${r.groupCount}</strong></div><div class="result-metric">Observations after<strong>${r.kind === "egen" ? r.sourceRows : r.groupCount}</strong></div></div>`;
    body += table(
      [
        ...(r.by.length ? r.by : ["Group"]),
        "Source rows",
        ...r.specs.map((s) => `${s.name}: ${s.statistic}(${s.source})`),
      ],
      groups.map((group, groupIndex) => [
        ...(r.by.length
          ? group.keys.map(
              (key, keyIndex) =>
                (key === ""
                  ? '<span aria-label="Empty string">""</span>'
                  : value(key)) +
                (keyIndex === 0 && !complete
                  ? groupButton(index, groupIndex, group.keys)
                  : ""),
            )
          : [
              "All selected" +
                (!complete ? groupButton(index, groupIndex, []) : ""),
            ]),
        group.rows,
        ...group.statistics.map(
          (s) =>
            `<strong>${fmt(s.value)}</strong><span class="group-stat-count">${s.n} nonmissing</span>`,
        ),
      ]),
    );
    body += `<p class="result-annotation">${r.kind === "egen" ? "Each displayed value is attached to every selected observation in that group; it is not a new independent observation." : "Each displayed row is now one observation in memory. Other source variables are no longer in the working dataset."} Nonmissing counts show the sample used by each statistic.${r.specs.some((s) => ["sum", "total"].includes(s.statistic)) ? " A sum of zero with zero nonmissing values does not establish an observed total of zero." : ""}</p>`;
    if (!complete && r.summaryRows.length > 200)
      body += `<p class="result-annotation">Showing the first 200 of ${r.groupCount} groups. All groups enter the working data. Download Results and notes for the complete retained table.</p>`;
  } else if (r.kind === "count")
    body = `<p class="number-result">${r.n}</p><p class="result-text">${r.n} of ${r.total} observations satisfy this command. The dataset is unchanged. Matching rows are highlighted in the data browser.</p>`;
  else if (r.kind === "display")
    body = `<p class="number-result">${value(r.value)}</p>`;
  else if (r.kind === "tabulate")
    body =
      table(
        [r.name, "Frequency", "Percent", "Cumulative"],
        (complete ? r.entries : r.entries.slice(0, 200)).map((e) => [
          value(e.value),
          e.count,
          fmt(e.percent, 2),
          fmt(e.cumulative, 2),
        ]),
      ) +
      `<p class="result-text">Total observations included: ${r.n}.</p>` +
      (!complete && r.entries.length > 200
        ? `<p class="result-annotation">Showing the first 200 of ${r.entries.length} categories. Percentages use all included observations. Download Results and notes for the complete retained table.</p>`
        : "");
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
    if (r.message) body += `<p class="result-text">${h(r.message)}</p>`;
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
    if (m.omittedTerms?.length)
      body += `<details class="result-annotation"><summary>${m.omittedTerms.length} reference, empty or redundant term(s)</summary><p>These terms have coefficient zero. Reference terms set the comparison category; empty terms have no observations in this sample; redundant terms are already represented by the other columns.</p>${table(
        ["Term", "Reason"],
        m.omittedTerms.map((t) => [h(t.name), h(t.omitted)]),
      )}</details>`;
    body += `<div class="result-annotation" data-annotation="${index}">Select a variable name for an interpretation. ${r.omitted} selected row(s) were excluded for missing model variables. R-squared describes in-sample fit, not causal validity.</div>`;
  }
  if (r.message && !["error", "regress", "captured"].includes(r.kind))
    body += `<p class="result-text">${h(r.message)}</p>`;
  const original = r.originalCommand
    ? `<details class="result-substitution"><summary>Original do-file line</summary><pre class="result-command">${h(r.originalCommand)}</pre><p class="helper">The command below shows the text after local substitution for this execution.</p></details>`
    : "";
  return `<article class="result-card">${r.source ? `<span class="result-source">Line ${r.source.line}${r.source.endLine > r.source.line ? `–${r.source.endLine}` : ""}</span>` : ""}${original}<pre class="result-command ${r.kind === "error" ? "error" : ""}">. ${h(r.command)}</pre>${body}</article>`;
}
function groupButton(result, index, keys) {
  return `<button type="button" class="text-button group-inspect-button" data-group-result="${result}" data-group-index="${index}" aria-label="Inspect source rows for group ${h(keys.length ? keys.map((key) => (key === "" ? "empty string" : key === null ? "." : key)).join(" / ") : "all selected")}">Inspect rows</button>`;
}
export function groupInspectionHTML(result, index) {
  const group = result.summaryRows[index];
  if (!group) return "";
  const groupLabel = result.by.length
    ? result.by
        .map(
          (name, i) =>
            `${name} = ${group.keys[i] === null ? "." : group.keys[i] === "" ? '""' : group.keys[i]}`,
        )
        .join(" · ")
    : "All selected observations";
  return `<p class="output-label">${h(groupLabel)}</p><p>${group.rows} selected source observations. These values were recorded when the command ran; later changes to your working data do not alter this view.</p>${table(
    ["Output", "Statistic", "Nonmissing", "Result"],
    result.specs.map((s, i) => [
      h(s.name),
      h(`${s.statistic}(${s.source})`),
      group.statistics[i].n,
      fmt(group.statistics[i].value),
    ]),
    "Statistics for the selected group",
  )}<p>Source positions refer to the ordering at that time. A dot is numeric missing; an empty string is shown as "". Missing values do not enter the counts or means.</p>${table(
    ["Source position", ...result.sourceNames],
    group.preview.map((row) => [
      row.position,
      ...row.values.map((v) =>
        v === ""
          ? '""'
          : typeof v === "string" && v.length > 160
            ? h(v.slice(0, 160)) + "…"
            : value(v),
      ),
    ]),
    "Source observations for the selected group",
  )}${group.rows > group.preview.length ? `<p class="result-annotation">Showing the first ${group.preview.length} of ${group.rows} source rows in this group. All ${group.rows} rows were considered in the statistics above.</p>` : ""}${group.preview.some((row) => row.values.some((v) => typeof v === "string" && v.length > 160)) ? '<p class="result-annotation">Long text is shortened after 160 characters in this inspection view. The source data are unchanged.</p>' : ""}`;
}
export function explainCoefficient(model, name) {
  const c = model.coefficients.find((c) => c.name === name);
  if (!c) return "";
  if (model.factorTerms) {
    const uncertainty =
      c.se === null
        ? "This model has no residual degrees of freedom, so it cannot estimate uncertainty."
        : `Its 95% confidence interval is [${fmt(c.lo)}, ${fmt(c.hi)}].`;
    if (name === "_cons")
      return `The intercept (${fmt(c.b)}) is fitted ${model.dependent} when all displayed model columns are zero. For categories, that usually means the reference combination; continuous predictors are set to zero. Check whether that combination occurs in the data. ${uncertainty}`;
    const term = model.factorTerms.find((t) => t.name === name);
    const definition = term.components
      .map((a) =>
        a.type === "continuous"
          ? a.variable
          : `an indicator equal to 1 when ${a.variable} = ${a.level}, and 0 otherwise`,
      )
      .join(" multiplied by ");
    return `${name} is ${definition}. Its coefficient is ${fmt(c.b)}. When a variable also appears in another term, changing it changes each of those terms; combine their contributions to find the change in fitted ${model.dependent}. ${uncertainty} This fitted association is not by itself a causal effect.`;
  }
  if (name === "_cons")
    return `The intercept (${fmt(c.b)}) is the fitted ${model.dependent} when every included predictor is zero. That combination may lie outside the observed data and may not be substantively meaningful.`;
  const others = model.predictors.filter((x) => x !== name);
  const constructed = model.predictors.filter(
    (x) => model.columnOrigins?.[x]?.command,
  );
  if (constructed.length) {
    const origins = constructed
      .map(
        (x) =>
          `${x}: ${model.columnOrigins[x].command}${model.columnOrigins[x].edited ? " (subsequently edited)" : ""}`,
      )
      .join("; ");
    return `The fitted equation includes ${fmt(c.b)} × ${name}. Its 95% confidence interval is [${fmt(c.lo)}, ${fmt(c.hi)}]. This coefficient multiplies a model column. With squared terms or interactions, changing an underlying variable changes more than one column; combine all affected terms to obtain its fitted change. Constructed predictors: ${origins}. These commands record how the columns were created; later edits to their inputs do not automatically recalculate them. ${model.columnOrigins?.[model.dependent]?.command ? `The outcome was created with ${model.columnOrigins[model.dependent].command}; interpret the fitted equation on that transformed scale. ` : ""}The coefficient is not by itself a causal effect.`;
  }
  if (model.columnOrigins?.[model.dependent]?.command)
    return `A one-unit increase in ${name} changes fitted ${model.dependent} by ${fmt(c.b)} units${others.length ? `, holding ${others.join(" and ")} fixed` : ""}. The outcome was created with ${model.columnOrigins[model.dependent].command}${model.columnOrigins[model.dependent].edited ? " and subsequently edited" : ""}. Read the coefficient on that outcome scale; a log outcome is not measured in the original outcome’s units. Its 95% confidence interval is [${fmt(c.lo)}, ${fmt(c.hi)}]. This fitted association does not identify a causal effect.`;
  return `A one-unit increase in ${name} is associated with ${fmt(Math.abs(c.b))} ${c.b >= 0 ? "more" : "fewer"} units of fitted ${model.dependent}${others.length ? `, holding ${others.join(" and ")} fixed` : ""}. The 95% confidence interval is [${fmt(c.lo)}, ${fmt(c.hi)}]. The standard error measures estimated sampling uncertainty under this covariance specification; it is not the spread of the raw observations. A small p-value tests a zero coefficient under the model assumptions and does not establish a causal effect.`;
}
