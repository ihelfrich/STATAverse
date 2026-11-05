import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  inferenceData,
  inferenceParameters,
  inferenceSample,
  inferenceFit,
  inferenceDoFile,
  inferenceSimulationDoFile,
  compactSample,
  simulationRate,
  summarizeSimulation,
} from "../src/labs/inference-model.js";
const close = (a, b, tolerance = 1e-10) =>
  assert.ok(
    Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b)),
    `${a} differs from ${b}`,
  );

test("inference samples are reproducible and parameter changes retain the underlying draws", () => {
  const original = inferenceData();
  assert.deepEqual(inferenceData(), original);
  assert.notDeepEqual(inferenceData({}, 1), original);
  const changed = inferenceData({ beta: 2 });
  for (let i = 0; i < original.length; i++) {
    assert.equal(changed[i].x, original[i].x);
    close(changed[i].y - original[i].y, original[i].x);
    assert.equal(changed[i].error, original[i].error);
  }
  for (const invalid of [
    { groups: 1 },
    { perGroup: 2.5 },
    { seed: 0 },
    { errorICC: 1 },
    { xICC: -1 },
    { confidence: 0.5 },
    { repetitions: 2001 },
  ])
    assert.throws(() => inferenceParameters(invalid));
  assert.throws(() => inferenceData({}, 2000));
});

test("all covariance and inference methods agree with independent R references", () => {
  const folder = new URL("fixtures/inference-lab/", import.meta.url);
  const cases = JSON.parse(fs.readFileSync(new URL("cases.json", folder)));
  const references = JSON.parse(
    fs.readFileSync(new URL("reference.json", folder)),
  ).models;
  for (const entry of cases) {
    const sample = inferenceSample(entry.options, entry.replication),
      expected = references[entry.id];
    for (const key of ["b", "intercept", "n", "groups"])
      close(sample[key], expected[key]);
    sample.residuals.forEach((x, i) => close(x, expected.residuals[i]));
    for (const method of ["conventional", "hc1", "cluster"])
      for (const field of [
        "se",
        "df",
        "critical",
        "lo",
        "hi",
        "p",
        "covers",
        "rejects",
      ]) {
        const actual = sample.methods[method][field],
          target = expected.methods[method][field];
        if (typeof actual === "boolean") assert.equal(actual, target);
        else
          close(
            actual,
            target,
            ["critical", "lo", "hi"].includes(field)
              ? 1e-6
              : field === "p"
                ? 1e-7
                : 1e-10,
          );
      }
  }
});

test("cluster covariance nests HC1 for singleton groups and respects units and ordering", () => {
  const rows = inferenceData({
    groups: 20,
    perGroup: 4,
    errorICC: 0.7,
    xICC: 0.6,
  });
  const singletons = inferenceFit(rows.map((r) => ({ ...r, cluster: r.id })));
  close(singletons.methods.hc1.se, singletons.methods.cluster.se);
  const fit = inferenceFit(rows),
    reversed = inferenceFit([...rows].reverse());
  const units = inferenceFit(
    rows.map((r) => ({ ...r, x: r.x * 10 + 100, y: r.y + 50 })),
  );
  close(fit.b, reversed.b);
  close(units.b, fit.b / 10);
  for (const method of ["conventional", "hc1", "cluster"]) {
    close(fit.methods[method].se, reversed.methods[method].se);
    close(units.methods[method].se, fit.methods[method].se / 10);
  }
  assert.throws(
    () => inferenceFit(rows.map((r) => ({ ...r, cluster: 1 }))),
    /two/,
  );
  assert.throws(() => inferenceFit(rows.map((r) => ({ ...r, x: 1 }))), /vary/);
});

test("simulation summaries retain finite-run uncertainty, counts and a common coefficient distribution", () => {
  const options = { groups: 10, perGroup: 5, errorICC: 0.6, xICC: 0.5 };
  const records = Array.from({ length: 50 }, (_, i) =>
    compactSample(inferenceSample(options, i)),
  );
  const summary = summarizeSimulation(records, options);
  assert.equal(summary.repetitions, 50);
  close(summary.meanB, records.reduce((s, r) => s + r.b, 0) / 50);
  close(summary.meanMCSE, summary.empiricalSD / Math.sqrt(50));
  for (const id of ["conventional", "hc1", "cluster"]) {
    const coverage = summary.methods[id].coverage;
    assert.equal(
      coverage.count,
      records.filter((r) => r.methods[id].covers).length,
    );
    assert.ok(coverage.lo <= coverage.rate && coverage.rate <= coverage.hi);
  }
  assert.ok(simulationRate(0, 50).hi > 0);
  assert.ok(simulationRate(50, 50).lo < 1);
  assert.throws(() => simulationRate(51, 50));
  assert.throws(() => summarizeSimulation([]));
  const code = inferenceDoFile(inferenceSample(options));
  assert.match(code, /vce\(cluster cluster\) level\(95\)/);
  assert.match(code, /not a Stata RNG seed/);
  const native = inferenceSimulationDoFile({ seed: 4294967295 });
  assert.match(native, /set rng mt64/);
  assert.match(native, /saving\("native-repetitions.dta", double replace\)/);
  assert.ok(Number(native.match(/ seed\((\d+)\)/)[1]) < 2147483647);
});

test("generator moments preserve exogeneity and the stated within-group dependence", () => {
  const options = {
    groups: 100,
    perGroup: 20,
    xICC: 0.7,
    errorICC: 0.6,
    heterogeneity: 1,
  };
  let n = 0,
    sx = 0,
    se = 0,
    sx2 = 0,
    se2 = 0,
    sxe = 0,
    pairs = 0,
    crossX = 0,
    crossE = 0;
  for (let replication = 0; replication < 100; replication++) {
    const rows = inferenceData(options, replication);
    for (let g = 0; g < 100; g++) {
      const group = rows.slice(g * 20, (g + 1) * 20);
      for (let i = 0; i < group.length; i++) {
        const x = group[i].x,
          e = group[i].error / group[i].error_sd;
        n++;
        sx += x;
        se += e;
        sx2 += x * x;
        se2 += e * e;
        sxe += x * e;
        for (let j = 0; j < i; j++) {
          pairs++;
          crossX += x * group[j].x;
          crossE += (e * group[j].error) / group[j].error_sd;
        }
      }
    }
  }
  for (const value of [sx / n, se / n, sxe / n])
    assert.ok(Math.abs(value) < 0.03);
  assert.ok(Math.abs(sx2 / n - 1) < 0.03);
  assert.ok(Math.abs(se2 / n - 1) < 0.03);
  assert.ok(Math.abs(crossX / pairs - 0.7) < 0.03);
  assert.ok(Math.abs(crossE / pairs - 0.6) < 0.03);
});
