import { compareKeys } from "../grouped-data.js";
import { dataResourceError } from "../resource-limits.js";
import { toCSV } from "../datasets.js";
import { nativeImportCommand } from "../import-library.js";

const absent = (value) => value === null || value === "";
const validName = (name) =>
  typeof name === "string" &&
  /^[A-Za-z_]\w{0,31}$/.test(name) &&
  ![
    "__proto__",
    "prototype",
    "constructor",
    "_n",
    "_N",
    "_all",
    "_cons",
  ].includes(name);
const keyFor = (row, names) => JSON.stringify(names.map((name) => row[name]));
const emptyValue = (column) => (column.type === "string" ? "" : null);
const clone = (value) => structuredClone(value);
function outputSize(rows, columns) {
  if (rows > 10000 || columns > 100 || rows * columns > 200000)
    throw new DataOperationError(
      "The result would exceed 10,000 rows, 100 variables or 200,000 cells. Select a smaller source or fewer column families.",
      901,
    );
}
export class DataOperationError extends Error {
  constructor(message, code = 198, details = {}) {
    super(message);
    this.name = "DataOperationError";
    this.code = code;
    this.details = details;
  }
}
function validate(data) {
  if (
    !data ||
    !Array.isArray(data.columns) ||
    !Array.isArray(data.rows) ||
    !data.columns.length ||
    data.columns.length > 100 ||
    data.rows.length > 10000 ||
    data.rows.length * data.columns.length > 200000
  )
    throw new DataOperationError(
      "This table exceeds the data lab's size or schema limits.",
      901,
    );
  if (
    new Set(data.columns.map((c) => c.name)).size !== data.columns.length ||
    data.columns.some(
      (c) => !validName(c.name) || !["numeric", "string"].includes(c.type),
    )
  )
    throw new DataOperationError(
      "Variable names must be unique and types must be numeric or string.",
    );
  for (const row of data.rows)
    for (const c of data.columns) {
      const v = row[c.name];
      if (
        c.type === "numeric"
          ? v !== null && (typeof v !== "number" || !Number.isFinite(v))
          : typeof v !== "string"
      )
        throw new DataOperationError(
          `Invalid ${c.type} value in ${c.name}.`,
          109,
        );
    }
  const resource = dataResourceError(data);
  if (resource) throw new DataOperationError(resource, 901);
}
function requireColumns(data, names) {
  if (
    !Array.isArray(names) ||
    !names.length ||
    new Set(names).size !== names.length ||
    names.some((n) => !data.columns.some((c) => c.name === n))
  )
    throw new DataOperationError(
      "Select distinct variables that exist in the source table.",
      111,
    );
}
export function auditKeys(data, names) {
  requireColumns(data, names);
  const groups = new Map(),
    missingRows = [];
  data.rows.forEach((row, index) => {
    const key = keyFor(row, names);
    if (!groups.has(key))
      groups.set(key, { keys: names.map((n) => row[n]), positions: [] });
    groups.get(key).positions.push(index + 1);
    if (names.some((name) => absent(row[name]))) missingRows.push(index + 1);
  });
  return {
    unique: [...groups.values()].every((g) => g.positions.length === 1),
    distinct: groups.size,
    missingRows,
    duplicates: [...groups.values()].filter((g) => g.positions.length > 1),
    groups,
  };
}
export const MERGE_TYPES = ["1:1", "m:1", "1:m"];
export const MERGE_CODES = {
  1: "Master only",
  2: "Using only",
  3: "Matched",
  4: "Missing values updated",
  5: "Conflicting values",
};
export const KEEP_CODES = {
  all: [1, 2, 3, 4, 5],
  matched: [3, 4, 5],
  master: [1, 3, 4, 5],
  using: [2, 3, 4, 5],
};

