// The Console's map: a do-file drawn as linked steps. Each step is a small
// form that writes one or a few Stata commands; a step that follows another
// runs after it, and two steps that follow the same one are branches. This
// file is the part with no page in it: the kinds of step, the commands each
// writes, and the do-file a whole map stands for.

const text = (value) => String(value ?? "").trim();
// A field's text is put in a command as typed, on one line.
const one = (value) => text(value).replace(/\s*[\r\n]+\s*/g, " ");

const GRAPHS = {
  "scatter with a fitted line": (y, x) =>
    `twoway (scatter ${y} ${x}) (lfit ${y} ${x})`,
  scatter: (y, x) => `scatter ${y} ${x}`,
  line: (y, x) => `line ${y} ${x}`,
  histogram: (y) => `histogram ${y}`,
  "density curve": (y) => `kdensity ${y}`,
};
const ONE_VARIABLE = new Set(["histogram", "density curve"]);

// What the extra field of a model step means for each command.
const EXTRA = {
  "ivregress 2sls": {
    label: "Endogenous regressor = its instruments",
    placeholder: "education = near_college",
  },
  "xtreg, fe": {
    label: "Panel and time variables",
    placeholder: "firm year",
  },
  "xtreg, re": {
    label: "Panel and time variables",
    placeholder: "firm year",
  },
  areg: { label: "Absorb the groups of", placeholder: "school" },
};

