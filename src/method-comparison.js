import catalog from "../assets/data/method-lab.json" with { type: "json" };

export const METHOD_CATALOG = catalog;
export const METHOD_GROUPS = catalog.groups;
export function methodSelections(value = {}) {
  if (!value || typeof value !== "object") value = {};
  return Object.fromEntries(
    METHOD_GROUPS.map((group) => [
      group.id,
      group.options.some((option) => option.id === value[group.id])
        ? value[group.id]
        : "",
    ]),
  );
}
export function comparisonQuery(value) {
  return new URLSearchParams(
    Object.entries(methodSelections(value)).filter(([, value]) => value),
  ).toString();
}

export function compareMethods(value) {
  const selections = methodSelections(value);
  const missing = METHOD_GROUPS.filter((group) => !selections[group.id]).map(
    (group) => group.title,
  );
  if (missing.length) return { selections, missing, methods: [], notices: [] };
  const { outcome, structure, design, dependence } = selections;
  const panel = structure === "panel";
  const chosen = METHOD_GROUPS[0].options.find((o) => o.id === outcome);
  const ids = [...chosen.methods];
  if (panel && ["continuous", "binary", "fraction"].includes(outcome))
    ids.push("panel");
  if (panel && outcome === "count") ids.push("panelCount");
  const notices = [];
  if (design === "unresolved")
    notices.push({
      kind: "unresolved",
      title: "The causal interpretation is unresolved",
      text: "These outcome models can describe conditional associations. Concern about endogeneity alone does not establish an instrument, a treatment comparison or a valid causal estimator. Specify the mechanism and the source of identifying variation.",
    });
  else if (design === "association")
    notices.push({
      kind: "scope",
      title: "The target is an association or prediction",
      text: "Define the population, outcome units and sample. For prediction, evaluate performance on observations that were not used to fit or tune the model; preserve unit or time separation when observations are dependent.",
    });
  else if (design === "randomized")
    notices.push({
      kind: "scope",
      title: "Assignment and receipt are different treatments",
      text: "Randomization can justify an assignment-effect comparison when the assignment process, attrition and interference assumptions support it. Noncompliance does not make a regression on treatment received randomized. Use the assignment and sampling design to choose inference.",
    });
  else if (outcome === "duration")
    notices.push({
      kind: "unresolved",
      title: "A survival estimand needs a separate design specification",
      text: "The linear IV and two-period mean-DID templates here do not supply a causal hazard model or handle censoring. Define the event-time estimand and its identifying assumptions before selecting an estimator. No linear design command is generated for this combination.",
    });
  else {
    ids.push(design);
    notices.push({
      kind: "scope",
      title: "The proposed design still needs evidence",
      text: "Selecting a design records what you intend to investigate. The comparison cannot verify its assumptions from these choices. The linear design specification below and the outcome-model alternatives can target different quantities; they are not successive steps in one recipe.",
    });
  }
  if (dependence === "unresolved" || dependence === "survey")
    notices.push({
      kind: "unresolved",
      title:
        dependence === "survey"
          ? "The survey design must be specified first"
          : "The covariance structure is unresolved",
      text:
        dependence === "survey"
          ? "Declare weights, strata and sampling units with svyset, then check the estimator's survey support. The template commands are commented out; neither independent-observation robust covariance nor an arbitrary cluster variable substitutes for the survey design."
          : "Identify dependence and the sampling or assignment unit before interpreting uncertainty. The template commands are commented out until an inference choice is supplied.",
    });
  else if (dependence === "clustered")
    notices.push({
      kind: "inference",
      title: "Clusters must be justified by the design",
      text: "Replace cluster_id with the relevant sampling or assignment grouping. Clusters must be plausibly independent, and ordinary cluster-robust approximations can be poor with few clusters. For panel estimators, the cluster must contain entire panels. Clustering changes covariance, not confounding or the conditional mean.",
    });
  else if (panel)
    notices.push({
      kind: "unresolved",
      title: "Repeated records require a dependence check",
      text: "Repeated observations can share unit-level shocks. Independent-observation covariance is not supplied for the pooled templates. The fixed-effects examples use Stata's panel-level robust covariance; justify independence between panels or choose a defensible higher-level cluster.",
    });
  else
    notices.push({
      kind: "inference",
      title: "Robust covariance under independent observations",
      text: "The templates allow unequal conditional variances. This large-sample covariance choice does not remove omitted-variable bias, repair an incorrect mean model or establish independence.",
    });

  const methods = ids.map((id) => {
    const method = structuredClone(catalog.methods[id]);
    let code = method.stata;
    const isPanelEstimator = id === "panel" || id === "panelCount";
    if (id === "panelCount" && dependence === "clustered") {
      code =
        "* Unit indicators implement the multiplicative unit effects.\n* Use a cluster variable justified by sampling or assignment.\npoisson y x1 x2 i.id i.time, vce(cluster cluster_id)";
      method.scope +=
        " The clustered template uses unit indicators because xtpoisson, fe does not accept an arbitrary vce(cluster ...) option.";
    }
    const blocked =
      dependence === "unresolved" ||
      dependence === "survey" ||
      (panel && dependence === "independent" && !isPanelEstimator);
    if (panel && id === "did")
      code = "xtset id time\nxtreg y i.treated##i.post, fe {vce}";
    if (panel && id === "hazard") {
      code =
        "* One row per nonoverlapping at-risk interval.\n* start/stop are on the analysis time scale; event marks failure.\nstset stop, enter(time start) failure(event) id(id)\nstcox x1 x2, {vce}";
      method.scope +=
        " Repeated records require a valid risk-interval representation; a calendar panel is not automatically survival data.";
    }
    if (panel && ["logit", "count", "fractional"].includes(id))
      method.scope +=
        " This is a pooled mean specification: clustered covariance does not remove unit effects.";
    if (id === "panel" && outcome === "binary")
      method.scope +=
        " Here it is a linear probability specification, not fixed-effects logit.";
    if (id === "panel" && outcome === "fraction")
      method.scope +=
        " This linear specification can yield fitted shares outside [0,1].";
    const vce =
      dependence === "clustered" ? "vce(cluster cluster_id)" : "vce(robust)";
    code = code.replaceAll("{vce}", vce);
    if (blocked)
      code =
        "* Inference unresolved: model forms only, not commands to run.\n" +
        code
          .split("\n")
          .map((line) => (line.startsWith("*") ? line : "* " + line))
          .join("\n");
    return { ...method, id, code, blocked };
  });
  return { selections, missing, methods, notices };
}

export function methodPlanText(comparison, url = "") {
  if (comparison.missing.length)
    throw new Error("Complete the comparison first.");
  const lines = [
    "STATAverse · Method comparison",
    "",
    "Candidate specifications, not a validated analysis plan.",
  ];
  if (url) lines.push("Reopen this comparison: " + url);
  for (const group of METHOD_GROUPS) {
    const option = group.options.find(
      (o) => o.id === comparison.selections[group.id],
    );
    lines.push(`${group.title}: ${option.label}`);
  }
  for (const notice of comparison.notices)
    lines.push("", notice.title, notice.text);
  for (const method of comparison.methods) {
    lines.push(
      "",
      method.title,
      method.why,
      method.scope,
      "Assumptions:",
      ...method.assumptions.map((a) => "- " + a),
      "Stata template (replace variable names; full Stata required):",
      method.code,
      "Checks: " + method.diagnostic,
      "Limit: " + method.pitfall,
    );
    for (const link of method.links || [])
      lines.push(
        `${link.label}: ${url ? new URL(link.href, url).href : link.href}`,
      );
  }
  lines.push("", "Reporting", catalog.methods.reporting.diagnostic);
  return lines.join("\n") + "\n";
}
