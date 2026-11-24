// The simulated firm-year panel of the project lab: that it is the same
// panel every time, that it has the shape the lab describes, and that both
// of its forms (.dta bytes and CSV) carry the same values into a session.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createConsoleSession } from "../src/console-session.js";
import { readDta } from "../src/console-dta.js";
import { MISSING } from "../src/runtime/values.js";
import {
  FIRST_YEAR,
  LAST_YEAR,
  PANEL_SEED,
  PANEL_VARIABLES,
  buildPanel,
  dateText,
  panelCsv,
  panelFingerprint,
} from "../src/panel-project/panel-data.js";
import { PANEL_FILE, panelDta } from "../src/panel-project/panel-dta.js";

const panel = buildPanel(),
  n = panel.observations,
  column = Object.fromEntries(panel.variables.map((v) => [v.name, v.values])),
  rows = [...Array(n).keys()],
  share = (list, keep) => list.filter(keep).length / list.length,
  missing = (name) => share(rows, (i) => Number.isNaN(column[name][i])),
  matched = (name) => (i) => column[name][i] === 3,
  both = rows.filter(
    (i) => matched("match_exec")(i) && matched("match_audit")(i),
  ),
  title = (i) => column.titleann[i].trim().toLowerCase(),
  median = (list) =>
    [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

test("the same seed gives the same panel, to the last character", () => {
  const csv = panelCsv(panel);
  assert.equal(panelCsv(buildPanel()), csv);
  assert.equal(panelCsv(buildPanel(PANEL_SEED)), csv);
  // The panel the native fixture was recorded from. A change to the
  // generator changes these, and the fixture has to be recorded again
  // (node tools/check-project-native.mjs).
  assert.equal(panelFingerprint(panel), "d2df056a0afa0962");
  assert.equal(
    createHash("sha256").update(csv).digest("hex"),
    "cf2f2cf673728ae325b8fcd437718de0b2c5bfb005938fb4a720b87ac1311b91",
  );
  assert.notEqual(
    panelFingerprint(buildPanel(PANEL_SEED + 1)),
    panelFingerprint(panel),
  );
  // The .dta bytes are fixed too, time stamp included.
  assert.deepEqual(panelDta(panel), panelDta(buildPanel()));
});

test("the variables are the ones the lab expects, in name, order and type", () => {
  assert.deepEqual(
    panel.variables.map((v) => [
      v.name,
      ["gvkey", "fiscal_ye"].includes(v.name)
        ? v.type
        : v.type.replace(/^str\d+$/, "str"),
    ]),
    [
      ["firmid", "long"],
      ["gvkey", "str6"],
      ["conm", "str"],
      ["fyear", "int"],
      ["datadate", "int"],
      ["at", "double"],
      ["dltt", "double"],
      ["ni", "double"],
      ["sale", "double"],
      ["oancf", "double"],
      ["sich", "int"],
      ["titleann", "str"],
      ["non_audit_fees", "double"],
      ["audit_fees", "double"],
      ["total_fees", "double"],
      ["auditor_name", "str"],
      ["fiscal_ye", "str4"],
      ["match_exec", "byte"],
      ["match_audit", "byte"],
    ],
  );
  assert.deepEqual(
    panel.variables.map((v) => v.name),
    PANEL_VARIABLES.map((v) => v.name),
  );
  for (const v of panel.variables) {
    assert.equal(v.values.length, n);
    assert.ok(v.label.length > 0 && v.label.length <= 80, v.name);
  }
  assert.equal(
    panel.variables.find((v) => v.name === "datadate").format,
    "%td",
  );
});

test("a firm-year panel of about 5,500 firms, unbalanced, 2004 to 2023", () => {
  assert.ok(n >= 45000 && n <= 50000, `${n} rows`);
  const years = new Map();
  for (const i of rows) {
    // Sorted by firm and year, one row per firm-year.
    if (i)
      assert.ok(
        column.firmid[i] > column.firmid[i - 1] ||
          (column.firmid[i] === column.firmid[i - 1] &&
            column.fyear[i] > column.fyear[i - 1]),
      );
    assert.ok(column.fyear[i] >= FIRST_YEAR && column.fyear[i] <= LAST_YEAR);
    years.set(column.firmid[i], [
      ...(years.get(column.firmid[i]) ?? []),
      column.fyear[i],
    ]);
  }
  assert.equal(years.size, 5500);
  const counts = [...years.values()].map((list) => list.length),
    gaps = [...years.values()].filter(
      (list) => list.at(-1) - list[0] + 1 > list.length,
    ).length;
  assert.ok(median(counts) >= 5 && median(counts) <= 7);
  assert.ok(
    share(counts, (c) => c === 20) > 0.08,
    "many firms span all 20 years",
  );
  assert.ok(share(counts, (c) => c <= 3) > 0.2, "many firms are short-lived");
  assert.ok(gaps >= 20, "some firms skip a year");
});

test("identifiers and names are plainly invented", () => {
  const names = new Map();
  for (const i of rows) {
    assert.match(column.gvkey[i], /^9\d{5}$/);
    assert.match(column.conm[i], /^[A-Z]+ [A-Z]+ [A-Z ]+$/);
    names.set(column.conm[i], column.firmid[i]);
    assert.ok(Number.isInteger(column.firmid[i]));
  }
  // One name per firm.
  assert.equal(names.size, 5500);
  // Only the four large audit firms are real names.
  const auditors = new Set(
    rows
      .map((i) => column.auditor_name[i].trim().toLowerCase())
      .filter(Boolean),
  );
  assert.ok(auditors.size > 20 && auditors.size < 45);
});

test("missing values and merge results fall where the lab says", () => {
  // Accounting items are missing in a little under a quarter of rows, fees
  // wherever the fee file had no match.
  for (const name of ["at", "dltt", "ni", "sale", "oancf", "sich"])
    assert.ok(missing(name) > 0.19 && missing(name) < 0.27, name);
  for (const i of rows) {
    assert.ok([1, 3].includes(column.match_exec[i]));
    assert.ok([1, 3].includes(column.match_audit[i]));
    const fees = !Number.isNaN(column.non_audit_fees[i]);
    assert.equal(fees, column.match_audit[i] === 3);
    assert.equal(fees, !Number.isNaN(column.audit_fees[i]));
    assert.equal(fees, column.auditor_name[i] !== "");
    assert.equal(fees, column.fiscal_ye[i] !== "");
    if (column.match_exec[i] !== 3) assert.equal(column.titleann[i], "");
    if (fees)
      assert.ok(
        column.total_fees[i] >= column.audit_fees[i] + column.non_audit_fees[i],
      );
    assert.ok(!Number.isNaN(column.datadate[i]));
  }
  assert.ok(
    missing("non_audit_fees") > 0.32 && missing("non_audit_fees") < 0.42,
  );
  const inYear = (year) => rows.filter((i) => column.fyear[i] === year);
  assert.equal(share(inYear(2004), matched("match_exec")), 0);
  assert.ok(share(rows, matched("match_exec")) > 0.17);
  assert.ok(share(rows, matched("match_exec")) < 0.26);
  assert.ok(share(rows, matched("match_audit")) > 0.56);
  assert.ok(share(rows, matched("match_audit")) < 0.7);
  // The fee file covers fewer firms as the years go on.
  assert.ok(
    share(inYear(2005), matched("match_audit")) -
      share(inYear(2023), matched("match_audit")) >
      0.1,
  );
  assert.ok(both.length / n > 0.14 && both.length / n < 0.21);
});

test("titles: variety, the chair share and its fall, the vice-chair trap", () => {
  const titled = rows.filter((i) => title(i) !== ""),
    chair = (i) => title(i).includes("chair"),
    vice = (i) => /vice[ -]*chair/.test(title(i)),
    execRows = rows.filter(matched("match_exec"));
  assert.ok(new Set(titled.map(title)).size >= 20);
  // Typed by hand: case and stray spaces vary.
  assert.ok(
    titled.some((i) => column.titleann[i] !== column.titleann[i].trim()),
  );
  assert.ok(
    titled.some((i) => column.titleann[i] === column.titleann[i].toUpperCase()),
  );
  assert.ok(
    titled.some((i) => column.titleann[i] === column.titleann[i].toLowerCase()),
  );
  for (const i of titled) assert.ok(column.titleann[i].length <= 63);
  assert.ok(share(titled, chair) > 0.38 && share(titled, chair) < 0.5);
  assert.ok(share(titled, vice) > 0.004 && share(titled, vice) < 0.02);
  // About 4 percent of matched rows have no title.
  const blank = 1 - titled.length / execRows.length;
  assert.ok(blank > 0.025 && blank < 0.055);
  const early = titled.filter((i) => column.fyear[i] <= 2007),
    late = titled.filter((i) => column.fyear[i] >= 2021);
  assert.ok(share(early, chair) > 0.5);
  assert.ok(share(late, chair) < 0.4);
  // About half of the firms change chair status at least once.
  const seen = new Map();
  for (const i of titled) {
    const s = seen.get(column.firmid[i]) ?? new Set();
    s.add(chair(i));
    seen.set(column.firmid[i], s);
  }
  const changers = share([...seen.values()], (s) => s.size === 2);
  assert.ok(changers > 0.4 && changers < 0.6, `${changers}`);
  // Larger firms are more often chaired by their chief executive.
  const sized = titled.filter((i) => column.at[i] > 0),
    middle = median(sized.map((i) => column.at[i]));
  assert.ok(
    share(
      sized.filter((i) => column.at[i] > middle),
      chair,
    ) >
      share(
        sized.filter((i) => column.at[i] <= middle),
        chair,
      ) +
        0.05,
  );
});

test("industries, auditors and fiscal year-ends", () => {
  const coded = rows.filter((i) => !Number.isNaN(column.sich[i])),
    set = (i) =>
      (column.sich[i] >= 6000 && column.sich[i] <= 6999) ||
      (column.sich[i] >= 4900 && column.sich[i] <= 4999);
  for (const i of coded)
    assert.ok(column.sich[i] >= 1000 && column.sich[i] <= 8999);
  assert.ok(share(rows, set) > 0.15 && share(rows, set) < 0.23);
  // An industry does not change within a firm.
  const industry = new Map();
  for (const i of coded) {
    if (industry.has(column.firmid[i]))
      assert.equal(industry.get(column.firmid[i]), column.sich[i]);
    industry.set(column.firmid[i], column.sich[i]);
  }
  const audited = rows.filter(matched("match_audit")),
    big = (i) =>
      /deloitte|ernst|young|kpmg|pricewaterhouse|pwc/.test(
        column.auditor_name[i].toLowerCase(),
      );
  assert.ok(share(audited, big) > 0.56 && share(audited, big) < 0.7);
  assert.ok(share(both, big) > share(audited, big) + 0.1);
  // About 77 percent of year-ends are in December, all on a month's last day.
  const december = (i) => dateText(column.datadate[i]).slice(2, 5) === "dec";
  assert.ok(share(rows, december) > 0.72 && share(rows, december) < 0.82);
  for (const i of rows)
    assert.match(
      dateText(column.datadate[i]),
      /^(28|29|30|31)[a-z]{3}20[0-2]\d$/,
    );
  // The fee file's year-end disagrees with the date in a few percent of the
  // matched rows, and a few of its values lost their leading zero.
  const months = "jan feb mar apr may jun jul aug sep oct nov dec".split(" "),
    agrees = (i) => {
      const text = dateText(column.datadate[i]),
        mmdd =
          String(months.indexOf(text.slice(2, 5)) + 1).padStart(2, "0") +
          text.slice(0, 2);
      return column.fiscal_ye[i].padStart(4, "0") === mmdd;
    };
  for (const i of audited) assert.match(column.fiscal_ye[i], /^\d{3,4}$/);
  assert.ok(share(both, agrees) > 0.94 && share(both, agrees) < 0.975);
  assert.ok(audited.some((i) => column.fiscal_ye[i].length === 3));
});

test("the ratios have the tails that make capping matter", () => {
  const quantile = (list, p) =>
      [...list].sort((a, b) => a - b)[Math.floor(p * (list.length - 1))],
    ok = both.filter((i) => column.at[i] > 0),
    size = ok.map((i) => Math.log(column.at[i])),
    roa = ok
      .filter((i) => !Number.isNaN(column.ni[i]))
      .map((i) => column.ni[i] / column.at[i]),
    leverage = ok
      .filter((i) => !Number.isNaN(column.dltt[i]))
      .map((i) => column.dltt[i] / column.at[i]),
    cash = ok.filter((i) => !Number.isNaN(column.oancf[i])),
    fees = both.map((i) => column.non_audit_fees[i]);
  assert.ok(Math.abs(quantile(size, 0.5) - 8) < 0.4);
  assert.ok(quantile(roa, 0.5) > 0.02 && quantile(roa, 0.5) < 0.06);
  assert.ok(quantile(roa, 0.01) < -0.3);
  // A few ratios are many times too large.
  assert.ok(Math.max(...roa.map(Math.abs)) > 3);
  assert.ok(Math.max(...leverage) > 2);
  assert.ok(quantile(leverage, 0.05) === 0);
  assert.ok(
    share(cash, (i) => column.oancf[i] > 0) > 0.86 &&
      share(cash, (i) => column.oancf[i] > 0) < 0.94,
  );
  // About 8 percent of matched firm-years bought no non-audit services.
  assert.ok(
    share(fees, (v) => v === 0) > 0.05 && share(fees, (v) => v === 0) < 0.11,
  );
  // A handful of values that cannot be right, for the screens to catch.
  const negativeFees = rows.filter((i) => column.non_audit_fees[i] < 0).length,
    negativeAssets = rows.filter((i) => column.at[i] < 0).length;
  assert.ok(negativeFees >= 3 && negativeFees <= 40);
  assert.ok(negativeAssets >= 2 && negativeAssets <= 20);
});

test("a session reads the .dta bytes with types, date format and labels", () => {
  const session = createConsoleSession(),
    added = session.addData(PANEL_FILE, panelDta(panel));
  assert.equal(added.rows, n);
  const out = session.run(`use "${PANEL_FILE}", clear\nxtset firmid fyear`, {
    doFile: true,
  });
  assert.equal(out.rc, 0);
  assert.equal(out.memory.observations, n);
  assert.deepEqual(
    out.memory.variables.map((v) => [v.name, v.type, v.label]),
    panel.variables.map((v) => [v.name, v.type, v.label]),
  );
  assert.equal(
    out.memory.variables.find((v) => v.name === "datadate").format,
    "%td",
  );
  assert.match(out.output.at(-1).lines.join("\n"), /unbalanced/);
  assert.match(
    out.output.at(-1).lines.join("\n"),
    /2004 to 2023, but with gaps/,
  );
});

test("the CSV carries the same values, read with text identifiers and doubles", () => {
  const csv = panelCsv(panel),
    lines = csv.split("\n");
  assert.equal(lines[0], PANEL_VARIABLES.map((v) => v.name).join(","));
  assert.equal(lines.length, n + 2);
  const session = createConsoleSession();
  session.addFile("panel.csv", csv);
  const strings = panel.variables
      .map((v, k) => (v.string ? k + 1 : 0))
      .filter(Boolean),
    out = session.run(
      `import delimited using "panel.csv", clear varnames(1) case(preserve) asdouble stringcols(${strings.join(" ")})
generate long d = date(datadate, "DMY")
drop datadate
rename d datadate`,
      { doFile: true },
    );
  assert.equal(out.rc, 0);
  const read = Object.fromEntries(
    readDta(session.exportData().bytes).variables.map((v) => [v.name, v.data]),
  );
  for (const v of panel.variables)
    for (const i of rows) {
      const expected = v.string
        ? v.values[i]
        : Number.isNaN(v.values[i])
          ? MISSING
          : v.values[i];
      if (read[v.name][i] !== expected)
        assert.fail(`${v.name}[${i}]: ${read[v.name][i]} for ${expected}`);
    }
});
