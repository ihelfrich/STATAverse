import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { gzipSync } from "node:zlib";
import {
  ivSample,
  ivData,
  ivFit,
  ivParameters,
  arTest,
  quadraticSet,
  inConfidenceSet,
  ivDoFile,
} from "../src/labs/iv-model.js";
const close = (a, b, tol = 1e-9) =>
  assert.ok(
    Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b)),
    `${a} differs from ${b}`,
  );
test("the browser IV bundle stays within its compressed loading budget", () => {
  const bundle = fs.readFileSync(
    new URL("../assets/js/iv-lab.js", import.meta.url),
  );
  assert.ok(gzipSync(bundle).length < 40000);
});
test("IV estimates, both covariance matrices and AR tests agree with independent R", () => {
  const cases = JSON.parse(
    fs.readFileSync(new URL("fixtures/iv-lab/cases.json", import.meta.url)),
  );
  const references = JSON.parse(
    fs.readFileSync(new URL("fixtures/iv-lab/reference.json", import.meta.url)),
  ).models;
  for (const c of cases) {
    const s = ivSample(c.options),
      r = references[c.id];
    for (const k of ["b", "se", "intercept", "lo", "hi"])
      close(s.iv[k], r[k], ["lo", "hi"].includes(k) ? 1e-6 : 1e-9);
    s.iv.covariance.forEach((row, i) =>
      row.forEach((v, j) => close(v, r.covariance[i][j])),
    );
    for (const name of ["first", "reduced", "ols", "naive"])
      for (const k of ["b", "se", "intercept"]) close(s[name][k], r[name][k]);
    close(s.firstF, r.firstF);
    const t = arTest(s, c.candidate);
    close(t.f, r.ar.f);
    close(t.p, r.ar.p, 1e-7);
    for (const [lo, hi] of s.ar.intervals)
      for (const edge of [lo, hi])
        if (Number.isFinite(edge))
          close(arTest(s, edge).f, s.ar.critical, 1e-7);
    for (let b = -10; b <= 10; b += 0.125)
      assert.equal(inConfidenceSet(s.ar, b), arTest(s, b).accepted);
  }
});
test("quadratic inversion retains all confidence-set topologies and distant endpoints", () => {
  const cases = [
    [[1, 0, -1], "bounded", [[-1, 1]]],
    [
      [-1, 0, 1],
      "two-rays",
      [
        [-Infinity, -1],
        [1, Infinity],
      ],
    ],
    [[0, 2, -4], "half-line", [[-Infinity, 2]]],
    [[0, -2, -4], "half-line", [[-2, Infinity]]],
    [[1, 0, 0], "singleton", [[-0, -0]]],
    [[-1, 0, 0], "all", [[-Infinity, Infinity]]],
    [[0, 0, 1], "empty", []],
    [[0, 0, 0], "all", [[-Infinity, Infinity]]],
    [[1, 0, 1], "empty", []],
    [[-1, 0, -1], "all", [[-Infinity, Infinity]]],
  ];
  for (const [abc, kind, intervals] of cases) {
    const actual = quadraticSet(...abc);
    assert.equal(actual.kind, kind);
    assert.deepEqual(actual.intervals, intervals);
  }
  const distant = quadraticSet(1e-15, 1, -1);
  assert.equal(distant.kind, "bounded");
  close(distant.intervals[0][1], 1);
  assert.ok(distant.intervals[0][0] < -1e14);
});
test("simulation changes preserve draws and distinguish population identification from sample relevance", () => {
  const s = ivSample(),
    changed = ivSample({ delta: 0.8 }),
    irrelevant = ivSample({ pi: 0 });
  assert.deepEqual(ivData(), s.rows);
  s.rows.forEach((r, i) => {
    close(changed.rows[i].y - r.y, 0.8 * r.z);
    assert.equal(changed.rows[i].x, r.x);
  });
  close(s.population.ols, 1.35);
  close(changed.population.iv, 1.8);
  assert.equal(irrelevant.population.iv, null);
  assert.equal(irrelevant.population.identified, false);
  assert.ok(irrelevant.iv);
  assert.equal(s.ar.kind, "bounded");
  assert.equal(ivSample({ pi: 0.06 }).ar.kind, "all");
  assert.equal(ivSample({ pi: 0.06, seed: 8 }).ar.kind, "two-rays");
  close(s.iv.b, s.naive.b);
  assert.ok(Math.abs(s.iv.se - s.naive.se) > 0.001);
});
test("IV and AR respect row order and the instrument's affine units", () => {
  for (const robust of [false, true]) {
    const s = ivSample({ robust });
    for (const rows of [
      [...s.rows].reverse(),
      s.rows.map((r) => ({ ...r, z: 100 - 3 * r.z })),
    ]) {
      const t = ivFit(rows, { robust });
      close(s.iv.b, t.iv.b);
      close(s.iv.se, t.iv.se);
      close(s.firstF, t.firstF);
      for (const b of [-2, 0, 1, 3]) close(arTest(s, b).f, arTest(t, b).f);
    }
  }
});
test("invalid parameters and singular samples fail explicitly", () => {
  for (const p of [
    { n: 29 },
    { n: 2001 },
    { n: 30.5 },
    { seed: 0 },
    { pi: -1 },
    { delta: 3 },
    { rho: 1 },
    { sigma: 0 },
    { confidence: 0.8 },
    { robust: "yes" },
  ])
    assert.throws(() => ivParameters(p));
  assert.throws(() =>
    ivFit([
      { x: 1, y: 1, z: 1 },
      { x: 1, y: 2, z: 2 },
      { x: 1, y: 3, z: 3 },
    ]),
  );
  const orthogonal = ivFit([
    { x: -1, z: -1, y: 1 },
    { x: 1, z: -1, y: 3 },
    { x: -1, z: 1, y: 2 },
    { x: 1, z: 1, y: 5 },
  ]);
  assert.equal(orthogonal.iv, null);
  assert.equal(orthogonal.numericalSingular, true);
  assert.ok(arTest(orthogonal, 1).f >= 0);
  assert.throws(() => arTest(ivSample(), Infinity));
  const degenerate = ivFit([
    { x: 1, z: 1, y: 4 },
    { x: 2, z: 1, y: 5 },
    { x: 1, z: 2, y: 5 },
    { x: 2, z: 2, y: 6 },
  ]);
  assert.equal(degenerate.ar.kind, "unavailable");
  assert.equal(arTest(degenerate, 1).accepted, null);
  assert.equal(inConfidenceSet(degenerate.ar, 1), null);
  assert.throws(
    () =>
      ivFit(ivData().map((r) => ({ ...r, x: r.x * 1e-100, z: r.z * 1e-100 }))),
    /numerical range/,
  );
});
test("export distinguishes correct covariance, the deliberate mistake and optional current-Stata syntax", () => {
  const text = ivDoFile(ivSample({ robust: true, confidence: 0.9 }), 1.5);
  assert.match(
    text,
    /ivregress 2sls y \(x = z\), small vce\(robust\) level\(90\)/,
  );
  assert.match(text, /generate double ar_outcome = y - \(1.5\)\*x/);
  assert.match(text, /\* estat weakrobust, ar ci/);
  assert.match(text, /incorrect second-stage standard errors/);
});
