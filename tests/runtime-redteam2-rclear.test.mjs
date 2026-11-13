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

// Programs, after the third red-team review: an estimation command run in an
// e-class program keeps the e() it posted, ereturn and sreturn change e()
// and s() at once (so a failure keeps them), return add stages what r()
// holds without replacing what is already staged and leaves r() empty, and
// setting results of the wrong class fails with r(151), r(152) or r(153).
// Expected lines recorded from Stata 19 MP running the same do-file.
test("e() and s() change as ereturn and sreturn run; return add stages r()", () => {
  const session = new Session(),
    { output } = session.run(`clear
input y g z
1 0 3
4 1 3
7 1 5
2 0 8
5 1 1
6 0 2
end
program pe1, eclass
  regress y z
  exit
end
program pe2, eclass
  regress y z
end
program pe3, eclass
  regress y z
  error 198
end
program pe4, eclass
  regress y z
  ereturn scalar extra = 5
  exit
end
program pe5, eclass
  ereturn scalar extra = 5
  display "E5 inside extra=" e(extra) " N=" e(N)
end
program pe6, eclass
  ereturn local note "hi"
  error 198
end
program pe7, eclass
  ereturn clear
  error 198
end
program pe8, eclass
  display "E8 inside"
end
program pn9
  ereturn scalar extra = 5
end
quietly regress y g
quietly pe1
display "E1 N=" e(N) " cmd=" e(cmd) " b=" _b[z] " df=" e(df_m)
quietly regress y g
quietly pe2
display "E2 N=" e(N) " cmd=" e(cmd) " b=" _b[z] " df=" e(df_m)
quietly regress y g
capture quietly pe3
display "E3 rc=" _rc " N=" e(N) " cmd=" e(cmd) " b=" _b[z]
quietly regress y g
capture quietly pe4
display "E4 rc=" _rc " N=" e(N) " extra=" e(extra)
quietly regress y g
pe5
display "E5 N=" e(N) " extra=" e(extra) " cmd=" e(cmd) " b=" _b[g]
quietly regress y g
capture pe6
display "E6 rc=" _rc " N=" e(N) " note=\`e(note)'"
quietly regress y g
capture pe7
capture display _b[g]
display "E7 rc=" _rc " N=" e(N) " cmd=\`e(cmd)'"
quietly regress y g
quietly summarize y
pe8
display "E8 N=" e(N) " cmd=" e(cmd) " rN=" r(N)
quietly regress y g
capture pn9
display "E9 rc=" _rc " N=" e(N) " extra=" e(extra)
program pa1, rclass
  quietly summarize y
  return add
end
program pa2, rclass
  quietly summarize y
  return add
  exit
end
program pa3, rclass
  return scalar N = 99
  quietly summarize y
  return add
end
program pa4, rclass
  quietly summarize y
  return add
  quietly count if y > 3
  return add
end
program pa5, rclass
  quietly summarize y
  return add
  error 198
end
program pa6, rclass
  quietly summarize y
  display "A6 before N=" r(N)
  return scalar a = 1
  display "A6 staged N=" r(N) " a=" r(a)
  return add
  display "A6 added N=" r(N)
end
program pa7
  quietly summarize y
  return add
end
program pa8
  quietly summarize y
  return clear
end
quietly ttest y == 3
pa1
display "A1 N=" r(N) " mean=" r(mean) " p=" r(p)
quietly ttest y == 3
pa2
display "A2 N=" r(N) " mean=" r(mean) " p=" r(p)
pa3
display "A3 N=" r(N) " mean=" r(mean)
pa4
display "A4 N=" r(N) " mean=" r(mean)
capture pa5
display "A5 rc=" _rc " N=" r(N) " mean=" r(mean)
pa6
display "A6 N=" r(N) " a=" r(a)
quietly count if y > 3
capture pa7
display "A7 rc=" _rc " N=" r(N) " mean=" r(mean)
pa8
display "A8 N=" r(N)
quietly count if y > 3
return clear
display "A9 N=" r(N)
program ps1, sclass
  sreturn local a "x"
  display "S1 inside a=\`s(a)'"
end
program ps2, sclass
  display "S2 inside a=\`s(a)'"
end
program ps3, sclass
  sreturn local b "w"
end
program ps4, sclass
  sreturn local a "y"
  error 198
end
program pn5
  sreturn local c "v"
end
sreturn clear
ps1
display "S1 a=\`s(a)'"
ps2
display "S2 a=\`s(a)'"
ps3
display "S3 a=\`s(a)' b=\`s(b)'"
capture ps4
display "S4 rc=" _rc " a=\`s(a)'"
capture pn5
display "S5 rc=" _rc " c=\`s(c)'"
capture return scalar a = 1
display "T1 rc=" _rc
capture ereturn local a "x"
display "T2 rc=" _rc
capture sreturn local a "x"
display "T3 rc=" _rc
`),
    lines = output.flatMap((o) => o.lines).filter((l) => /^[EAST]\d /.test(l));
  assert.deepEqual(lines, [
    "E1 N=6 cmd=regress b=-.27659574 df=1",
    "E2 N=6 cmd=regress b=-.27659574 df=1",
    "E3 rc=198 N=6 cmd=regress b=-.27659574",
    "E4 rc=0 N=6 extra=5",
    "E5 inside extra=5 N=6",
    "E5 N=6 extra=5 cmd=regress b=2.3333333",
    "E6 rc=198 N=6 note=hi",
    "E7 rc=111 N=. cmd=",
    "E8 inside",
    "E8 N=6 cmd=regress rN=6",
    "E9 rc=152 N=6 extra=.",
    "A1 N=6 mean=4.1666667 p=.",
    "A2 N=6 mean=4.1666667 p=.",
    "A3 N=99 mean=4.1666667",
    "A4 N=6 mean=4.1666667",
    "A5 rc=198 N=6 mean=4.1666667",
    "A6 before N=6",
    "A6 staged N=6 a=.",
    "A6 added N=.",
    "A6 N=6 a=1",
    "A7 rc=151 N=6 mean=4.1666667",
    "A8 N=6",
    "A9 N=4",
    "S1 inside a=x",
    "S1 a=x",
    "S2 inside a=x",
    "S2 a=x",
    "S3 a=x b=w",
    "S4 rc=198 a=y",
    "S5 rc=153 c=",
    "T1 rc=151",
    "T2 rc=152",
    "T3 rc=153",
  ]);
});

