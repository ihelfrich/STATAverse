// Records what installed Stata makes of the project lab's worked analysis.
//
// The simulated panel is written twice into a temporary folder: as the CSV
// the lab offers for download and as the .dta bytes the lab loads. Stata
// imports the CSV, checks with cf that it holds exactly what the .dta holds,
// then runs the analysis do-file and a second do-file that prints every
// reported number in %21x. The printed text and the numbers go to
// tests/fixtures/panel-project/native.json; tests/panel-project-native.test.mjs
// holds the Console runtime to them. Logs stay in the temporary folder and
// are deleted.
//
//   node tools/check-project-native.mjs          record
//   node tools/check-project-native.mjs --keep   record and keep the folder
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { format } from "prettier";
import {
  PANEL_SEED,
  buildPanel,
  panelCsv,
  panelFingerprint,
} from "../src/panel-project/panel-data.js";
import { panelDta } from "../src/panel-project/panel-dta.js";
import { canonicalDoFile } from "../src/panel-project/analysis.js";
import { receiptPath } from "./receipts.mjs";

const STATA = "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp";

// Every number the analysis reports, printed exactly. Run after the analysis
// in the same session, in Stata and in the runtime alike.
export const VALUES_DO = `foreach m in baseline firm_fe all_fees date_screen uncapped buys amount {
    quietly estimates restore \`m'
    display "@ \`m' N " %21x e(N)
    display "@ \`m' N_clust " %21x e(N_clust)
    local names : colnames e(b)
    foreach n of local names {
        display "@ \`m' b \`n' " %21x _b[\`n'] " " %21x _se[\`n']
    }
}
foreach m in baseline firm_fe date_screen uncapped {
    quietly estimates restore \`m'
    display "@ \`m' r2 " %21x e(r2)
    display "@ \`m' rmse " %21x e(rmse)
    display "@ \`m' F " %21x e(F)
    display "@ \`m' df_r " %21x e(df_r)
}
foreach m in all_fees buys amount {
    quietly estimates restore \`m'
    display "@ \`m' ll " %21x e(ll)
    display "@ \`m' chi2 " %21x e(chi2)
}
quietly estimates restore baseline
quietly test turnover positive_cfo
display "@ test F " %21x r(F)
display "@ test p " %21x r(p)
display "@ test df " %21x r(df)
display "@ test df_r " %21x r(df_r)
quietly estimates restore buys
quietly margins, dydx(dual_proxy turnover positive_cfo)
matrix T = r(table)
forvalues j = 1/3 {
    display "@ margins \`j' " %21x T[1,\`j'] " " %21x T[2,\`j']
}
display "@ margins N " %21x r(N)
foreach v in turnover lev roa {
    quietly _pctile \`v'_raw if baseline_sample, p(1 99)
    display "@ pctile \`v' " %21x r(r1) " " %21x r(r2)
}
quietly count
display "@ count window " %21x r(N)
quietly count if match_exec == 3 & match_audit == 3
display "@ count matched " %21x r(N)
quietly count if match_exec == 3 & match_audit == 3 & fin_util == 0
display "@ count nonfinancial " %21x r(N)
quietly count if eligible
display "@ count eligible " %21x r(N)
quietly count if eligible & nas == 0
display "@ count zero " %21x r(N)
quietly count if baseline_sample
display "@ count baseline " %21x r(N)
foreach v in lnnas dual_proxy turnover positive_cfo size lev roa loss big4 nas_m {
    quietly summarize \`v' if baseline_sample
    display "@ mean \`v' " %21x r(mean) " " %21x r(sd)
}
`;

/** A text log as commands, each with the lines it printed. */
export function logCommands(text, file) {
  const commands = [];
  let current = null,
    started = false;
  for (const line of text.split("\n")) {
    if (line.startsWith(`. capture noisily do "${file}"`)) {
      started = true;
      continue;
    }
    if (!started) continue;
    if (/^end of do-file$/.test(line)) break;
    if (/^\. /.test(line)) {
      current = { command: line.slice(2).trim(), lines: [] };
      if (current.command) commands.push(current);
    } else if (/^> /.test(line) && current && !current.lines.length)
      current.command += line.slice(2);
    else if (current) current.lines.push(line.replace(/\s+$/, ""));
  }
  for (const command of commands) {
    while (command.lines.length && !command.lines[0]) command.lines.shift();
    while (command.lines.length && !command.lines.at(-1)) command.lines.pop();
  }
  return commands;
}