export function mergeData(
  master,
  using,
  { keys, type = "m:1", keep = "all", overlap = "master" } = {},
) {
  validate(master);
  validate(using);
  requireColumns(master, keys);
  requireColumns(using, keys);
  if (
    !MERGE_TYPES.includes(type) ||
    !Object.hasOwn(KEEP_CODES, keep) ||
    !["master", "update", "replace"].includes(overlap)
  )
    throw new DataOperationError(
      "Choose a supported merge type, retained sample and overlapping-value rule. m:m and sequential merges are not implemented.",
    );
  if ([master, using].some((d) => d.columns.some((c) => c.name === "_merge")))
    throw new DataOperationError(
      "A source already contains _merge. Rename that variable before creating a new merge indicator.",
      110,
    );
  for (const c of using.columns) {
    const counterpart = master.columns.find((m) => m.name === c.name);
    if (counterpart && counterpart.type !== c.type)
      throw new DataOperationError(
        `${c.name} has different types in the two tables. Review the source values before converting types.`,
        106,
      );
  }
  const masterAudit = auditKeys(master, keys),
    usingAudit = auditKeys(using, keys);
  const problems = [];
  if (type !== "m:1" && !masterAudit.unique)
    problems.push({ side: "master", ...masterAudit });
  if (type !== "1:m" && !usingAudit.unique)
    problems.push({ side: "using", ...usingAudit });
  if (problems.length)
    throw new DataOperationError(
      `The key is not unique in the ${problems.map((p) => p.side).join(" and ")} table. This ${type} declaration requires uniqueness there.`,
      459,
      { problems },
    );
  const columns = [
    ...clone(master.columns),
    ...clone(
      using.columns.filter(
        (c) => !master.columns.some((m) => m.name === c.name),
      ),
    ),
    { name: "_merge", type: "numeric", label: "Merge source/result" },
  ];
  const overlapping = master.columns
    .filter(
      (c) =>
        !keys.includes(c.name) && using.columns.some((u) => u.name === c.name),
    )
    .map((c) => c.name);
  const allKeys = [
    ...new Set([...masterAudit.groups.keys(), ...usingAudit.groups.keys()]),
  ].sort((a, b) => compareKeys(JSON.parse(a), JSON.parse(b)));
  const allRows = [],
    allLineage = [];
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let missingKeyMatches = 0,
    textCharacters = 0;
  for (const key of allKeys) {
    const ma = masterAudit.groups.get(key)?.positions || [],
      ua = usingAudit.groups.get(key)?.positions || [];
    const pairs =
      ma.length && ua.length
        ? ma.flatMap((m) => ua.map((u) => [m, u]))
        : ma.length
          ? ma.map((m) => [m, null])
          : ua.map((u) => [null, u]);
    for (const [m, u] of pairs) {
      const mr = m === null ? null : master.rows[m - 1],
        ur = u === null ? null : using.rows[u - 1];
      const row = {},
        decisions = [];
      let updated = false,
        conflict = false;
      for (const c of columns.filter((c) => c.name !== "_merge")) {
        const hasM = mr && Object.hasOwn(mr, c.name),
          hasU = ur && Object.hasOwn(ur, c.name);
        row[c.name] = hasM ? mr[c.name] : hasU ? ur[c.name] : emptyValue(c);
        if (hasM && hasU && overlapping.includes(c.name)) {
          const missingMaster = absent(mr[c.name]),
            missingUsing = absent(ur[c.name]);
          const differs =
            !missingMaster && !missingUsing && mr[c.name] !== ur[c.name];
          conflict ||= differs;
          const fill = overlap !== "master" && missingMaster && !missingUsing;
          const replace = overlap === "replace" && differs;
          updated ||= fill;
          if (fill || replace) row[c.name] = ur[c.name];
          if (mr[c.name] !== ur[c.name])
            decisions.push({
              name: c.name,
              master: mr[c.name],
              using: ur[c.name],
              result: row[c.name],
              action: fill
                ? "Filled missing master value"
                : replace
                  ? "Replaced conflicting master value"
                  : "Kept master value",
            });
        }
      }
      const code = !mr
        ? 2
        : !ur
          ? 1
          : overlap !== "master" && conflict
            ? 5
            : updated
              ? 4
              : 3;
      row._merge = code;
      counts[code]++;
      if (mr && ur && keys.some((name) => absent(row[name])))
        missingKeyMatches++;
      textCharacters += Object.values(row).reduce(
        (n, v) => n + (typeof v === "string" ? v.length : 0),
        0,
      );
      if (
        allRows.length >= 10000 ||
        (allRows.length + 1) * columns.length > 200000 ||
        textCharacters > 2000000
      )
        throw new DataOperationError(
          "The merged result would exceed the data lab's row, cell or text limits.",
          901,
        );
      allRows.push(row);
      allLineage.push({
        master: m,
        using: u,
        keys: JSON.parse(key),
        decisions,
      });
    }
  }
  const retained = allRows
    .map((row, i) => i)
    .filter((i) => KEEP_CODES[keep].includes(allRows[i]._merge));
  const data = { id: "merged", columns, rows: retained.map((i) => allRows[i]) };
  validate(data);
  return {
    data,
    lineage: retained.map((i) => allLineage[i]),
    counts,
    keptCounts: Object.fromEntries(
      Object.keys(counts).map((code) => [
        code,
        KEEP_CODES[keep].includes(Number(code)) ? counts[code] : 0,
      ]),
    ),
    totalRows: allRows.length,
    excluded: allRows.length - retained.length,
    masterAudit,
    usingAudit,
    overlapping,
    missingKeyMatches,
    options: { keys: [...keys], type, keep, overlap },
  };
}

