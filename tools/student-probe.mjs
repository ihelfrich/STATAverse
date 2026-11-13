// Measures how much of what a student might type the Console runs. Each
// line of tools/student-probe.txt is run alone in a fresh Console session,
// after a short setup on the site's wages data, and counted as run when it
// finishes without an error. Running is not agreement with Stata; that is
// what the recorded comparisons in tests/ establish. The list is a
// judgement about what is commonly typed, not a sample of student work.
import fs from "node:fs";
import { createConsoleSession } from "../src/console-session.js";

const lines = fs
  .readFileSync(new URL("./student-probe.txt", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean);
const setup = `sysuse wages, clear
encode sector, generate(sectorn)
generate byte high = wage > 20
tsset id
quietly regress wage education experience
estimates store m1
quietly regress wage education
estimates store m2
quietly regress wage education experience`;
const refused = [];
let run = 0;
for (const line of lines) {
  const session = createConsoleSession();
  if (session.run(setup).rc) throw new Error("the setup did not run");
  let result;
  try {
    result = session.run(line);
  } catch (error) {
    refused.push({ command: line, rc: null, message: String(error) });
    continue;
  }
  if (result.rc === 0) run += 1;
  else
    refused.push({
      command: line,
      rc: result.rc,
      message: (result.output.at(-1)?.lines ?? []).join(" ").slice(0, 120),
    });
}
const receipt = {
  basis:
    "Each line of tools/student-probe.txt run alone in a fresh Console session after a setup on the wages data. Run means no error; it does not mean agreement with Stata. The list is a judgement about what students commonly type.",
  commands: lines.length,
  run,
  refused,
};
if (process.argv.includes("--write"))
  fs.writeFileSync(
    new URL("../docs/verification/student-probe.json", import.meta.url),
    JSON.stringify(receipt, null, 2) + "\n",
  );
console.log(`${run} of ${lines.length} commands run`);
