export const BUILDER_KEY = "stataverse:do-builder:v1";
export const METHODS = [
  {
    id: "describe",
    title: "Summary statistics",
    level: "beginner",
    note: "Describe the variables and summarize their distributions.",
  },
  {
    id: "scatter",
    title: "Scatterplot and fitted line",
    level: "beginner",
    note: "Plot two numeric variables. The fitted line describes their association.",
  },
  {
    id: "ols",
    title: "Linear regression",
    level: "beginner",
    note: "Regress a numeric outcome on the selected predictors. A coefficient is conditional on the other included predictors; causal interpretation requires a research design.",
  },
  {
    id: "ttest",
    title: "Two-group mean comparison",
    level: "intermediate",
    note: "Welch's t test compares independent groups without assuming equal variances. The group variable must have exactly two nonmissing values.",
  },
  {
    id: "logit",
    title: "Binary outcome · logit",
    level: "intermediate",
    note: "The outcome must be coded 0 or 1. Report average marginal effects separately from log-odds coefficients.",
  },
  {
    id: "poisson",
    title: "Count outcome · Poisson",
    level: "intermediate",
    note: "Use nonnegative integer outcomes. Robust standard errors relax the Poisson variance assumption; the conditional mean still needs appropriate specification.",
  },
  {
    id: "iv",
    title: "Instrumental variables · 2SLS",
    level: "advanced",
    note: "Excluded instruments must be relevant and satisfy exclusion and exogeneity assumptions. A first-stage statistic does not establish instrument validity.",
  },
  {
    id: "fe",
    title: "Panel fixed effects",
    level: "advanced",
    note: "The coefficient uses within-unit variation. Unit fixed effects do not remove time-varying confounding; inference must reflect the sampling design.",
  },
];
export const PREPARATIONS = [
  { id: "rename", title: "Rename a variable", target: true },
  { id: "log", title: "Natural logarithm", target: true },
  { id: "square", title: "Squared variable", target: true },
  { id: "center", title: "Mean-centered variable", target: true },
  { id: "encode", title: "Encode text categories", target: true },
  { id: "destring", title: "Convert numeric text", target: true },
  { id: "missing", title: "Replace a numeric missing-value code", value: true },
  { id: "filter", title: "Keep observations meeting a condition", value: true },
  { id: "dropmissing", title: "Exclude missing values" },
];
export function emptyBuilder() {
  return {
    version: 1,
    level: "beginner",
    os: "mac",
    project: "",
    file: "",
    format: "csv",
    sheet: "",
    header: true,
    stringcols: "",
    output: ".",
    stem: "analysis",
    method: "describe",
    outcome: "",
    predictors: "",
    group: "",
    endogenous: "",
    instruments: "",
    panel: "",
    time: "",
    vce: "robust",
    cluster: "",
    log: true,
    saveData: false,
    replace: false,
    steps: [],
    edited: null,
    stage: 0,
  };
}
export function validateBuilder(value) {
  if (!value || typeof value !== "object" || value.version !== 1)
    throw new Error("Unsupported do-file plan.");
  const result = emptyBuilder();
  for (const key of Object.keys(result)) {
    if (typeof result[key] === "string") {
      if (typeof value[key] !== "string" || value[key].length > 2000)
        throw new Error("Invalid do-file plan field: " + key);
      result[key] = value[key];
    } else if (typeof result[key] === "boolean") {
      if (typeof value[key] !== "boolean")
        throw new Error("Invalid do-file plan option: " + key);
      result[key] = value[key];
    }
  }
  const enums = {
    level: ["beginner", "intermediate", "advanced"],
    os: ["mac", "windows"],
    format: ["csv", "excel", "dta"],
    method: METHODS.map((m) => m.id),
    vce: ["conventional", "robust", "cluster"],
  };
  for (const [key, values] of Object.entries(enums))
    if (!values.includes(result[key]))
      throw new Error("Unknown do-file plan option: " + key);
  if (!Array.isArray(value.steps) || value.steps.length > 30)
    throw new Error("A plan can contain at most 30 preparation steps.");
  result.steps = value.steps.map((step) => {
    if (!step || !PREPARATIONS.some((p) => p.id === step.type))
      throw new Error("Unknown preparation step.");
    const s = { type: step.type };
    for (const key of ["variable", "target", "value", "operator"]) {
      s[key] = step[key] ?? "";
      if (typeof s[key] !== "string" || s[key].length > 500)
        throw new Error("Invalid preparation step.");
    }
    return s;
  });
  if (
    value.edited !== null &&
    (typeof value.edited !== "string" || value.edited.length > 50000)
  )
    throw new Error("Edited code exceeds 50,000 characters.");
  result.edited = value.edited;
  if (!Number.isInteger(value.stage) || value.stage < 0 || value.stage > 4)
    throw new Error("Invalid builder stage.");
  result.stage = value.stage;
  return result;
}
export function normalizePath(text) {
  let value = text.trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  return value.replaceAll("\\", "/");
}
const absolute = (path) => /^(?:\/|[A-Za-z]:\/)/.test(path);
// Quoted literals accept spaces, Unicode and ordinary apostrophes. Macro and
// quote delimiters require separate handling; never silently interpolate them.
const safeLiteral = (text) => !/["`$\u0000-\u001f\u007f]/.test(text);
const name = (text) =>
  /^[A-Za-z_][A-Za-z_0-9]{0,31}$/.test(text) &&
  !["_all", "_n", "_N", "_b", "_se", "_cons"].includes(text);
const names = (text) => text.trim().split(/\s+/).filter(Boolean);
const numeric = (text) =>
  /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text) &&
  Number.isFinite(Number(text));