export const KINDS = {
  data: {
    title: "Load data",
    changes: true,
    fields: [{ id: "dataset", label: "Dataset", type: "dataset" }],
    lines: (f) =>
      text(f.dataset) ? [`sysuse ${text(f.dataset)}, clear`] : ["clear"],
  },
  keep: {
    title: "Keep some rows",
    changes: true,
    fields: [
      {
        id: "condition",
        label: "Keep the rows where",
        placeholder: "age >= 40",
        required: true,
      },
    ],
    lines: (f) => [`keep if ${one(f.condition)}`],
  },
  generate: {
    title: "New variable",
    changes: true,
    fields: [
      { id: "name", label: "Name", placeholder: "lwage", required: true },
      {
        id: "expression",
        label: "Equals",
        placeholder: "ln(wage)",
        required: true,
      },
    ],
    lines: (f) => [`generate ${one(f.name)} = ${one(f.expression)}`],
  },
  look: {
    title: "Look at the data",
    fields: [
      {
        id: "how",
        label: "With",
        options: [
          "summarize",
          "describe",
          "codebook",
          "list (first 10 rows)",
          "tabulate",
          "correlate",
        ],
      },
      {
        id: "variables",
        label: "Variables (blank for all)",
        placeholder: "wage education",
        names: true,
      },
    ],
    complete: (f) => f.how !== "tabulate" || !!text(f.variables),
    lines(f) {
      const variables = one(f.variables);
      if (f.how === "list (first 10 rows)")
        return [`list ${variables} in 1/10`.replace(/\s+/g, " ")];
      return [`${f.how} ${variables}`.trim()];
    },
  },
  graph: {
    title: "Graph",
    fields: [
      { id: "how", label: "Kind", options: Object.keys(GRAPHS) },
      {
        id: "y",
        label: "Variable",
        placeholder: "wage",
        required: true,
        names: true,
      },
      {
        id: "x",
        label: "Against",
        placeholder: "education",
        names: true,
        shown: (f) => !ONE_VARIABLE.has(f.how),
      },
    ],
    complete: (f) => ONE_VARIABLE.has(f.how) || !!text(f.x),
    lines: (f) => [GRAPHS[f.how](one(f.y), one(f.x))],
  },
  model: {
    title: "Model",
    model: true,
    fields: [
      {
        id: "command",
        label: "Estimator",
        options: [
          "regress",
          "logit",
          "probit",
          "poisson",
          "nbreg",
          "ologit",
          "ivregress 2sls",
          "xtreg, fe",
          "xtreg, re",
          "areg",
        ],
      },
      {
        id: "outcome",
        label: "Outcome",
        placeholder: "lwage",
        required: true,
        names: true,
      },
      {
        id: "predictors",
        label: "Explained by",
        placeholder: "education experience i.female",
        names: true,
      },
      {
        id: "extra",
        label: (f) => EXTRA[f.command]?.label ?? "",
        placeholder: (f) => EXTRA[f.command]?.placeholder ?? "",
        names: true,
        shown: (f) => !!EXTRA[f.command],
      },
      {
        id: "options",
        label: "Standard errors and options",
        placeholder: "vce(robust)",
      },
    ],
    complete: (f) =>
      (!EXTRA[f.command] || !!text(f.extra)) &&
      (f.command === "ivregress 2sls" || !!text(f.predictors)),
    lines(f) {
      const y = one(f.outcome),
        x = one(f.predictors),
        extra = one(f.extra),
        options = one(f.options).replace(/^,\s*/, ""),
        [command, builtin] = f.command.split(/,\s*/),
        tail = [builtin, options].filter(Boolean).join(" "),
        out = [];
      let body = `${y} ${x}`.trim();
      if (f.command === "ivregress 2sls") body = `${body} (${extra})`;
      if (command === "xtreg") out.push(`xtset ${extra}`);
      const absorb = command === "areg" ? `absorb(${extra})` : "",
        after = [absorb, tail].filter(Boolean).join(" ");
      out.push(`${command} ${body}${after ? `, ${after}` : ""}`);
      return out;
    },
  },
  after: {
    title: "After the model",
    needsModel: true,
    fields: [
      {
        id: "what",
        label: "Ask for",
        options: [
          "margins, dydx(*)",
          "margins",
          "marginsplot",
          "test",
          "lincom",
          "predict",
          "estat ic",
          "estat vif",
          "estat hettest",
          "estat firststage",
          "estat endogenous",
          "estimates store",
          "rvfplot",
        ],
      },
      {
        id: "detail",
        label: (f) => DETAIL[f.what]?.label ?? "",
        placeholder: (f) => DETAIL[f.what]?.placeholder ?? "",
        shown: (f) => !!DETAIL[f.what],
        names: true,
      },
    ],
    complete: (f) => !DETAIL[f.what]?.required || !!text(f.detail),
    lines(f) {
      const detail = DETAIL[f.what] ? one(f.detail) : "";
      // margins takes factor variables before the comma and options after.
      if (f.what === "margins" && detail && !detail.includes(","))
        return [
          /^(?:[a-z]+\(|atmeans\b|post\b)/i.test(detail)
            ? `margins, ${detail}`
            : `margins ${detail}`,
        ];
      return [`${f.what} ${detail}`.trim()];
    },
  },
  command: {
    title: "Any commands",
    changes: true,
    fields: [
      {
        id: "text",
        label: "Stata commands",
        placeholder: "tabulate region, summarize(wage)",
        type: "lines",
        required: true,
      },
    ],
    lines: (f) =>
      String(f.text ?? "")
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line.trim()),
  },
  note: {
    title: "Note",
    fields: [
      {
        id: "text",
        label: "A comment in the do-file",
        placeholder: "Why this step is here",
        required: true,
      },
    ],
    lines: (f) => [`* ${one(f.text)}`],
  },
};
const DETAIL = {
  margins: {
    label: "Factor variables or options",
    placeholder: "at(education=(10(2)18))",
  },
  "margins, dydx(*)": {
    label: "More options",
    placeholder: "at(female=(0 1))",
  },
  test: {
    label: "Hypothesis",
    placeholder: "education = experience",
    required: true,
  },
  lincom: {
    label: "Combination",
    placeholder: "education + experience",
    required: true,
  },
  predict: {
    label: "New variable and option",
    placeholder: "fitted, xb",
    required: true,
  },
  "estimates store": { label: "Name", placeholder: "base", required: true },
};

/** A new step of a kind, with each choice field on its first option. */
export function blank(kind) {
  const fields = {};
  for (const field of KINDS[kind].fields)
    fields[field.id] = field.options ? field.options[0] : "";
  return fields;
}
const value = (property, fields) =>
  typeof property === "function" ? property(fields) : (property ?? "");