// A graph clears r() when it draws (kdensity posts its own); egen, regress,
// ivregress, pnorm, tobit, glm and qreg keep r() when they fail at an
// unknown variable or name but not when they fail later; isid leaves the
// r(N) of its count of complete identifiers; ci means with no observations
// posts dots. Expected lines recorded from Stata 19 MP.
test("graphs clear r() when they draw; r() after failures depends on where they fail", () => {
  const session = new Session(),
    { output } = session.run(`clear
input y g z
1 0 3
4 1 3
7 1 5
2 0 8
5 1 1
6 0 2
end
quietly regress y z
local k = 0
foreach c in "scatter y z" "line y z" "line y z if 0" "twoway (scatter y z) (lfit y z)" "histogram y" "graph bar y" "graph box y" "graph hbar y" "lowess y z" "qnorm y" "pnorm y" "rvfplot" "lvr2plot" "graph display" "graph export rclear.png, replace" "kdensity y" "egen 1x = mean(y)" "egen x2 = mean(nonexist)" "regress nonexist z" "regress y i.nonexist" "regress y z if nonexist" "ivregress zzfoo y z" "ivregress 2sls y (z = g), zzfoo" "pnorm nonexist" "pnorm y, zzfoo" "tobit nonexist z, ll(0)" "tobit y z, zzfoo" "glm y z, zzfoo" "qreg y nonexist" "merge 1:1 nonexist using nofile" "tab2 y g if 0" "isid g z, missok" {
  local ++k
  quietly summarize y
  capture \`c'
  display "G\`k' rc=" _rc " N=" r(N) " mean=" r(mean) " n=" r(n)
}
replace g = . in 3
replace z = . in 6
foreach c in "isid g" "isid y z" "isid z, missok" "ci means z y if g == 5" {
  local ++k
  quietly summarize y
  capture noisily \`c'
  display "G\`k' rc=" _rc " N=" r(N) " mean=" r(mean) " lb=" r(lb)
}
`),
    lines = output
      .flatMap((o) => o.lines)
      .filter((l) =>
        /^G\d+ |should never|uniquely|Variable \||^\s+[yz] \|/.test(l),
      );
  assert.deepEqual(lines, [
    "G1 rc=0 N=. mean=. n=.",
    "G2 rc=0 N=. mean=. n=.",
    "G3 rc=0 N=. mean=. n=.",
    "G4 rc=0 N=. mean=. n=.",
    "G5 rc=0 N=. mean=. n=.",
    "G6 rc=0 N=. mean=. n=.",
    "G7 rc=0 N=. mean=. n=.",
    "G8 rc=0 N=. mean=. n=.",
    "G9 rc=0 N=. mean=. n=.",
    "G10 rc=0 N=. mean=. n=.",
    "G11 rc=0 N=. mean=. n=.",
    "G12 rc=0 N=. mean=. n=.",
    "G13 rc=0 N=. mean=. n=.",
    "G14 rc=0 N=. mean=. n=.",
    "G15 rc=0 N=6 mean=4.1666667 n=.",
    "G16 rc=0 N=. mean=. n=6",
    "G17 rc=198 N=6 mean=4.1666667 n=.",
    "G18 rc=111 N=. mean=. n=.",
    "G19 rc=111 N=. mean=. n=.",
    "G20 rc=111 N=. mean=. n=.",
    "G21 rc=111 N=6 mean=4.1666667 n=.",
    "G22 rc=198 N=6 mean=4.1666667 n=.",
    "G23 rc=198 N=. mean=. n=.",
    "G24 rc=111 N=6 mean=4.1666667 n=.",
    "G25 rc=198 N=. mean=. n=.",
    "G26 rc=111 N=6 mean=4.1666667 n=.",
    "G27 rc=198 N=. mean=. n=.",
    "G28 rc=198 N=. mean=. n=.",
    "G29 rc=111 N=6 mean=4.1666667 n=.",
    "G30 rc=111 N=6 mean=4.1666667 n=.",
    "G31 rc=0 N=. mean=. n=.",
    "G32 rc=0 N=6 mean=4.1666667 n=.",
    "variable g should never be missing",
    "G33 rc=459 N=5 mean=. lb=.",
    "variables y and z should never be missing",
    "G34 rc=459 N=5 mean=. lb=.",
    "variable z does not uniquely identify the observations",
    "G35 rc=459 N=6 mean=4.1666667 lb=.",
    "    Variable |        Obs        Mean    Std. err.       [95% conf. interval]",
    "           z |          0           .           .               .           .",
    "           y |          0           .           .               .           .",
    "G36 rc=0 N=0 mean=. lb=.",
  ]);
});
