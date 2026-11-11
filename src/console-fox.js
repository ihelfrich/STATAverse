// Ols, the fox who sits on the Results window. He watches the pointer,
// reacts to a run, explains a return code when a command fails, and gives a
// tip when selected. He is decoration with one useful job, and can be hidden.

const TIPS = [
  "Press Up at the command line to get your last command back.",
  "help regress works here. So does help for most commands in the list below.",
  "by group: needs sorted data. bysort group: sorts first, then does the work.",
  "Put quietly in front of a command to run it without printing anything.",
  "A missing value counts as larger than any number, so x > 50 is true for missing x. Add & x < .",
  "After a model, _b[x] is the coefficient on x and _se[x] its standard error.",
  "i.group makes indicators for each level of group. c.x##c.x adds x and its square.",
  "preserve keeps a copy of the data; restore brings it back. Useful before collapse.",
  "Select lines in the do-file and press Ctrl or ⌘ + Shift + Enter to run only those.",
  "In the map, two steps that follow the same step are branches of one analysis.",
  "return list shows what the last command left behind. ereturn list does it for a model.",
  "Variable names are case-sensitive: Wage and wage are different variables.",
  "sysuse dir lists the datasets on this site.",
  "A local macro lives only while the do-file runs. Refer to it as `name'.",
  "margins after a model gives predictions; marginsplot draws them.",
  "set seed before anything random, so the same numbers come back next time.",
];
// What a return code usually means, in a sentence a beginner can act on.
const HINTS = {
  100: "A list of variables was needed and none was given.",
  101: "That command does not take factor or time-series notation here. Make the variable with generate first.",
  102: "Too few variables were given for that command.",
  103: "Too many variables were given for that command.",
  109: "A string was used where a number was needed, or the other way round.",
  110: "That name is already taken. Use replace to change a variable, or drop it first.",
  111: "No variable has that name. Check the spelling and the capitals against the Variables list.",
  119: "That statistic belongs after a different kind of model.",
  132: "A bracket or a quote is opened and never closed.",
  133: "That function does not exist here. Check its spelling.",
  198: "Stata could not read that line. Look for a missing comma, a stray bracket or a misspelt option.",
  199: "That is not a command here. Look it up in the list under What runs here.",
  301: "That needs a model first. Run regress, logit or another estimator, then try again.",
  321: "That needs a model first. Run an estimator, then try again.",
  459: "The data are not arranged as that command requires.",
  601: "No file or dataset has that name. sysuse dir lists the datasets.",
  2000: "No observations were left to use. An if condition or missing values may have removed them all.",
  2001: "There are too few observations to estimate that.",
  4: "The data in memory would be lost. Add the clear option if that is what you want.",
  9: "An assert was false: the data are not what the do-file expected.",
  5: "The data are not sorted as needed. Use sort, or bysort in place of by.",
};

const ART = `<svg viewBox="0 0 84 76" width="84" height="76" aria-hidden="true" focusable="false">
<g class="fox-tail"><path d="M58 60c14 3 22-6 20-19-1-7-6-10-9-8 4 6 2 14-6 15-5 1-8 4-8 8z" fill="#e2702a"/><path d="M78 41c-1-7-6-10-9-8 3 4 3 9 0 12 4 1 8-1 9-4z" fill="#fff3e2"/></g>
<ellipse cx="40" cy="60" rx="19" ry="14" fill="#e2702a"/>
<ellipse cx="40" cy="64" rx="10" ry="9" fill="#fff3e2"/>
<g class="fox-head">
<g class="fox-ear fox-ear-left"><path d="M19 27 16 5l19 12z" fill="#e2702a"/><path d="M21 22 20 11l9 7z" fill="#7a3412"/></g>
<g class="fox-ear fox-ear-right"><path d="M61 27 64 5 45 17z" fill="#e2702a"/><path d="M59 22 60 11l-9 7z" fill="#7a3412"/></g>
<path d="M40 14c14 0 24 9 24 20 0 8-12 18-24 18S16 42 16 34c0-11 10-20 24-20z" fill="#e2702a"/>
<path d="M16 34c0 8 12 18 24 18s24-10 24-18c-5 4-11 3-15-1-3 5-6 9-9 9s-6-4-9-9c-4 4-10 5-15 1z" fill="#fff3e2"/>
<g class="fox-eyes"><g class="fox-open"><circle cx="30" cy="31" r="3.4" fill="#2b1a10"/><circle cx="50" cy="31" r="3.4" fill="#2b1a10"/><g class="fox-glint"><circle cx="31.2" cy="29.8" r="1.1" fill="#fff"/><circle cx="51.2" cy="29.8" r="1.1" fill="#fff"/></g></g>
<g class="fox-shut" fill="none" stroke="#2b1a10" stroke-width="1.8" stroke-linecap="round"><path d="M27 32q3-3 6 0"/><path d="M47 32q3-3 6 0"/></g>
<g class="fox-low" fill="none" stroke="#2b1a10" stroke-width="1.8" stroke-linecap="round"><path d="M27 30q3 3 6 0"/><path d="M47 30q3 3 6 0"/></g></g>
<path d="M36.5 41h7l-3.5 4z" fill="#2b1a10"/>
<path class="fox-smile" d="M35 46q5 4 10 0" fill="none" stroke="#2b1a10" stroke-width="1.5" stroke-linecap="round"/>
<path class="fox-frown" d="M36 48q4-3 8 0" fill="none" stroke="#2b1a10" stroke-width="1.5" stroke-linecap="round"/>
</g>
<g class="fox-paws" fill="#7a3412"><ellipse cx="32" cy="72" rx="5" ry="3"/><ellipse cx="48" cy="72" rx="5" ry="3"/></g>
</svg>`;

export function createFox({ host, says, still }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "fox";
  button.setAttribute("aria-label", "Ols the fox: ask for a tip");
  // The drawing is fixed text in this file, not anything a visitor typed.
  button.innerHTML = ART;
  host.append(button);
  let next = Math.floor(Math.random() * TIPS.length),
    quiet = null,
    settle = null;
  function say(text) {
    clearTimeout(quiet);
    says.textContent = text;
    quiet = setTimeout(() => {
      says.textContent = "";
    }, 14000);
  }
  function mood(state, lasting) {
    clearTimeout(settle);
    button.dataset.mood = state;
    if (!lasting)
      settle = setTimeout(() => {
        button.dataset.mood = "idle";
      }, 1600);
  }
  button.addEventListener("click", () => {
    mood("pet");
    say(TIPS[next]);
    next = (next + 1) % TIPS.length;
  });
  // His eyes follow the pointer, a little.
  const eyes = button.querySelector(".fox-open");
  document.addEventListener(
    "pointermove",
    (event) => {
      if (still.matches || host.hidden) return;
      const box = button.getBoundingClientRect(),
        dx = event.clientX - (box.left + box.width / 2),
        dy = event.clientY - (box.top + box.height * 0.4),
        far = Math.hypot(dx, dy) || 1,
        reach = Math.min(1.8, far / 60);
      eyes.style.transform = `translate(${((dx / far) * reach).toFixed(2)}px, ${((dy / far) * reach).toFixed(2)}px)`;
    },
    { passive: true },
  );
  mood("idle", true);
  return {
    running: () => mood("running", true),
    done: () => mood("done"),
    idle: () => mood("idle", true),
    /** A failed command: he looks worried and says what the code means. */
    failed(rc) {
      mood("error", true);
      say(
        HINTS[rc]
          ? `r(${rc}): ${HINTS[rc]}`
          : `That stopped with return code ${rc}. The message above it says why.`,
      );
    },
    say,
  };
}