/** The fields of a step that apply to what it currently says. */
export function fieldsOf(step) {
  return KINDS[step.kind].fields
    .filter((field) => !field.shown || field.shown(step.fields))
    .map((field) => ({
      ...field,
      label: value(field.label, step.fields),
      placeholder: value(field.placeholder, step.fields),
    }));
}
export function complete(step) {
  const kind = KINDS[step.kind];
  return (
    fieldsOf(step).every(
      (field) => !field.required || !!text(step.fields[field.id]),
    ) && (kind.complete ? kind.complete(step.fields) : true)
  );
}
/** The commands a step writes; none while it is not filled in. */
export function linesOf(step) {
  return complete(step) ? KINDS[step.kind].lines(step.fields) : [];
}

const childrenOf = (map, id) => map.steps.filter((step) => step.parent === id);
export const rootOf = (map) => map.steps.find((step) => step.parent === null);
export const stepOf = (map, id) => map.steps.find((step) => step.id === id);
/** Whether a step is, or follows, a model. */
export function followsModel(map, id) {
  for (let step = stepOf(map, id); step; step = stepOf(map, step.parent))
    if (KINDS[step.kind].model) return true;
  return false;
}
function changes(map, step) {
  return (
    KINDS[step.kind].changes ||
    childrenOf(map, step.id).some((child) => changes(map, child))
  );
}

/**
 * The steps of a map in the order they run, each with its commands. A branch
 * that changes the data, and is not the last one, is wrapped in preserve and
 * restore so that the branches after it start from the same data.
 */
export function sequence(map) {
  const out = [];
  const walk = (step) => {
    out.push({ id: step.id, lines: linesOf(step), skipped: !complete(step) });
    const children = childrenOf(map, step.id);
    children.forEach((child, k) => {
      const guard = k < children.length - 1 && changes(map, child);
      if (guard) out.push({ id: child.id, lines: ["preserve"], guard: true });
      walk(child);
      if (guard) out.push({ id: child.id, lines: ["restore"], guard: true });
    });
  };
  const root = rootOf(map);
  if (root) walk(root);
  return out;
}
/** The steps from the first one down to a step: what "run to here" runs. */
export function pathTo(map, id) {
  const path = [];
  for (let step = stepOf(map, id); step; step = stepOf(map, step.parent))
    path.unshift({
      id: step.id,
      lines: linesOf(step),
      skipped: !complete(step),
    });
  return path;
}
/** The do-file a map stands for, with each step's title as a comment. */
export function script(map) {
  const out = [];
  for (const entry of sequence(map)) {
    const step = stepOf(map, entry.id);
    if (entry.guard) out.push(...entry.lines);
    else if (entry.skipped)
      out.push(`* (the step "${KINDS[step.kind].title}" is not filled in)`);
    else if (step.kind === "note") out.push("", ...entry.lines);
    else out.push(...entry.lines);
  }
  return out.join("\n").replace(/^\n+/, "") + "\n";
}

export function addStep(map, parent, kind, fields = {}) {
  const step = {
    id: map.next++,
    kind,
    parent,
    fields: { ...blank(kind), ...fields },
  };
  map.steps.push(step);
  return step;
}
/** Removes a step and everything that follows it. The first step stays. */
export function removeStep(map, id) {
  if (stepOf(map, id)?.parent === null) return;
  const gone = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of map.steps)
      if (gone.has(step.parent) && !gone.has(step.id)) {
        gone.add(step.id);
        grew = true;
      }
  }
  map.steps = map.steps.filter((step) => !gone.has(step.id));
}

