// What r() holds after a command fails, after the second red-team review of
// 13 November 2026. Stata clears r() when ttest, ttesti and most other
// ado-file commands fail, keeps it when a built-in command such as summarize
// or generate fails, and lets an r-class program post what it returned before
// it failed or exited. Every expected value below was recorded from Stata 19
// MP (version 17, set processors 1) running the same commands; the printed
// return list of the failing commands is also compared in
// tests/runtime-output.test.mjs (case failed-commands-and-r).
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";

const DATA = `clear
input y g z
1 0 3
4 1 3
7 1 5
2 0 8
5 1 1
end
`;

// Each line the source displays, with the rc of the whole run.
function shown(source) {
  const session = new Session(),
    { output, rc } = session.run(DATA + source);
  return {
    session,
    rc,
    lines: output.flatMap((o) => o.lines).filter((l) => /^[A-Z]\d* /.test(l)),
  };
}

test("a failed ttest or ttesti leaves r() empty", () => {
  const { lines, rc } = shown(`ttest y == z
capture ttest y == .
display "A " _rc " " r(p) " " r(N_1)
ttest y == 2
capture ttest y if 0, by(g)
display "B " _rc " " r(p) " " r(N_1)
ttesti 1 5 0 1 7 0
capture ttesti 1 5 2 3
display "C " _rc " " r(p) " " r(mu_1)
ttesti 3 5 2 3
capture ttesti 10 5 2 12 6 1, level(100)
display "D " _rc " " r(p) " " r(N_1)
quietly summarize y
capture quietly ttest y == .
display "E " _rc " " r(N)
`);
  assert.equal(rc, 0);
  assert.deepEqual(lines, [
    "A 198 . .",
    "B 2000 . .",
    "C 499 . .",
    "D 198 . .",
    "E 198 .",
  ]);
});

test("built-in commands keep r() when they fail; ado-file commands clear it", () => {
  const { lines } = shown(`quietly summarize y
capture summarize nosuch
display "S " _rc " " r(N) " " r(mean)
capture generate y = 1
display "G " _rc " " r(N) " " r(mean)
capture correlate y nosuch
display "K " _rc " " r(N) " " r(mean)
capture correlate y z if 0
display "C " _rc " " r(N) " " r(mean)
quietly summarize y
capture tabulate nosuch
display "T " _rc " " r(N) " " r(mean)
quietly summarize y
capture regress y z if 0
display "R " _rc " " r(N) " " r(mean)
quietly summarize y
capture logit g z, zzfoo
display "L " _rc " " r(N) " " r(mean)
capture logit g z if 0
display "M " _rc " " r(N) " " r(mean)
quietly summarize y
capture anova y g, zzfoo
display "N " _rc " " r(N) " " r(mean)
capture anova nosuch g
display "O " _rc " " r(N) " " r(mean)
`);
  assert.deepEqual(lines, [
    "S 111 5 3.8",
    "G 110 5 3.8",
    "K 111 5 3.8",
    "C 2000 0 .",
    "T 111 . .",
    "R 2000 . .",
    "L 198 5 3.8",
    "M 2000 . .",
    "N 198 5 3.8",
    "O 111 . .",
  ]);
});

test("an r-class program posts its returns when it exits or fails", () => {
  const { lines } = shown(`program define pexit, rclass
  return scalar a = 1
  exit
end
program define pexit0, rclass
  return scalar a = 2
  exit 0
end
program define pfailcmd, rclass
  return scalar a = 3
  summarize nosuch
end
program define pfail, rclass
  return scalar a = 4
  error 198
end
program define pfail0, rclass
  error 459
end
program define pnr
  error 198
end
program define pinner
  ttest y == .
end
program define preader
  capture ttest y == .
  display "I " _rc " " r(N) " " r(p)
end
quietly summarize y
pexit
display "H1 " r(a) " " r(N)
quietly summarize y
pexit0
display "H2 " r(a) " " r(N)
quietly summarize y
capture pfailcmd
display "H3 " _rc " " r(a) " " r(N)
quietly summarize y
capture pfail
display "F1 " _rc " " r(a) " " r(N)
quietly summarize y
capture pfail0
display "F2 " _rc " " r(a) " " r(N)
quietly summarize y
capture pnr
display "F4 " _rc " " r(N)
quietly summarize y
capture pinner
display "H6 " _rc " " r(N)
quietly summarize y
preader
display "H7 " r(N)
`);
  assert.deepEqual(lines, [
    "H1 1 .",
    "H2 2 .",
    "H3 111 3 .",
    "F1 198 4 .",
    "F2 459 . .",
    "F4 198 5",
    "H6 198 .",
    "I 198 . .",
    "H7 .",
  ]);
});