const q = (text) => '"' + text + '"';
function resolvedPath(root, path) {
  const raw = absolute(path) ? path : root.replace(/\/$/, "") + "/" + path;
  const parts = [];
  for (const p of raw.split("/")) {
    if (p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return parts.join("/").toLowerCase();
}
export function buildDoFile(input) {
  const p = validateBuilder(input),
    errors = [],
    notes = [];
  const sections = Array.from({ length: 5 }, (_, i) => ({
    title: ["Project", "Data", "Preparation", "Analysis", "Output"][i],
    lines: [],
  }));
  const add = (stage, ...lines) => sections[stage].lines.push(...lines);
  const error = (stage, field, message) =>
    errors.push({ stage, field, message });
  const path = (field, stage, required = true) => {
    const value = normalizePath(p[field]);
    if (!value && required)
      error(
        stage,
        field,
        `${field === "file" ? "Data file" : field === "project" ? "Project folder" : "Output folder"} is required.`,
      );
    else if (!safeLiteral(value))
      error(
        stage,
        field,
        "This path contains a quote, macro delimiter or control character. Choose a path without double quotes, backticks, dollar signs or line breaks.",
      );
    else if (
      /^[A-Za-z]+:\/\//.test(value) ||
      /^(?:file:|~|[A-Za-z]:(?!\/))/.test(value)
    )
      error(
        stage,
        field,
        "Use a filesystem path, not a web address, file URL, home shortcut or drive-relative path.",
      );
    return value;
  };
  const project = path("project", 0),
    file = path("file", 1),
    output = path("output", 4);
  if (project && !absolute(project))
    error(
      0,
      "project",
      "Paste the full project folder path, beginning with / on Mac or a drive letter or network share on Windows.",
    );
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/.test(p.stem))
    error(
      4,
      "stem",
      "Use a file prefix of 1–60 letters, numbers, hyphens or underscores.",
    );
  if (
    p.os === "windows" &&
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(p.stem)
  )
    error(
      4,
      "stem",
      "Choose a filename other than a Windows reserved device name.",
    );
  if (
    p.saveData &&
    resolvedPath(project, file) ===
      resolvedPath(project, output + "/" + p.stem + "_data.dta")
  )
    error(
      4,
      "stem",
      "The output dataset would overwrite the input file. Choose a different prefix or output folder.",
    );
  add(
    0,
    "version 16.0",
    "set more off",
    "* Run the complete do-file; the local paths belong to this run.",
  );
  if (project && safeLiteral(project)) add(0, `cd ${q(project)}`);
  if (output && safeLiteral(output))
    add(0, `local output ${q(output.replace(/\/$/, ""))}`);
  if (p.log && /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/.test(p.stem))
    add(
      0,
      "capture log close sv_analysis",
      `log using "\`output'/${p.stem}.log", text name(sv_analysis)${p.replace ? " replace" : ""}`,
    );
  if (file && safeLiteral(file)) {
    add(
      1,
      "* Loading this file replaces the dataset currently in memory.",
      `confirm file ${q(file)}`,
    );
    if (p.format === "dta") add(1, `use ${q(file)}, clear`);
    if (p.format === "csv") {
      if (p.stringcols && !/^\d+(?:\s+\d+)*$/.test(p.stringcols.trim()))
        error(
          1,
          "stringcols",
          "Enter positive column numbers separated by spaces, such as 1 3.",
        );
      else if (
        p.stringcols &&
        names(p.stringcols).some((n) => Number(n) < 1 || Number(n) > 32767)
      )
        error(
          1,
          "stringcols",
          "String column numbers must be between 1 and 32767.",
        );
      add(
        1,
        `import delimited using ${q(file)}, clear varnames(${p.header ? "1" : "nonames"}) case(preserve)${p.stringcols && /^\d+(?:\s+\d+)*$/.test(p.stringcols.trim()) ? ` stringcols(${p.stringcols.trim()})` : ""}`,
      );
    }
    if (p.format === "excel") {
      if (!safeLiteral(p.sheet))
        error(
          1,
          "sheet",
          "The sheet name contains a quote, macro delimiter or control character.",
        );
      add(
        1,
        `import excel using ${q(file)}, clear${p.header ? " firstrow" : ""}${p.sheet && safeLiteral(p.sheet) ? ` sheet(${q(p.sheet)})` : ""}`,
      );
    }
    add(1, "describe", "count");
  }
  const newNames = new Set();
  for (const [i, step] of p.steps.entries()) {
    const spec = PREPARATIONS.find((s) => s.id === step.type),
      { variable: v, target: t, value } = step;
    const field = `step-${i}`,
      fail = (message) => error(2, field, `Step ${i + 1}: ${message}`);
    if (!name(v)) {
      fail("enter one valid variable name.");
      continue;
    }
    if (spec.target && (!name(t) || t === v || newNames.has(t))) {
      fail(
        "enter a distinct, valid new variable name that no earlier step creates.",
      );
      continue;
    }
    if (spec.target) newNames.add(t);
    add(2, `* ${i + 1}. ${spec.title}`, `confirm variable ${v}`);
    if (spec.target) add(2, `confirm new variable ${t}`);
    if (step.type === "rename") add(2, `rename ${v} ${t}`);
    if (step.type === "log")
      add(
        2,
        `confirm numeric variable ${v}`,
        `assert ${v} > 0 if !missing(${v})`,
        `generate double ${t} = ln(${v})`,
      );
    if (step.type === "square")
      add(2, `confirm numeric variable ${v}`, `generate double ${t} = ${v}^2`);
    if (step.type === "center")
      add(
        2,
        `confirm numeric variable ${v}`,
        `quietly summarize ${v}`,
        `assert r(N) > 0`,
        `generate double ${t} = ${v} - r(mean)`,
      );
    if (step.type === "encode")
      add(2, `confirm string variable ${v}`, `encode ${v}, generate(${t})`);
    if (step.type === "destring")
      add(
        2,
        `confirm string variable ${v}`,
        `destring ${v}, generate(${t})`,
        `confirm numeric variable ${t}`,
        "* Conversion stops if nonnumeric text is present; values are not forced to missing.",
      );
    if (step.type === "dropmissing")
      add(2, `count if missing(${v})`, `drop if missing(${v})`);
    if (step.type === "missing") {
      if (!numeric(value))
        fail(
          "enter the numeric code that represents missing data, such as -99.",
        );
      else
        add(
          2,
          `confirm numeric variable ${v}`,
          `replace ${v} = . if ${v} == ${value}`,
        );
    }
    if (step.type === "filter") {
      if (!["==", "!=", ">", ">=", "<", "<="].includes(step.operator))
        fail("choose a comparison operator.");
      else if (!numeric(value))
        fail(
          "enter a numeric comparison value. Encode text categories first if needed.",
        );
      else
        add(
          2,
          `confirm numeric variable ${v}`,
          `keep if !missing(${v}) & ${v} ${step.operator} ${value}`,
          "count",
        );
    }
  }
  const y = p.outcome.trim(),
    x = names(p.predictors).join(" "),
    group = p.group.trim(),
    panel = p.panel.trim(),
    time = p.time.trim(),
    endogenous = p.endogenous.trim(),
    instruments = names(p.instruments).join(" "),
    cluster = p.cluster.trim();
  const requiredName = (value, field, label) => {
    if (!name(value))
      error(3, field, `Enter one valid ${label} variable name.`);
  };
  const requiredList = (value, field, label, factors = false) => {
    if (
      !value ||
      !names(value).every((v) =>
        factors
          ? v
              .split(/#{1,2}/)
              .every(
                (t) =>
                  /^(?:[ic]\.)?[A-Za-z_][A-Za-z_0-9]{0,31}$/.test(t) &&
                  name(t.replace(/^[ic]\./, "")),
              )
          : name(v),
      )
    )
      error(
        3,
        field,
        `Enter ${label} as space-separated variable names${factors ? "; i. and c. prefixes and # or ## interactions are allowed" : ""}.`,
      );
  };
  if (p.method === "describe") {
    if (x) requiredList(x, "predictors", "variables");
    add(3, `summarize${x ? " " + x : ""}, detail`);
  } else {
    requiredName(y, "outcome", "outcome");
    if (["scatter"].includes(p.method))
      requiredName(x, "predictors", "horizontal-axis");
    else if (p.method !== "ttest") {
      if (p.method !== "iv" || x)
        requiredList(x, "predictors", "predictors", true);
      if (
        names(x).some((t) =>
          t.split(/#{1,2}/).some((v) => v.replace(/^[ic]\./, "") === y),
        )
      )
        error(
          3,
          "predictors",
          "The outcome cannot also appear as a predictor.",
        );
    }
    if (p.method === "ttest") requiredName(group, "group", "group");
    if (p.method === "iv") {
      requiredName(endogenous, "endogenous", "endogenous predictor");
      requiredList(instruments, "instruments", "excluded instruments");
      const controls = names(x).flatMap((v) =>
        v.split(/#{1,2}/).map((s) => s.replace(/^[ic]\./, "")),
      );
      if (
        [y, ...controls].includes(endogenous) ||
        names(instruments).some((v) => [y, endogenous, ...controls].includes(v))
      )
        error(
          3,
          "instruments",
          "Keep the outcome, endogenous predictor, included controls and excluded instruments in distinct roles.",
        );
    }
    if (p.method === "fe") {
      requiredName(panel, "panel", "panel identifier");
      requiredName(time, "time", "time");
      if (panel === time && panel)
        error(3, "time", "Panel and time variables must differ.");
    }
    const model = ["ols", "logit", "poisson", "iv", "fe"].includes(p.method);
    if (model && p.vce === "cluster")
      requiredName(cluster, "cluster", "cluster");
    const vce =
      p.vce === "conventional"
        ? ""
        : p.vce === "cluster"
          ? `vce(cluster ${cluster})`
          : "vce(robust)";
    if (!errors.some((e) => e.stage === 3)) {
      add(3, `confirm numeric variable ${y}`);
      if (p.method === "scatter")
        add(
          3,
          `confirm numeric variable ${x}`,
          `twoway (scatter ${y} ${x}) (lfit ${y} ${x})`,
          `graph export "\`output'/${p.stem}_scatter.png"${p.replace ? ", replace" : ""}`,
        );
      if (p.method === "ttest") add(3, `ttest ${y}, by(${group}) unequal`);
      if (p.method === "logit")
        add(3, `assert inlist(${y},0,1) if !missing(${y})`);
      if (p.method === "poisson")
        add(3, `assert ${y} >= 0 & ${y} == floor(${y}) if !missing(${y})`);
      if (p.method === "fe")
        add(3, `isid ${panel} ${time}`, `xtset ${panel} ${time}`);
      if (model) {
        const cmd = {
          ols: `regress ${y} ${x}`,
          logit: `logit ${y} ${x}`,
          poisson: `poisson ${y} ${x}`,
          iv: `ivregress 2sls ${y}${x ? " " + x : ""} (${endogenous} = ${instruments})`,
          fe: `xtreg ${y} ${x}, fe`,
        }[p.method];
        add(
          3,
          cmd + (vce ? (p.method === "fe" ? " " : ", ") + vce : ""),
          "count if e(sample)",
        );
        if (p.method === "iv") add(3, "estat firststage");
        if (p.method === "logit") add(3, "margins, dydx(*)");
        add(
          4,
          `estimates save "\`output'/${p.stem}_model.ster"${p.replace ? ", replace" : ""}`,
        );
      }
    }
  }
  if (p.saveData)
    add(
      4,
      `save "\`output'/${p.stem}_data.dta"${p.replace ? ", replace" : ""}`,
    );
  if (p.log) add(4, "log close sv_analysis");
  notes.push(METHODS.find((m) => m.id === p.method).note);
  if (p.method === "fe" && p.vce === "robust")
    notes.push(
      "For xtreg, fe, vce(robust) clusters standard errors by panel identifier.",
    );
  if (
    p.vce === "cluster" &&
    ["ols", "logit", "poisson", "iv", "fe"].includes(p.method)
  )
    notes.push(
      "Cluster inference requires enough independent clusters. Choose the level from the design, not from the smallest p-value.",
    );
  if (p.format !== "dta")
    notes.push(
      "After import, check describe: Stata may modify invalid column headings. Use the resulting variable names in the plan.",
    );
  notes.push(
    p.replace
      ? "Existing output files with these names will be replaced."
      : "Existing output files are preserved. Change the prefix or allow replacement before rerunning with the same filenames.",
  );
  const code =
    [
      "* STATAverse do-file",
      "* Review the paths and variable names before running.",
      ...sections.flatMap((s) => ["", "* " + s.title, ...s.lines]),
    ].join("\n") + "\n";
  return { code, errors, notes, sections };
}