/** The "@ name value value" lines of the values do-file, as name -> hex. */
export function valueLines(lines) {
  const values = {};
  for (const line of lines) {
    if (!line.startsWith("@ ")) continue;
    const parts = line.slice(2).trim().split(/\s+/),
      numbers = [];
    while (
      parts.length &&
      /^[+-][01]\.[0-9a-f]{13}X|^\.[a-z]?$/.test(parts.at(-1))
    )
      numbers.unshift(parts.pop());
    values[parts.join(" ")] = numbers;
  }
  return values;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const keep = process.argv.includes("--keep"),
    folder = await fs.mkdtemp(
      path.join(os.tmpdir(), "stataverse-project-native-"),
    ),
    panel = buildPanel(),
    csv = panelCsv(panel),
    analysis = canonicalDoFile(),
    strings = panel.variables
      .map((v, k) => (v.string ? k + 1 : 0))
      .filter(Boolean);
  await fs.writeFile(path.join(folder, "panel.csv"), csv);
  await fs.writeFile(path.join(folder, "panel.dta"), panelDta(panel));
  await fs.writeFile(path.join(folder, "analysis.do"), analysis);
  await fs.writeFile(path.join(folder, "values.do"), VALUES_DO);
  await fs.writeFile(
    path.join(folder, "audit.do"),
    [
      // Sorting on many cores fails on this machine's Stata.
      "capture set processors 4",
      "version 17",
      "set more off",
      "set linesize 200",
      'log using "route.log", text replace nomsg',
      // The CSV, read as a student would read it: identifiers and the
      // MMDD year-end as text, and the date turned back into a date.
      `import delimited using "panel.csv", clear varnames(1) case(preserve) encoding("utf-8") asdouble stringcols(${strings.join(" ")})`,
      'generate long d = date(datadate, "DMY")',
      "drop datadate",
      "rename d datadate",
      "count",
      'capture noisily cf _all using "panel.dta", all',
      'display "@ cf " %21x _rc',
      "log close",
      'log using "analysis.log", text replace nomsg',
      'capture noisily do "analysis.do"',
      'display "@ rc " %21x _rc',
      "log close",
      'log using "values.log", text replace nomsg',
      'capture noisily do "values.do"',
      "log close",
      "exit, clear",
      "",
    ].join("\n"),
  );
  await promisify(execFile)(STATA, ["-b", "do", "audit.do"], {
    cwd: folder,
    timeout: 600000,
  });
  const read = (name) => fs.readFile(path.join(folder, name), "utf8"),
    route = await read("route.log"),
    analysisLog = await read("analysis.log"),
    commands = logCommands(analysisLog, "analysis.do"),
    values = valueLines((await read("values.log")).split("\n")),
    failures = [];
  if (!/^@ cf \+0\.0000000000000X-3ff$/m.test(route))
    failures.push(
      `the CSV and the .dta differ in Stata:\n${route.split("\n").slice(-30).join("\n")}`,
    );
  if (/^r\(\d+\);$/m.test(analysisLog))
    failures.push(
      `the analysis stopped:\n${analysisLog.split("\n").slice(-20).join("\n")}`,
    );
  if (Object.keys(values).length < 400)
    failures.push(`only ${Object.keys(values).length} values were printed`);
  if (failures.length) {
    console.error(failures.join("\n\n"));
    console.error(`Logs are in ${folder}`);
    process.exit(1);
  }
  const mismatches = route
    .split("\n")
    .filter((line) => /mismatch|does not exist/.test(line));
  await fs.mkdir("tests/fixtures/panel-project", { recursive: true });
  await fs.writeFile(
    "tests/fixtures/panel-project/native.json",
    await format(
      JSON.stringify({
        source:
          "Recorded from installed Stata's text log by tools/check-project-native.mjs under version 17, with linesize 200. Stata read the panel from the .dta bytes the lab loads, after checking with cf that the CSV export holds the same values. Leading and trailing blank lines of each command's output are removed. Numbers under values were printed with %21x.",
        seed: PANEL_SEED,
        observations: panel.observations,
        fingerprint: panelFingerprint(panel),
        csvSha256: createHash("sha256").update(csv).digest("hex"),
        analysisSource: analysis,
        commands,
        valuesSource: VALUES_DO,
        values,
      }),
      { parser: "json" },
    ),
  );
  await fs.writeFile(
    receiptPath("project-native.json"),
    await format(
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        source: "src/panel-project/analysis.js",
        sourceSha256: createHash("sha256").update(analysis).digest("hex"),
        panel: {
          seed: PANEL_SEED,
          observations: panel.observations,
          csvSha256: createHash("sha256").update(csv).digest("hex"),
        },
        returnCode: "0",
        checks: [
          "Stata reads the lab's .dta bytes, and cf finds the CSV export equal to them in every variable",
          `the analysis do-file runs to the end (${commands.length} commands recorded)`,
          `${Object.keys(values).length} reported numbers recorded in %21x: coefficients and standard errors of seven fits, sample counts, the joint test, marginal effects and percentile cut-offs`,
        ],
        limits: [
          "One simulated panel from one seed. The numbers describe that panel and nothing outside it.",
          "The comparison of cf is of values; the CSV route stores some variables in other storage types than the .dta.",
          "Raw license-bearing logs remain outside the repository.",
        ],
        csvRouteMismatches: mismatches,
      }),
      { parser: "json" },
    ),
  );
  console.log(
    `Recorded ${commands.length} commands and ${Object.keys(values).length} values from installed Stata.`,
  );
  if (keep) console.log(`Logs are in ${folder}`);
  else await fs.rm(folder, { recursive: true, force: true });
}
