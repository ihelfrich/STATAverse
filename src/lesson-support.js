// Per-step help keeps the original lesson IDs and positions stable for saved work.
const help = {
  "first-commands": [
    [
      "Begin with the dataset’s structure, before calculating anything.",
      "describe takes no arguments when you want every variable.",
    ],
    [
      "Choose the three columns, then specify a range of observation positions.",
      "Use list followed by id hours score, then in 1/5.",
    ],
    [
      "A summary reports each variable’s observed count separately.",
      "Use summarize followed by hours and score. Compare the Obs column with the data browser’s total.",
    ],
    [
      "This is a frequency table of one categorical variable.",
      "Use tabulate followed by group. No comparison expression or quotes are needed in the variable list.",
    ],
  ],
  "missing-values": [
    [
      "Restrict this calculation with if; there is no need to remove rows.",
      'Use == to compare group to the string "A", in double quotes.',
    ],
    [
      "For this step, run the stated condition exactly so you can inspect its missing-value behavior.",
      "Use count if hours > 5. Look for the selected row whose hours value is a dot.",
    ],
    [
      "Both a value above 5 and an observed value are required.",
      "Join hours > 5 and !missing(hours) with &. The condition hours < . also excludes numeric missing.",
    ],
    [
      "A row is complete only if none of the three required variables is missing.",
      "missing(hours, attendance, score) is true when any argument is missing. Put ! before it.",
    ],
  ],
  transformations: [
    [
      "Create a new variable so the original hours remain available.",
      "Multiply hours by 60 on the right side of generate double minutes = ... .",
    ],
    [
      "Ask for both variables in a single summary table.",
      "Use summarize hours minutes and compare their means, standard deviations and observed counts.",
    ],
    [
      "A logical comparison creates 0 or 1. Exclude unknown hours from that comparison.",
      "Use hours >= 6 as the expression, with if !missing(hours) after it.",
    ],
    [
      "A usual frequency table omits missing values from its categories.",
      "Add , missing after tabulate high_study to include the dot category.",
    ],
  ],
  graphs: [
    [
      "A histogram uses one numeric variable; a scatterplot needs two.",
      "Use histogram score, frequency. The option sets the vertical scale to counts.",
    ],
    [
      "Stata lists the vertical variable before the horizontal variable.",
      "Use scatter score hours. Then select a plotted observation to inspect it.",
    ],
    [
      "Use the two variables in the same complete-case calculation.",
      "correlate score hours summarizes their linear association; it does not adjust for other predictors.",
    ],
  ],
  regression: [
    [
      "Place the dependent variable first and the predictor second.",
      "Use regress score hours. The intercept is included automatically.",
    ],
    [
      "Use the model you just estimated; do not generate a hand-written equation.",
      "predict double fitted creates a new column from the last regression.",
    ],
    [
      "A residual needs both an observed score and a fitted score.",
      "Add the residuals option after a comma: predict double residual, residuals.",
    ],
    [
      "The residual belongs on the vertical axis; the fitted value belongs on the horizontal axis.",
      "Use scatter residual fitted. The order is different from plotting fitted against residual.",
    ],
  ],
  inference: [
    [
      "Add the second predictor to the existing variable list.",
      "Use regress score hours attendance. Check Number of obs as well as the coefficient rows.",
    ],
    [
      "Keep the variables and sample the same; change the covariance option.",
      "Add , vce(robust) to the regression command.",
    ],
    [
      "The smaller model does not need attendance as a predictor, but it needs attendance to be observed for this comparison.",
      "Use regress score hours if !missing(attendance). The regression also requires observed score and hours.",
    ],
  ],
  "data-quality": [
    [
      "Inspect types, distinct values, missing counts and ranges.",
      "Use codebook age wait. Look for values outside a plausible recording range.",
    ],
    [
      "Report repetition before deciding whether any record should be removed.",
      "Use duplicates report id. This command does not delete rows.",
    ],
    [
      "State the range as a condition and apply it only to observed ages.",
      "Use assert inrange(age, 0, 120) if !missing(age). An error is the expected evidence in this step.",
    ],
    [
      "Use list to inspect the record responsible for the failed check.",
      "Select age > 120 and !missing(age), and display id age clinic.",
    ],
  ],
  "independent-analysis": [
    [
      "Inspect the outcome and the two proposed predictors before fitting a model.",
      "Use summarize wage education experience. The data description states the units.",
    ],
    [
      "Put the outcome vertically and the proposed predictor horizontally.",
      "Use scatter wage education. The graph does not condition on experience.",
    ],
    [
      "Include both covariates, then specify the covariance option.",
      "Use regress wage education experience, vce(robust). Read the education coefficient in dollars per hour of pay per year of education.",
    ],
    [
      "Check the unit of observation before handing off the data and script.",
      "Use isid id. Then Export work can package the original data, command history and editor draft.",
    ],
  ],
};

