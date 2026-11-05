import fs from "node:fs/promises";
import catalog from "../assets/data/method-lab.json" with { type: "json" };

// The browser reference and downloadable Stata guides share one set of claims.
// These guides print templates; they never clear data or fit the placeholder models.
const line = (text, result = false) => {
  if (/[`$\r\n]/.test(text) || text.includes("\"'"))
    throw new Error(
      "A guide string would expand a macro or close a Stata quote.",
    );
  return `    display as ${result ? "result" : "text"} \`"${text}"'`;
};
const prose = (text) => {
  const words = text.split(/\s+/),
    lines = [];
  let current = "";
  for (const word of words) {
    if (current && current.length + word.length > 89) {
      lines.push(line(current));
      current = "";
    }
    current += (current ? " " : "") + word;
  }
  if (current) lines.push(line(current));
  return lines;
};
export function methodGuide({ compact = false } = {}) {
  const rows = [
    "* STATAverse: method reference",
    "* Generated from assets/data/method-lab.json by tools/build-method-guides.mjs.",
    "* Revised 5 November 2026. The legacy filename remains for existing links.",
    "* This file prints guidance and template commands. It does not change your data.",
    "* Optional argument: one topic below; omit it to print all topics.",
    `* Topics: ${Object.keys(catalog.methods).join(", ")}`,
    "version 16.0",
    "args topic",
    'if "`topic\'" == "" local topic "all"',
    "local found = 0",
    'display as text "STATAverse: method reference"',
    ...prose(
      "An outcome model, a research design and an inference method are distinct choices. These templates do not select a validated estimator or establish a causal interpretation.",
    ),
    ...prose(
      "For a comparison that records outcome, observation structure, design and dependence, use https://ihelfrich.github.io/learn/stata/MethodLab/.",
    ),
    ...prose(
      "Replace placeholder variable names and justify the covariance before running any printed command. The robust templates below require independent observations. For xtreg, fe and xtpoisson, fe, vce(robust) instead allows dependence within each panel and requires independent panels. Complex survey designs require estimator-specific support.",
    ),
  ];
  for (const [id, method] of Object.entries(catalog.methods)) {
    rows.push(
      "",
      `if inlist("\`topic'", "all", "${id}") {`,
      "    local found = 1",
      '    display ""',
      line(method.title, true),
      ...prose(method.why),
      ...prose(method.scope),
      ...method.assumptions.flatMap((a) => prose("Condition: " + a)),
      ...prose("Limit: " + method.pitfall),
    );
    if (!compact) {
      rows.push(
        ...prose("Checks: " + method.diagnostic),
        line("Stata template (printed, not executed):"),
      );
      rows.push(
        ...method.stata
          .replaceAll("{vce}", "vce(robust)")
          .split("\n")
          .map((code) => line(code, true)),
      );
      for (const link of method.links || [])
        rows.push(
          ...prose(
            link.label +
              ": " +
              new URL(
                link.href,
                "https://ihelfrich.github.io/learn/stata/MethodLab/",
              ).href,
          ),
        );
    }
    rows.push("}");
  }
  rows.push(
    "",
    "if !`found' {",
    '    display as error "Unknown topic. See the topic names in this file header."',
    "    exit 198",
    "}",
    "",
  );
  return rows.join("\n");
}
export async function buildMethodGuides() {
  await fs.writeFile(
    "CodeLibrary/scripts/02_method_decision_tree.do",
    methodGuide({ compact: true }),
  );
  await fs.writeFile(
    "CodeLibrary/scripts/02_method_decision_tree_v2.do",
    methodGuide(),
  );
}