export function reshapeData(
  data,
  {
    direction = "long",
    i = ["id"],
    j = "term",
    stubs = ["score", "hours"],
  } = {},
) {
  validate(data);
  requireColumns(data, i);
  if (!data.rows.length)
    throw new DataOperationError("No source observations are available.", 2000);
  if (
    !["long", "wide"].includes(direction) ||
    !validName(j) ||
    !Array.isArray(stubs) ||
    !stubs.length ||
    new Set(stubs).size !== stubs.length ||
    stubs.some((s) => !validName(s) || i.includes(s) || s === j) ||
    i.includes(j)
  )
    throw new DataOperationError(
      "Choose distinct stubs, identifiers and an index variable.",
    );
  const identifiers = auditKeys(data, i);
  let columns,
    rows = [],
    lineage = [],
    periods,
    retained,
    missingCells = 0;
  if (direction === "long") {
    if (!identifiers.unique)
      throw new DataOperationError(
        "The identifier is not unique in the wide data. One wide row must represent one identifier.",
        9,
        { problems: identifiers.duplicates },
      );
    if (data.columns.some((c) => c.name === j || stubs.includes(c.name)))
      throw new DataOperationError(
        "The new index or long-variable name already exists in the wide table.",
        110,
      );
    const families = stubs.map((stub) =>
      data.columns.flatMap((column) => {
        const suffix = column.name.startsWith(stub)
          ? column.name.slice(stub.length)
          : "";
        return /^[1-9]\d{0,2}$/.test(suffix)
          ? [{ column, period: Number(suffix) }]
          : [];
      }),
    );
    if (families.some((f) => !f.length))
      throw new DataOperationError(
        "Each selected stub needs at least one numbered column (positive integer suffix 1–999).",
        111,
      );
    if (families.some((f) => new Set(f.map((v) => v.column.type)).size > 1))
      throw new DataOperationError(
        "Columns in a stub family must have the same type.",
        109,
      );
    const renamed = families.flatMap((f) => f.map((v) => v.column.name));
    if (new Set(renamed).size !== renamed.length)
      throw new DataOperationError(
        "Stub families overlap. Choose stubs that identify separate column families.",
      );
    periods = [
      ...new Set(families.flatMap((f) => f.map((v) => v.period))),
    ].sort((a, b) => a - b);
    retained = data.columns.filter(
      (c) => !i.includes(c.name) && !renamed.includes(c.name),
    );
    columns = [
      ...i.map((name) => clone(data.columns.find((c) => c.name === name))),
      { name: j, type: "numeric", label: "Index from column suffix" },
      ...stubs.map((name, s) => ({
        name,
        type: families[s][0].column.type,
        label: name,
      })),
      ...clone(retained),
    ];
    outputSize(data.rows.length * periods.length, columns.length);
    for (const group of [...identifiers.groups.values()].sort((a, b) =>
      compareKeys(a.keys, b.keys),
    )) {
      const sourcePosition = group.positions[0],
        source = data.rows[sourcePosition - 1];
      for (const period of periods) {
        const row = {},
          cells = {};
        for (const name of [...i, ...retained.map((c) => c.name)]) {
          row[name] = source[name];
          cells[name] = { row: sourcePosition, column: name };
        }
        row[j] = period;
        cells[j] = { derived: `Column suffix ${period}` };
        stubs.forEach((stub, s) => {
          const found = families[s].find((f) => f.period === period);
          row[stub] = found
            ? source[found.column.name]
            : emptyValue(columns.find((c) => c.name === stub));
          cells[stub] = found
            ? { row: sourcePosition, column: found.column.name }
            : null;
          if (!found) missingCells++;
        });
        rows.push(row);
        lineage.push({ sourceRows: [sourcePosition], cells });
      }
    }
  } else {
    requireColumns(data, [j, ...stubs]);
    if (
      data.columns.find((c) => c.name === j).type !== "numeric" ||
      data.rows.some((r) => !Number.isInteger(r[j]) || r[j] < 1 || r[j] > 999)
    )
      throw new DataOperationError(
        "The index must contain observed integer values from 1 to 999 in this lab.",
        498,
      );
    const unique = auditKeys(data, [...i, j]);
    if (!unique.unique)
      throw new DataOperationError(
        "The index repeats within an identifier. A wide cell cannot hold more than one source value.",
        9,
        { problems: unique.duplicates },
      );
    periods = [...new Set(data.rows.map((r) => r[j]))].sort((a, b) => a - b);
    retained = data.columns.filter(
      (c) => ![...i, j, ...stubs].includes(c.name),
    );
    const varying = [];
    for (const group of identifiers.groups.values())
      for (const column of retained) {
        if (
          new Set(group.positions.map((pos) => data.rows[pos - 1][column.name]))
            .size > 1
        )
          varying.push({
            keys: group.keys,
            name: column.name,
            positions: group.positions,
          });
      }
    if (varying.length)
      throw new DataOperationError(
        "A variable outside the selected stubs varies within an identifier. Reshape that variable too, or investigate why it varies.",
        9,
        { varying },
      );
    const expanded = stubs.flatMap((stub) =>
      periods.map((period) => ({
        ...clone(data.columns.find((c) => c.name === stub)),
        name: `${stub}${period}`,
      })),
    );
    if (
      expanded.some(
        (c) =>
          !validName(c.name) ||
          [...i, ...retained.map((c) => c.name)].includes(c.name),
      ) ||
      new Set(expanded.map((c) => c.name)).size !== expanded.length
    )
      throw new DataOperationError(
        "The new wide column names conflict or exceed 32 characters.",
        110,
      );
    columns = [
      ...i.map((name) => clone(data.columns.find((c) => c.name === name))),
      ...expanded,
      ...clone(retained),
    ];
    outputSize(identifiers.distinct, columns.length);
    for (const group of [...identifiers.groups.values()].sort((a, b) =>
      compareKeys(a.keys, b.keys),
    )) {
      const row = {},
        cells = {},
        first = group.positions[0];
      for (const name of [...i, ...retained.map((c) => c.name)]) {
        row[name] = data.rows[first - 1][name];
        cells[name] = { row: first, column: name };
      }
      for (const stub of stubs)
        for (const period of periods) {
          const position = group.positions.find(
              (pos) => data.rows[pos - 1][j] === period,
            ),
            name = `${stub}${period}`;
          row[name] = position
            ? data.rows[position - 1][stub]
            : emptyValue(columns.find((c) => c.name === name));
          cells[name] = position ? { row: position, column: stub } : null;
          if (!position) missingCells++;
        }
      rows.push(row);
      lineage.push({ sourceRows: [...group.positions], cells });
    }
  }
  const result = { id: "reshaped", columns, rows };
  validate(result);
  return {
    data: result,
    lineage,
    periods,
    retained: retained.map((c) => c.name),
    missingCells,
    identifiers: identifiers.distinct,
    options: { direction, i: [...i], j, stubs: [...stubs] },
  };
}