/** Builds a map from a nested description: [kind, fields, ...children]. */
export function build(tree) {
  const map = { steps: [], next: 1 };
  const place = ([kind, fields, ...children], parent) => {
    const step = addStep(map, parent, kind, fields);
    for (const child of children) place(child, step.id);
  };
  place(tree, null);
  return map;
}
/** Checks a map read from storage; null when it is not one. */
export function restore(saved) {
  if (!saved || !Array.isArray(saved.steps) || saved.steps.length > 200)
    return null;
  const ids = new Set(saved.steps.map((step) => step?.id));
  const sound = saved.steps.every(
    (step) =>
      step &&
      Number.isInteger(step.id) &&
      KINDS[step.kind] &&
      step.fields &&
      typeof step.fields === "object" &&
      (step.parent === null || (ids.has(step.parent) && step.parent < step.id)),
  );
  if (!sound || saved.steps.filter((s) => s.parent === null).length !== 1)
    return null;
  if (rootOf(saved).kind !== "data") return null;
  return {
    next: Math.max(...saved.steps.map((step) => step.id)) + 1,
    steps: saved.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      parent: step.parent,
      fields: Object.fromEntries(
        KINDS[step.kind].fields.map((field) => [
          field.id,
          field.options && !field.options.includes(step.fields[field.id])
            ? field.options[0]
            : String(step.fields[field.id] ?? "").slice(0, 4000),
        ]),
      ),
      ...(Number.isFinite(step.x) && Number.isFinite(step.y)
        ? { x: step.x, y: step.y }
        : {}),
    })),
  };
}

// Maps offered as starting points. Each is a whole small analysis.
export const STARTERS = [
  {
    id: "experiment",
    title: "An experiment assigned by school",
    tree: [
      "data",
      { dataset: "schools" },
      ["look", { how: "summarize", variables: "posttest pretest treated" }],
      [
        "graph",
        { how: "scatter with a fitted line", y: "posttest", x: "pretest" },
      ],
      [
        "model",
        {
          command: "regress",
          outcome: "posttest",
          predictors: "treated",
          options: "vce(cluster school)",
        },
        ["after", { what: "estimates store", detail: "simple" }],
      ],
      [
        "model",
        {
          command: "regress",
          outcome: "posttest",
          predictors: "treated pretest ses",
          options: "vce(cluster school)",
        },
        ["after", { what: "test", detail: "treated = 4" }],
      ],
    ],
  },
  {
    id: "returns",
    title: "The return to schooling, two ways",
    tree: [
      "data",
      { dataset: "labor" },
      [
        "generate",
        { name: "lwage", expression: "ln(wage)" },
        ["graph", { how: "histogram", y: "lwage" }],
        [
          "model",
          {
            command: "regress",
            outcome: "lwage",
            predictors: "education experience female",
            options: "vce(robust)",
          },
          [
            "after",
            { what: "margins", detail: "at(education=(10(2)18))" },
            ["after", { what: "marginsplot" }],
          ],
        ],
        [
          "model",
          {
            command: "ivregress 2sls",
            outcome: "lwage",
            predictors: "experience female",
            extra: "education = near_college",
            options: "vce(robust)",
          },
          ["after", { what: "estat firststage" }],
        ],
      ],
    ],
  },
  {
    id: "panel",
    title: "A policy in a panel of firms",
    tree: [
      "data",
      { dataset: "firms" },
      [
        "generate",
        { name: "lsales", expression: "ln(sales)" },
        ["look", { how: "tabulate", variables: "year policy" }],
        [
          "model",
          {
            command: "regress",
            outcome: "lsales",
            predictors: "policy",
            options: "vce(cluster firm)",
          },
        ],
        [
          "model",
          {
            command: "xtreg, fe",
            outcome: "lsales",
            predictors: "policy i.year",
            extra: "firm year",
            options: "vce(cluster firm)",
          },
          ["after", { what: "test", detail: "policy = 0.09" }],
        ],
      ],
    ],
  },
  {
    id: "trial",
    title: "A trial, with a subgroup on a branch",
    tree: [
      "data",
      { dataset: "health" },
      [
        "keep",
        { condition: "smoker == 1" },
        [
          "model",
          {
            command: "regress",
            outcome: "bp_after",
            predictors: "treated bp_before",
          },
        ],
      ],
      [
        "model",
        {
          command: "regress",
          outcome: "bp_after",
          predictors: "i.treated##i.smoker bp_before",
        },
        ["after", { what: "margins", detail: "treated, at(smoker=(0 1))" }],
      ],
      [
        "model",
        {
          command: "logit",
          outcome: "improved",
          predictors: "treated age smoker",
        },
        ["after", { what: "margins, dydx(*)" }],
      ],
    ],
  },
];
