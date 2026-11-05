export const step = (
  title,
  explanation,
  task,
  command,
  question,
  answers,
  correct,
  feedback,
  options = {},
) => ({
  title,
  explanation,
  task,
  command,
  question,
  answers,
  correct,
  feedback,
  ...options,
});

const numberGuidance = (path = []) => {
  if (path[0] === "stats")
    return path.at(-1) === "n"
      ? "Read Obs. in the requested summary row. Rows with that variable missing do not contribute, even if they remain in memory."
      : "Read the Mean column in the requested summary row. Obs. counts values, and Std. dev. describes their spread.";
  if (path[0] === "model")
    return path[1] === "n"
      ? "Read Observations in this regression’s output. Rows with a missing outcome or predictor remain in memory but do not enter estimation."
      : "Read the requested variable’s Coefficient entry. The standard error, t statistic and confidence limits describe different quantities.";
  if (path[0] === "rows")
    return "Read the requested variable in the displayed row. An observation’s position and its ID can differ after sorting.";
  if (path[0] === "value")
    return "Read the number produced by display. Recheck the parentheses and the requested units before rounding.";
  return "Read the count produced by the requested condition. The dataset’s total row count includes observations outside that condition.";
};
export const numeric = (spec) => ({
  ...spec,
  response: {
    kind: "number",
    tolerance: 0,
    decimals: 0,
    guidance: numberGuidance(spec.response.resultPath),
    ...spec.response,
  },
});

/** Strict decimal input: blank, expressions, Infinity and partial numbers are not answers. */
export function assessAnswer(step, input) {
  if (step.response?.kind !== "number") {
    if (input === null || input === undefined)
      return { passed: false, message: "Choose an answer first." };
    const passed = input === step.correct;
    return {
      passed,
      message: passed
        ? step.feedback
        : step.answerFeedback?.[input] || step.feedback,
    };
  }
  const response = step.response;
  const text = String(input ?? "").trim();
  if (
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ||
    !Number.isFinite(Number(text))
  )
    return {
      passed: false,
      message: "Enter a number from your result, without units or a formula.",
    };
  const value = Number(text);
  const passed =
    Math.abs(value - response.expected) <=
    response.tolerance + Number.EPSILON * Math.max(1, Math.abs(value));
  const misconception = response.mistakes?.find(
    (m) => Math.abs(value - m.value) <= (m.tolerance ?? response.tolerance),
  );
  return {
    passed,
    message: passed
      ? step.feedback
      : misconception?.message ||
        response.guidance ||
        "Check the requested row, column and sample in Results. Enter the value with the precision shown above.",
  };
}