const table = (id, title, unit, columns, values) => ({
  id,
  title,
  unit,
  columns: columns.map(([name, type = "numeric"]) => ({
    name,
    type,
    label: name,
  })),
  rows: values.map((row) =>
    Object.fromEntries(columns.map(([name], c) => [name, row[c]])),
  ),
});
export const MERGE_SCENARIOS = [
  {
    id: "orders",
    title: "Orders and customers",
    description:
      "Several orders may belong to one customer. Some keys occur in only one source.",
    type: "m:1",
    keys: ["customer"],
    master: table(
      "orders",
      "Orders",
      "One fictional order",
      [["order"], ["customer"], ["amount"]],
      [
        [101, 1, 40],
        [102, 1, 65],
        [103, 2, 20],
        [104, 3, 120],
        [105, 4, 80],
        [106, 9, 35],
        [107, 2, null],
      ],
    ),
    using: table(
      "customers",
      "Customers",
      "One fictional customer",
      [["customer"], ["region", "string"]],
      [
        [1, "North"],
        [2, "South"],
        [3, "West"],
        [4, "East"],
        [5, "North"],
      ],
    ),
  },
  {
    id: "terms",
    title: "Scores and attendance by term",
    description:
      "A student ID alone is not the key: the term distinguishes repeated observations.",
    type: "1:1",
    keys: ["id", "term"],
    master: table(
      "scores",
      "Scores",
      "One fictional student–term",
      [["id"], ["term"], ["score"]],
      [
        [1, 1, 60],
        [1, 2, 75],
        [2, 1, 80],
        [2, 2, null],
        [3, 1, 70],
      ],
    ),
    using: table(
      "attendance",
      "Attendance",
      "One fictional student–term",
      [["id"], ["term"], ["attendance"]],
      [
        [1, 1, 85],
        [1, 2, 90],
        [2, 1, 75],
        [3, 1, 80],
        [3, 2, 95],
      ],
    ),
  },
  {
    id: "overlap",
    title: "Conflicting register values",
    description:
      "Both sources contain region and age. Choose explicitly how missing or conflicting master values are treated.",
    type: "1:1",
    keys: ["customer"],
    master: table(
      "register",
      "Original register",
      "One fictional customer",
      [["customer"], ["region", "string"], ["age"]],
      [
        [1, "North", 30],
        [2, "", 40],
        [3, "West", null],
        [4, "East", 50],
      ],
    ),
    using: table(
      "revision",
      "Second register",
      "One fictional customer",
      [["customer"], ["region", "string"], ["age"]],
      [
        [1, "South", 30],
        [2, "South", 40],
        [3, "North", 35],
        [4, "", null],
        [5, "East", 60],
      ],
    ),
  },
];
export function mergeScenario(
  id = "orders",
  { reverse = false, duplicate = false, missing = false } = {},
) {
  const scenario = MERGE_SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new DataOperationError("Unknown merge example.");
  const s = clone(scenario);
  if (reverse) {
    [s.master, s.using] = [s.using, s.master];
    s.type = s.type === "m:1" ? "1:m" : s.type === "1:m" ? "m:1" : s.type;
  }
  if (duplicate) {
    const target = s.type === "1:m" ? s.master : s.using;
    target.rows.push(clone(target.rows[0]));
  }
  if (missing)
    for (const data of [s.master, s.using]) {
      const row = clone(data.rows[0]);
      if (Object.hasOwn(row, "order") && !s.keys.includes("order"))
        row.order = Math.max(...data.rows.map((r) => r.order)) + 1;
      for (const key of s.keys)
        row[key] = emptyValue(data.columns.find((c) => c.name === key));
      data.rows.push(row);
    }
  return s;
}
export function reshapeScenario({ direction = "long", issue = "none" } = {}) {
  const wide = table(
    "measurements",
    "Student measurements",
    "One fictional student",
    [
      ["id"],
      ["group", "string"],
      ["score1"],
      ["score2"],
      ["hours1"],
      ["hours2"],
    ],
    [
      [1, "A", 60, 75, 3, 5],
      [2, "B", 80, null, 6, 7],
      [3, "A", 70, 85, 4, 6],
    ],
  );
  let source = direction === "long" ? wide : reshapeData(wide).data;
  source = clone(source);
  source.title = "Student measurements";
  source.unit =
    direction === "long"
      ? "One fictional student"
      : "One fictional student–term";
  if (issue === "duplicate") source.rows.push(clone(source.rows[0]));
  else if (issue === "gap") {
    if (direction === "long") {
      source.columns = source.columns.filter((c) => c.name !== "hours2");
      source.rows.forEach((r) => delete r.hours2);
    } else
      source.rows = source.rows.filter((r) => !(r.id === 2 && r.term === 2));
  } else if (issue === "varying" && direction === "wide")
    source.rows.find((r) => r.id === 1 && r.term === 2).group = "B";
  else if (issue !== "none")
    throw new DataOperationError(
      "This source issue does not apply to the selected direction.",
    );
  return source;
}
export function mergeCommand(options, file = "using-data.dta") {
  const flags = [
    options.overlap === "update"
      ? "update"
      : options.overlap === "replace"
        ? "update replace"
        : "",
    options.keep !== "all" ? `keep(${KEEP_CODES[options.keep].join(" ")})` : "",
  ].filter(Boolean);
  return `merge ${options.type} ${options.keys.join(" ")} using "${file}"${flags.length ? ", " + flags.join(" ") : ""}`;
}
export const reshapeCommand = (options) =>
  `reshape ${options.direction} ${options.stubs.join(" ")}, i(${options.i.join(" ")}) j(${options.j})`;
