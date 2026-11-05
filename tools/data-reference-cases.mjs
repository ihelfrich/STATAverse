import { mergeScenario, reshapeScenario } from "../src/labs/data-model.js";
export function dataReferenceCases() {
  const cases = [];
  const merge = (id, scenario, settings = {}, modifications = {}) => {
    const sources = mergeScenario(scenario, modifications);
    cases.push({
      id,
      mode: "merge",
      sources,
      options: {
        keys: sources.keys,
        type: sources.type,
        keep: "all",
        overlap: "master",
        ...settings,
      },
    });
  };
  merge("orders", "orders");
  merge("orders-reversed", "orders", {}, { reverse: true });
  merge("orders-missing-key", "orders", {}, { missing: true });
  merge("orders-duplicate-using", "orders", {}, { duplicate: true });
  merge(
    "orders-duplicate-master",
    "orders",
    {},
    { reverse: true, duplicate: true },
  );
  merge("orders-wrong-type", "orders", { type: "1:1" });
  for (const keep of ["matched", "master", "using"])
    merge(`keep-${keep}`, "orders", { keep });
  merge("composite-key", "terms");
  merge("incomplete-key", "terms", { keys: ["id"] });
  merge("no-matches-retained", "overlap", {
    keys: ["customer", "region", "age"],
    keep: "matched",
  });
  merge("empty-master", "orders");
  cases.at(-1).sources.master.rows = [];
  merge("string-missing-keys", "orders", {}, { missing: true });
  for (const data of [
    cases.at(-1).sources.master,
    cases.at(-1).sources.using,
  ]) {
    data.columns.find((c) => c.name === "customer").type = "string";
    data.rows.forEach(
      (r) => (r.customer = r.customer === null ? "" : String(r.customer)),
    );
  }
  merge("partially-missing-composite", "terms");
  for (const data of [
    cases.at(-1).sources.master,
    cases.at(-1).sources.using,
  ]) {
    data.rows.find((r) => r.id === 1 && r.term === 2).term = null;
  }
  for (const overlap of ["master", "update", "replace"]) {
    merge(`overlap-${overlap}`, "overlap", { overlap });
    merge(`overlap-${overlap}-matched`, "overlap", {
      overlap,
      keep: "matched",
    });
  }
  merge("key-type-mismatch", "orders");
  const mismatch = cases.at(-1).sources.using;
  mismatch.columns.find((c) => c.name === "customer").type = "string";
  mismatch.rows.forEach((r) => (r.customer = String(r.customer)));
  for (const direction of ["long", "wide"]) {
    for (const issue of [
      "none",
      "duplicate",
      "gap",
      ...(direction === "wide" ? ["varying"] : []),
    ]) {
      cases.push({
        id: `reshape-${direction}-${issue}`,
        mode: "reshape",
        sources: reshapeScenario({ direction, issue }),
        options: { direction, i: ["id"], j: "term", stubs: ["score", "hours"] },
      });
    }
    cases.push({
      id: `reshape-${direction}-one-stub`,
      mode: "reshape",
      sources: reshapeScenario({ direction }),
      options: { direction, i: ["id"], j: "term", stubs: ["score"] },
    });
  }
  cases.push({
    id: "reshape-wide-varying-included",
    mode: "reshape",
    sources: reshapeScenario({ direction: "wide", issue: "varying" }),
    options: {
      direction: "wide",
      i: ["id"],
      j: "term",
      stubs: ["score", "hours", "group"],
    },
  });
  return cases;
}
