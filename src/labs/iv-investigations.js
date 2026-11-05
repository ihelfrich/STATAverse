import { IV_DEFAULTS } from "./iv-parameters.js";

const setup = (
  parameters = {},
  view = "stages",
  plot = "first",
  candidate = "1",
) => ({
  parameters: { ...IV_DEFAULTS, ...parameters },
  view,
  plot,
  candidate,
  selected: 1,
  window: 5,
});
const number = (prompt, metric, tolerance = 0.001) => ({
  type: "number",
  prompt,
  metric,
  tolerance,
});
const controlNames = {
  n: "sample size n",
  seed: "random seed",
  beta: "structural coefficient β",
  pi: "first-stage strength π",
  rho: "error correlation ρ",
  delta: "direct effect δ",
  sigma: "error scale σ",
  confidence: "confidence level",
  robust: "covariance method",
};
// Author the correct statement first, then choose its displayed position.
// Feedback follows the statement rather than a fragile displayed index.
const choice = (prompt, statements, position, feedback) => {
  const order = statements.map((_, i) => i).slice(1);
  order.splice(position, 0, 0);
  return {
    type: "choice",
    prompt,
    answer: position,
    options: order.map((i) => statements[i]),
    feedback: order.map((i) => feedback[i]),
  };
};
export const IV_INVESTIGATIONS = [
  {
    id: "iv-stages",
    title: "The two stages of IV estimation",
    level: "Intermediate",
    minutes: 18,
    summary:
      "Follow a predicted value, calculate the IV ratio and distinguish the coefficient from its uncertainty.",
    steps: [
      {
        id: "projected-record",
        title: "An observation's predicted x",
        setup: setup(),
        required: { view: "stages", plot: "first", selected: 42 },
        instruction:
          "Inspect record 42 in the first-stage plot. Its fitted x lies on the regression line; the first-stage residual is the difference between observed x and fitted x. Enter the fitted value to three decimals.",
        hint: "Use the record-number field beside the plot. The inspector reports fitted x separately from x and the first-stage residual.",
        question: number("What is fitted x for record 42?", "projected42"),
        explanation:
          "The first stage uses z to predict x. A record's observed x need not lie on the fitted line; the difference is its first-stage residual.",
      },
      {
        id: "reduced-form-ratio",
        title: "The ratio behind the IV slope",
        setup: setup({}, "stages", "reduced"),
        required: { view: "stages", plot: "reduced" },
        instruction:
          "Read the reduced-form slope from y on z and the first-stage slope from x on z. Divide the former by the latter. Enter the IV ratio to three decimals.",
        hint: "The three values above the plot use the same observations. Divide the reduced-form slope by the first-stage slope. Small differences from rounding are accepted.",
        question: number("What is the IV slope?", "ivSlope"),
        explanation:
          "With one excluded instrument and an intercept, 2SLS equals the reduced-form slope divided by the first-stage slope. This equality does not establish the validity of z.",
      },
      {
        id: "ols-target",
        title: "The OLS and IV targets",
        setup: setup({}, "stages", "structural"),
        required: { view: "stages", plot: "structural" },
        instruction:
          "Compare the two fitted lines and the population limits in the table. The population's structural coefficient is β = 1, but v and u are positively correlated.",
        hint: "The population OLS slope is 1.35. The valid-instrument IV limit is 1. A realized sample estimate need not equal either population quantity.",
        question: choice(
          "Why do OLS and IV have different population targets here?",
          [
            "x contains v, which is correlated with the structural error u.",
            "The two estimates use different observations.",
            "IV always chooses the coefficient closer to the known truth.",
          ],
          1,
          [
            "",
            "Both estimates use every observation in the same sample. The difference comes from the source of variation used to identify the slope.",
            "IV does not know β. Its validity depends on assumptions about the instrument; changing δ can make its limit wrong.",
          ],
        ),
        explanation:
          "OLS uses all variation in x, including v. Here v is correlated with u. IV uses the variation associated with z, which is independent of u and has no direct effect on y in this population.",
      },
      {
        id: "structural-residual",
        title: "The standard error after two stages",
        setup: setup(),
        instruction:
          "Expand the explanation below the coefficient table. Both second-stage procedures return the same slope, but their standard errors differ. Identify the residual required by the correct IV covariance.",
        hint: "Fitted x belongs in the projection used by 2SLS. The error in the structural equation is measured with the observed regressor.",
        question: choice(
          "Which residual belongs in the 2SLS covariance calculation?",
          [
            "y − intercept − b × observed x",
            "y − intercept − b × fitted x",
            "observed x − fitted x",
          ],
          2,
          [
            "",
            "That is the residual from the naive second-stage regression. It measures a different error and gives the wrong 2SLS covariance.",
            "That is the first-stage residual. It helps describe endogeneity, but it is not the structural residual for y.",
          ],
        ),
        explanation:
          "Use y − intercept − b × observed x. The instrument enters the covariance through projected regressors; substituting fitted x into the structural residual changes the uncertainty calculation.",
      },
      {
        id: "orthogonality",
        title: "A fitted moment is not a validity test",
        setup: setup({ delta: 0.8 }, "method"),
        required: { view: "method" },
        instruction:
          "The instrument now has a direct effect on y: δ = 0.8. Read the identification assumptions. There is one instrument for one endogenous regressor, and the fitted IV residual is mechanically orthogonal to z.",
        hint: "In a just-identified model the estimator solves the sample moment condition. There is no additional excluded instrument left to test an overidentifying restriction.",
        question: choice(
          "What does that fitted orthogonality establish?",
          [
            "Only that the estimator solved its sample moment condition.",
            "That exclusion holds in the population.",
            "That the first stage must be strong.",
          ],
          0,
          [
            "",
            "Exclusion is deliberately violated here even though fitted orthogonality holds. The fitted moment cannot validate itself.",
            "The moment condition can be solved with a weak first stage too; numerical solvability and instrument strength are different issues.",
          ],
        ),
        explanation:
          "The zero fitted moment is a property of the exactly identified estimator. It is not independent evidence for exclusion, exogeneity or a strong first stage.",
      },
    ],
  },
  {
    id: "iv-weak",
    title: "Weak instruments and confidence sets",
    level: "Advanced",
    minutes: 20,
    summary:
      "Change instrument strength, test candidate coefficients and interpret bounded, disconnected and uninformative sets.",
    steps: [
      {
        id: "strong-first-stage",
        title: "A reference first stage",
        setup: setup(),
        instruction:
          "Read the first-stage F statistic above the plots. This reference sample uses π = 1. Enter F to three decimals before changing the population.",
        hint: "With one excluded instrument, F is the square of its first-stage t statistic. It describes relevance in this sample; it does not test exclusion.",
        question: number("What is the first-stage F statistic?", "firstF"),
        explanation:
          "This statistic tests the first-stage slope against zero under the selected covariance. A large value supports sample relevance, but cannot establish that z has no direct effect on y.",
      },
      {
        id: "weaken-instrument",
        title: "Less variation from z",
        setup: setup(),
        target: { pi: 0.06 },
        instruction:
          "Reduce first-stage strength π from 1 to 0.06, keeping the same seed and every other setting. The latent observations stay fixed. Read the new first-stage F statistic.",
        hint: "Use the first-stage strength slider. Arrow keys change it by 0.01. The weak-instrument starting example also sets π to 0.06 without changing the seed.",
        question: number("What is F after setting π to 0.06?", "firstF"),
        explanation:
          "The weaker population first stage produces a much smaller F in this sample. The data now provide much less information about the denominator of the IV ratio.",
      },
      {
        id: "whole-line",
        title: "No finite bound from this test",
        setup: setup({ pi: 0.06 }, "uncertainty"),
        required: { view: "uncertainty" },
        instruction:
          "Inspect the Anderson–Rubin confidence set for the weak-instrument sample. It contains all real values, even though the browser can calculate a finite IV point estimate.",
        hint: "A confidence set describes which candidates this test rejects. A finite point estimate alone says nothing about how informative that set will be.",
        question: choice(
          "What is the appropriate interpretation of this set?",
          [
            "This test supplies no finite bound on β from this sample.",
            "The data establish that β is zero.",
            "The browser should truncate the interval to the plot edges.",
          ],
          2,
          [
            "",
            "Zero is one accepted value among all real values. The test has not singled it out.",
            "Plot edges are display choices. They are not statistical confidence limits and cannot replace unbounded endpoints.",
          ],
        ),
        explanation:
          "The test rejects no candidate. The sample IV ratio is computable, but this Anderson–Rubin test provides no finite bound on the coefficient. Another seed can produce a different set shape.",
      },
      {
        id: "rejected-middle",
        title: "A candidate between two accepted regions",
        setup: setup({ pi: 0.06, seed: 8 }, "uncertainty", "first", "1"),
        required: { view: "uncertainty", candidate: "2" },
        instruction:
          "This new sample has a confidence set with two unbounded pieces. Enter candidate b = 2 and read its test result. The plot window does not determine the decision.",
        hint: "The candidate field is below the confidence set. The two finite endpoints are about 1.717 and 3.264, leaving 2 between the accepted pieces.",
        question: choice(
          "What happens to b = 2?",
          [
            "It is rejected and lies outside the confidence set.",
            "It is accepted because it lies between the two endpoints.",
            "It cannot be tested because the set is disconnected.",
          ],
          1,
          [
            "",
            "For two rays, the accepted values are outside the gap between endpoints. The usual single-interval reading would reverse this decision.",
            "The same transformed-outcome test applies to every finite candidate. A disconnected set does not make the test unavailable.",
          ],
        ),
        explanation:
          "The test rejects b = 2. In this sample the confidence set consists of two rays; values between the finite endpoints lie outside it.",
      },
      {
        id: "accepted-tail",
        title: "A large coefficient that remains in the set",
        setup: setup({ pi: 0.06, seed: 8 }, "uncertainty", "first", "2"),
        required: { view: "uncertainty", candidate: "10" },
        instruction:
          "Keep the same sample and test b = 10. It is beyond the default plot window. Read the test result, then widen the plot if you want to see where it lies.",
        hint: "The right accepted ray extends to positive infinity. The candidate calculation still runs when the value lies outside the visible plot.",
        question: choice(
          "How should you interpret the result for b = 10?",
          [
            "It is not rejected; weak identification leaves this large value in the set.",
            "It is the most likely coefficient because the test accepts it.",
            "It is excluded because it is off the plot.",
          ],
          0,
          [
            "",
            "A non-rejection does not rank accepted values by plausibility or identify a most likely coefficient.",
            "The displayed window is separate from the analytic set. The test evaluates the entered candidate even off the plot.",
          ],
        ),
        explanation:
          "b = 10 remains in the confidence set. That does not make it a preferred estimate; it shows how weak identification can leave extreme coefficients unrejected.",
      },
      {
        id: "zero-relevance",
        title: "Population identification and sample arithmetic",
        setup: setup({ pi: 0 }, "stages"),
        required: { view: "stages" },
        instruction:
          "The population first stage is now exactly zero. Compare the finite sample IV ratio with the undefined population IV limit in the coefficient table.",
        hint: "A random sample can have a nonzero covariance between z and x even when their population covariance is zero.",
        question: choice(
          "Why does the finite sample ratio fail to establish identification?",
          [
            "Its denominator can be nonzero by chance even though population relevance is absent.",
            "The sample ratio must be zero whenever π is zero.",
            "A positive sample F automatically supplies population relevance.",
          ],
          2,
          [
            "",
            "π describes the population. It does not force every realized first-stage slope or IV ratio to equal zero.",
            "The observed F is random. It cannot create the population restriction needed to identify β.",
          ],
        ),
        explanation:
          "Numerical solvability in one sample is different from identification in the population. With π = 0, z supplies no population variation in x from which to recover β.",
      },
    ],
  },
  {
    id: "iv-exclusion",
    title: "Exclusion, precision and the wrong target",
    level: "Advanced",
    minutes: 18,
    summary:
      "Hold the first stage fixed while violating exclusion, then examine why a larger sample does not repair the design.",
    steps: [
      {
        id: "same-first-stage",
        title: "Exclusion can fail without changing the first stage",
        setup: setup(),
        target: { delta: 0.8 },
        instruction:
          "Raise the direct effect δ from 0 to 0.8 while retaining π = 1 and the same seed. The first-stage observations do not change. Read the first-stage F statistic again.",
        hint: "δ changes y, not x or z. The same x-on-z regression therefore has the same slope, residuals and F statistic.",
        question: number("What is F after changing only δ to 0.8?", "firstF"),
        explanation:
          "The first-stage F is unchanged because δ does not enter x. A strong first stage is compatible with a direct effect of z on y.",
      },
      {
        id: "wrong-limit",
        title: "The population ratio with a direct effect",
        setup: setup({ delta: 0.8 }, "stages", "structural"),
        required: { view: "stages", plot: "structural" },
        instruction:
          "The structural coefficient remains β = 1. With π = 1 and δ = 0.8, use β + δ/π to calculate the population IV ratio.",
        hint: "Add 1 + 0.8/1. Compare the resulting value with the sample estimate and the known structural coefficient.",
        question: number("What is the population IV limit?", "populationIV"),
        explanation:
          "The population IV ratio is 1.8. The direct effect of z contaminates the reduced form, so dividing by the first stage no longer recovers β = 1.",
      },
      {
        id: "invalid-coverage",
        title: "A precise-looking set under an invalid instrument",
        setup: setup({ delta: 0.8 }, "uncertainty", "first", "0"),
        required: { view: "uncertainty", candidate: "1" },
        instruction:
          "Test candidate b = 1, the known structural coefficient. Exclusion fails in this population. Inspect the test result and the validity notice beneath it.",
        hint: "The set is centered around the contaminated IV target. Weak-instrument-robust inference still requires the instrument to be valid.",
        question: choice(
          "Why can this test reject the known β?",
          [
            "The exclusion restriction required by the test is violated.",
            "Anderson–Rubin inference guarantees coverage for every invalid instrument.",
            "The true structural coefficient automatically changes to the IV estimate.",
          ],
          1,
          [
            "",
            "Weak-instrument robustness addresses relevance, not arbitrary failures of exclusion or exogeneity.",
            "The structural coefficient is fixed at 1 in this experiment. An invalid instrument changes the estimator's target, not the data-generating coefficient.",
          ],
        ),
        explanation:
          "The test rejects the known coefficient because its valid-instrument assumptions fail. Anderson–Rubin inference protects against weak relevance under validity; it cannot repair this exclusion violation.",
      },
      {
        id: "more-data",
        title: "More observations around the wrong limit",
        setup: setup({ delta: 0.8 }, "stages", "structural"),
        target: { n: 2000 },
        required: { view: "stages", plot: "structural" },
        instruction:
          "Increase the sample to 2,000 observations while keeping δ = 0.8 and the other settings fixed. Inspect the IV estimate and the population limit. Enter the population limit, not the realized estimate.",
        hint: "The sample-size control is inside Sample and inference settings. Increasing n changes sampling variation; β + δ/π remains 1.8.",
        question: number(
          "What is the population IV limit with 2,000 observations?",
          "populationIV",
        ),
        explanation:
          "The population IV limit remains 1.8. More observations reduce sampling variation around that limit under this design; they do not remove the direct effect of z.",
      },
      {
        id: "design-evidence",
        title: "What a validity argument needs",
        setup: setup({ delta: 0.8 }, "method"),
        required: { view: "method" },
        instruction:
          "Read the assumptions of the simulated population. In real research β and δ are not supplied by a control panel, and this exactly identified model cannot test its sole excluded instrument's validity.",
        hint: "A validity argument concerns how z could affect y and how z was assigned or generated. The first-stage regression addresses only one part of the problem.",
        question: choice(
          "Which evidence would directly inform an exclusion argument?",
          [
            "Substantive evidence about channels through which z could affect y other than x.",
            "A first-stage F above a fixed threshold, by itself.",
            "A zero sample covariance between z and the fitted IV residual, by itself.",
          ],
          0,
          [
            "",
            "A first-stage threshold concerns relevance under particular conditions. It is not a test that every other path from z to y is absent.",
            "The fitted moment is enforced by the exactly identified estimator and is not an independent validity check.",
          ],
        ),
        explanation:
          "Exclusion requires a defensible account of the possible paths from z to y. Its credibility depends on the research setting and supporting evidence, not on a fitted moment or a strong first stage alone.",
      },
    ],
  },
];
export function ivInvestigationTarget(step) {
  return {
    ...step.setup,
    parameters: { ...step.setup.parameters, ...step.target },
    ...step.required,
  };
}
export function ivInvestigationMetric(step, snapshot) {
  const s = snapshot.sample;
  switch (step.question.metric) {
    case "projected42":
      return s.first.fitted[41];
    case "ivSlope":
      return s.iv?.b;
    case "firstF":
      return s.firstF;
    case "populationIV":
      return s.population.iv;
    default:
      throw new Error("Unknown IV investigation metric.");
  }
}
export function assessIVInvestigation(step, snapshot, answer) {
  if (!snapshot.valid || !snapshot.sample)
    return {
      passed: false,
      kind: "result",
      message: "Correct the experiment inputs before checking this task.",
    };
  const target = ivInvestigationTarget(step);
  const mismatch = Object.keys(IV_DEFAULTS).find(
    (k) => snapshot.parameters[k] !== target.parameters[k],
  );
  if (mismatch)
    return {
      passed: false,
      kind: "settings",
      message: `This task requires ${controlNames[mismatch]} = ${mismatch === "robust" ? (target.parameters.robust ? "HC1" : "conventional") : mismatch === "confidence" ? target.parameters.confidence * 100 + "%" : target.parameters[mismatch]}. Adjust that control, or restore this task's starting settings and follow its instruction.`,
    };
  for (const [key, value] of Object.entries(step.required || {}))
    if (
      key === "candidate"
        ? Number(snapshot[key]) !== Number(value) || snapshot[key] === ""
        : snapshot[key] !== value
    )
      return {
        passed: false,
        kind: "inspection",
        message:
          key === "selected"
            ? `Inspect record ${value} before checking its value.`
            : key === "candidate"
              ? `Enter candidate b = ${value} and inspect its test result.`
              : key === "plot"
                ? `Use the ${value === "first" ? "first-stage" : value === "reduced" ? "reduced-form" : "outcome"} plot for this task.`
                : `Open ${value === "method" ? "Stata & assumptions" : value === "uncertainty" ? "Weak-instrument inference" : "Stages & estimates"} for this task.`,
      };
  if (answer === undefined || String(answer).trim() === "")
    return {
      passed: false,
      kind: "answer",
      message: "Enter an answer before checking.",
    };
  const q = step.question,
    n = Number(answer);
  const passed =
    q.type === "number"
      ? Number.isFinite(n) &&
        Math.abs(n - ivInvestigationMetric(step, snapshot)) <= q.tolerance
      : Number.isInteger(n) && n === q.answer;
  if (!passed)
    return {
      passed: false,
      kind: "answer",
      message:
        q.type === "choice"
          ? q.feedback?.[n] || "Choose one of the stated interpretations."
          : "Recheck the requested quantity in the current result. Use at least three decimal places for a computed value.",
    };
  if (step.required?.candidate && snapshot.sample.ar.kind === "unavailable")
    return {
      passed: false,
      kind: "result",
      message: "The candidate test is unavailable for this sample.",
    };
  return { passed: true, kind: "passed", message: step.explanation };
}