export function dataProject(mode, sources, result) {
  const lines = [
    "* STATAverse data preparation lab — synthetic data",
    "* Work in the extracted project folder. Original CSVs remain unchanged.",
    "clear all",
    "set more off",
  ];
  const files = {};
  if (mode === "merge") {
    files["master.csv"] = toCSV(sources.master);
    files["using.csv"] = toCSV(sources.using);
    lines.push(
      nativeImportCommand("using.csv", sources.using),
      "tempfile using_data",
      "save `using_data'",
      nativeImportCommand("master.csv", sources.master),
      mergeCommand(result.options).replace('"using-data.dta"', "`using_data'"),
    );
  } else {
    files["source.csv"] = toCSV(sources);
    lines.push(
      nativeImportCommand("source.csv", sources),
      reshapeCommand(result.options),
    );
  }
  lines.push('export delimited using "native-result.csv", replace', "");
  files["analysis.do"] = lines.join("\n");
  files["browser-result.csv"] = toCSV(result.data);
  files["settings.json"] = JSON.stringify(
    { mode, options: result.options, source: "Synthetic teaching data" },
    null,
    2,
  );
  files["README.txt"] =
    "STATAverse data preparation lab\n\nExtract this folder, set it as Stata's working directory and run analysis.do. Source CSVs are synthetic. browser-result.csv contains the browser's displayed result; Stata writes native-result.csv.\n\nMerge results retain an explicit _merge indicator. Row order can differ; compare using the stated keys and source variables. Missing keys can match each other in Stata, which does not establish a real-world identity. update/replace decisions apply to overlapping non-key variables.\n\nThe browser implements a bounded subset, with double-precision numeric values, ordinary missing values and numeric reshape suffixes 1–999. Full native CSV import depends on the installed Stata runtime. Verification here substitutes native input for Java-dependent CSV import and checks the remaining exported commands.\n";
  return files;
}
