import { StataError } from "./expression.js";
import { missing, mean, regress } from "./statistics.js";

const MAX_TERMS = 256;
const limit = () => {
  throw new StataError(
    "This factor expansion exceeds the browser limit of 256 model columns.",
    901,
    "If these are measurements rather than categories, use c. before each variable, for example c.attendance##c.score. Otherwise fit a smaller model or use installed Stata.",
  );
};
const key = (term) =>
  term
    .map((a) => `${a.type}:${a.variable}:${a.level ?? ""}`)
    .sort()
    .join("|");
const unique = (terms) => {
  const seen = new Set();
  return terms.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// Spaces separate model terms only outside groups and base-level operators.
function words(source) {
  let depth = 0,
    start = 0;
  const out = [];
  for (let i = 0; i <= source.length; i++) {
    if (source[i] === "(") depth++;
    if (source[i] === ")" && --depth < 0)
      throw new StataError("Unmatched parenthesis in the model.");
    if (i === source.length || (!depth && /\s/.test(source[i]))) {
      if (i > start) out.push(source.slice(start, i));
      start = i + 1;
    }
  }
  if (depth) throw new StataError("Unmatched parenthesis in the model.");
  return out;
}

function parseTerms(source, resolve, bases) {
  const parse = (text, interaction = false, inherited = "", depth = 0) => {
    if (depth > 8)
      throw new StataError("Use at most eight nested factor groups.");
    let nesting = 0,
      start = 0;
    const parts = [],
      ops = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "(") nesting++;
      if (text[i] === ")") nesting--;
      if (text[i] === "#" && !nesting) {
        parts.push(text.slice(start, i));
        const op = text[i + 1] === "#" ? "##" : "#";
        ops.push(op);
        i += op.length - 1;
        start = i + 1;
      }
    }
    if (ops.length) {
      parts.push(text.slice(start));
      if (parts.some((p) => !p))
        throw new StataError("Use # or ## between model variables.");
      let left = parse(parts[0], true, inherited, depth + 1);
      for (let i = 0; i < ops.length; i++) {
        const right = parse(parts[i + 1], true, inherited, depth + 1);
        if (left.length * right.length + left.length + right.length > MAX_TERMS)
          limit();
        const crossed = left.flatMap((a) => right.map((b) => [...a, ...b]));
        left = unique(
          ops[i] === "##" ? [...left, ...right, ...crossed] : crossed,
        );
      }
      return left;
    }
    const group = text.match(/^(?:(c|i)\.)?\((.*)\)$/);
    if (group) {
      const members = words(group[2]);
      if (!members.length)
        throw new StataError("A factor group cannot be empty.");
      return members.flatMap((s) =>
        parse(s, interaction, group[1] || inherited, depth + 1),
      );
    }
    const atom = text.match(
      /^(?:(c|i|ibn|ib\d+|b\d+|ib\((?:first|last|freq)\)|\d+)\.)?([A-Za-z_][A-Za-z_0-9*?-]*|\*)$/,
    );
    if (!atom)
      throw new StataError(
        `Cannot read model term ${text}.`,
        198,
        "Use c.x for a measurement, i.group for categories, # for a product, or ## to include the component terms too. Time-series and omitted-level operators are not implemented here.",
      );
    const prefix = atom[1] || inherited || (interaction ? "i" : "c");
    return resolve(atom[2]).map((variable) => {
      const type = prefix === "c" ? "continuous" : "categorical";
      const base =
        prefix === "ibn"
          ? "none"
          : /^(?:ib|b)/.test(prefix)
            ? prefix.replace(/^ib|^b/, "").replace(/[()]/g, "")
            : null;
      if (base !== null) {
        if (bases.has(variable) && bases.get(variable) !== base)
          throw new StataError(`Conflicting base levels for ${variable}.`);
        bases.set(variable, base);
      }
      return [
        {
          variable,
          type,
          ...(/^\d+$/.test(prefix) ? { level: Number(prefix) } : {}),
        },
      ];
    });
  };
  const terms = words(source.replace(/\s*#\s*/g, "#")).flatMap((s) => parse(s));
  if (terms.length > MAX_TERMS) limit();
  if (terms.some((t) => t.length > 8))
    throw new StataError("Use at most eight factors in an interaction.");
  return unique(terms);
}

export function termValue(term, row) {
  if (term.components.some((a) => missing(row[a.variable]))) return null;
  return term.components.reduce(
    (v, a) =>
      v *
      (a.type === "continuous"
        ? row[a.variable]
        : Number(row[a.variable] === a.level)),
    1,
  );
}

export function factorRegression(source, data, selected, robust, resolve) {
  const [outcome, ...rest] = words(source);
  if (!outcome || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(outcome))
    throw new StataError(
      "Specify one outcome variable before the model terms.",
    );
  const [dependent] = resolve(outcome);
  const bases = new Map();
  const parsed = parseTerms(rest.join(" "), resolve, bases);
  const sourceVariables = [...new Set(parsed.flat().map((a) => a.variable))];
  const sample = selected.filter((row) =>
    [dependent, ...sourceVariables].every((v) => !missing(row[v])),
  );
  if (!sample.length)
    throw new StataError("No complete observations for this model.", 2000);
  const categories = new Map();
  for (const a of parsed.flat().filter((a) => a.type === "categorical")) {
    if (categories.has(a.variable)) continue;
    const values = sample.map((r) => r[a.variable]);
    if (values.some((v) => !Number.isInteger(v) || v < 0))
      throw new StataError(
        `${a.variable}: factor variables require nonnegative integer values.`,
        452,
        `If ${a.variable} is a measurement, write c.${a.variable}. Bare variables inside # and ## are treated as categories.`,
      );
    const levels = [...new Set(values)].sort((a, b) => a - b);
    let base = bases.get(a.variable) ?? "first";
    if (base === "first") base = levels[0];
    else if (base === "last") base = levels.at(-1);
    else if (base === "freq") {
      const counts = new Map();
      for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
      base = levels.reduce((best, v) =>
        counts.get(v) > counts.get(best) ? v : best,
      );
    } else if (base !== "none") base = Number(base);
    if (base !== "none" && !levels.includes(base)) levels.push(base);
    levels.sort((a, b) => a - b);
    categories.set(a.variable, { levels, base });
  }
  const terms = [],
    seen = new Set();
  for (const expression of parsed) {
    let expanded = [[]];
    for (const a of expression) {
      const category = categories.get(a.variable);
      const components =
        a.type === "continuous"
          ? [a]
          : (a.level === undefined ? category.levels : [a.level]).map(
              (level) => ({
                ...a,
                level,
                base: a.level === undefined && level === category.base,
              }),
            );
      if (expanded.length * components.length + terms.length > MAX_TERMS)
        limit();
      expanded = expanded.flatMap((left) =>
        components.map((right) => [...left, right]),
      );
    }
    // Prefer nonbase columns; a base-group slope is retained when there is no
    // common slope in the specification. Sorting is within each model term.
    expanded.sort(
      (a, b) => a.filter((x) => x.base).length - b.filter((x) => x.base).length,
    );
    for (let components of expanded) {
      // Repeated indicators are idempotent; powers of continuous variables are not.
      components = components.filter(
        (a, i) =>
          a.type === "continuous" ||
          !components
            .slice(0, i)
            .some((b) => a.variable === b.variable && a.level === b.level),
      );
      components.sort(
        (a, b) =>
          Number(a.type === "continuous") - Number(b.type === "continuous"),
      );
      const signature = key(components);
      if (seen.has(signature)) continue;
      seen.add(signature);
      const name = components
        .map((a) =>
          a.type === "continuous"
            ? (components.length > 1 ? "c." : "") + a.variable
            : `${a.level}.${a.variable}`,
        )
        .join("#");
      const reference = components.every(
        (a) => a.type === "categorical" && a.base,
      );
      terms.push({
        name,
        components,
        ...(reference ? { omitted: "reference" } : {}),
      });
    }
  }
  if (sample.length * terms.length > 500_000)
    throw new StataError(
      "This factor model exceeds the browser limit of 500,000 design cells.",
      901,
      "Reduce the sample or the number of categories, or fit this model in installed Stata.",
    );
  // Lower-order terms take precedence even when written after an interaction
  // (for example i.group#c.x x). Otherwise a group slope could absorb the
  // common slope and give the right fitted values with the wrong coefficients.
  terms.sort((a, b) => a.components.length - b.components.length);
  const design = sample.map((row) => ({ ...row }));
  // Modified Gram-Schmidt with a second pass identifies exact redundancies.
  // The existing SVD/QR fitter still rejects poorly conditioned retained designs.
  const basis = [],
    active = [];
  for (const term of terms) {
    if (term.omitted) continue;
    const values = sample.map((row) => termValue(term, row));
    if (values.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e100))
      throw new StataError(
        "An interaction exceeds the supported numerical range. Rescale its source variables.",
        498,
      );
    const center = mean(values),
      scale = Math.max(...values.map(Math.abs));
    let vector = values.map((v) => (scale ? (v - center) / scale : 0));
    const norm = Math.hypot(...vector);
    if (norm) vector = vector.map((v) => v / norm);
    for (let pass = 0; pass < 2; pass++)
      for (const q of basis) {
        const projection = vector.reduce((s, v, i) => s + v * q[i], 0);
        vector = vector.map((v, i) => v - projection * q[i]);
      }
    const remainder = Math.hypot(...vector);
    if (!norm || remainder < 1e-12) {
      term.omitted = values.every((v) => v === 0) ? "empty" : "collinear";
      continue;
    }
    basis.push(vector.map((v) => v / remainder));
    active.push(term);
    design.forEach((row, i) => {
      row[term.name] = values[i];
    });
  }
  const model = regress(
    design,
    dependent,
    active.map((t) => t.name),
    robust,
    { allowSaturated: true },
  );
  model.factorTerms = active;
  model.omittedTerms = terms.filter((t) => t.omitted);
  model.sourceVariables = sourceVariables;
  model.factorSpecification = source;
  return model;
}