const feedback = {
  "first-commands": [
    [
      null,
      "A variable is a column. Look across one row to see the measurements belonging to one student.",
      "The whole dataset represents the constructed class; one observation is one row.",
    ],
    [
      "ID values happen to agree with the starting positions here, but in refers to positions and can select different IDs after a sort.",
      null,
      "The range follows in, so it refers to observation positions rather than score values.",
    ],
    [
      "The data browser still has 24 rows. The summary’s count refers to observed values of a particular variable.",
      "Summarize handles each variable separately, so different rows may be omitted from different summaries.",
      null,
    ],
    [
      null,
      "Equal group sizes do not imply equal means. This table does not summarize score.",
      "Both groups contain 12 rows. The percentages describe sample shares, not percentages of scores.",
    ],
  ],
  "missing-values": [
    [
      "count does not remove data. The if qualifier changes only which rows contribute to this calculation.",
      null,
      "The same non-destructive behavior applies to numeric and string conditions.",
    ],
    [
      "Numeric missing is ordered above finite values in Stata, so this comparison is true for a missing hours value.",
      null,
      "The ordering rule applies even when many other rows have observed hours.",
    ],
    [
      "12 includes the missing-hours row. The explicit missing-value check leaves 11 observed values above 5.",
      null,
      "23 is the number with observed hours, including values of 5 and below.",
    ],
    [
      "24 is the full dataset size. Three rows are missing one required variable.",
      "23 is each variable’s separate observed count; the missing rows differ across variables.",
      null,
    ],
  ],
  transformations: [
    [
      null,
      "Missing multiplied by 60 remains missing; it does not become zero.",
      "generate creates a column. It does not remove observations.",
    ],
    [
      "Multiplying the values by 60 also multiplies their mean by 60.",
      null,
      "Changing units does not change the number of observed values.",
    ],
    [
      null,
      "The qualifier excludes missing inputs, not observed zeros.",
      "The comparison defines a category; it does not convert the units.",
    ],
    [
      "Without the missing option, that would omit the missing category. This task explicitly includes it.",
      null,
      "A frequency table does not change the rows in memory.",
    ],
  ],
  graphs: [
    [
      "The horizontal axis gives score intervals. A frequency histogram’s bar height is a count, not a mean.",
      null,
      "A frequency count is a description of this sample, not a probability density.",
    ],
    [
      null,
      "The first variable, score, is vertical. The second, hours, is horizontal.",
      "Both requested variables appear: score vertically and hours horizontally.",
    ],
    [
      "The observed association does not identify the effect of assigning study hours.",
      null,
      "Correlation uses the two listed variables and does not establish that relevant covariates are absent.",
    ],
  ],
  regression: [
    [
      null,
      "A fitted sample association does not guarantee an individual response or identify an intervention effect.",
      "The slope is a difference per hour, not the outcome mean.",
    ],
    [
      "Prediction needs the predictors and fitted coefficients. The observed outcome is needed for a residual, not for a fitted value.",
      null,
      "Replacing the outcome is unnecessary and would alter the data.",
    ],
    [
      "That would give a positive residual. A negative residual means observed is below fitted.",
      null,
      "Residual units are score points, not hours.",
    ],
    [
      null,
      "A residual pattern cannot establish that all relevant confounders were measured and controlled.",
      "Random assignment concerns the data-generating design; the residual plot cannot verify it.",
    ],
  ],
  inference: [
    [
      null,
      "The extra missing attendance value removes one row in addition to changing the predictors.",
      "The sample changes too: attendance is missing in an additional row.",
    ],
    [
      null,
      "The standard errors are precisely the part whose calculation changes.",
      "The same observations enter both models. The covariance choice does not add or remove rows here.",
    ],
    [
      null,
      "A shared sample separates one source of a coefficient change; it does not establish causal identification.",
      "Even on the same rows, adding a predictor can change the hours coefficient.",
    ],
  ],
  "data-quality": [
    [
      null,
      "Zero is an observed value with a substantive meaning. It is not a general replacement for unknown data.",
      "Whether a row changes a coefficient does not establish that it is erroneous.",
    ],
    [
      "A repeated ID can have several explanations. Determine the intended observational unit before removing records.",
      null,
      "Sample size does not determine whether a duplicate is a recording error.",
    ],
    [
      null,
      "A failed assertion locates a contradiction; it does not justify deleting every observation.",
      "The command did run and tested the condition. Its failure is the result of that test.",
    ],
    [
      null,
      "The condition isolates a specific recorded age, not an entire clinic.",
      "The explicit nonmissing condition excludes the row with unknown age.",
    ],
  ],
  "independent-analysis": [
    [
      null,
      "The outcome is an hourly wage, not an annual total. Check the dataset’s unit description.",
      "The outcome is in dollars per hour, not log dollars; no log transformation was applied.",
    ],
    [
      null,
      "An unadjusted scatterplot does not hold experience fixed.",
      "Even after adjustment, a causal return would require an identification argument.",
    ],
    [
      null,
      "The regression supplies a conditional association. These data have no identifying assignment design.",
      "The synthetic sample was not drawn to represent a real population.",
    ],
    [
      null,
      "A screenshot preserves appearance but cannot reproduce the calculations.",
      "A final dataset alone does not record how the analysis was constructed from its original inputs.",
    ],
  ],
};

export function enrichFoundations(lessons) {
  return lessons.map((lesson) => ({
    ...lesson,
    track:
      lesson.id === "data-quality"
        ? "data"
        : lesson.id === "independent-analysis"
          ? "independent"
          : "beginner",
    steps: lesson.steps.map((step, i) => ({
      ...step,
      hints: help[lesson.id][i],
      answerFeedback: feedback[lesson.id][i],
    })),
  }));
}
