import { numeric } from "./lesson-schema.js";

export const EXTENDED_LESSONS = [
  {
    id: "observation-order",
    title: "Observation order and identifiers",
    track: "data",
    level: "Data work",
    minutes: 15,
    dataset: "study",
    summary:
      "Distinguish a row’s position from its identifier, and make ordering explicit.",
    steps: [
      {
        title: "Change the ordering",
        explanation:
          "sort rearranges observations; it does not change the values belonging to each student. Numeric missing values appear after finite values in ascending order.",
        task: "Sort the dataset by score, from lowest to highest.",
        command: "sort score",
        question: "Where should the student with a missing score appear?",
        answers: [
          "Before the lowest observed score",
          "After the highest observed score",
          "Outside the dataset",
        ],
        correct: 1,
        feedback:
          "The missing score sorts last. Its observation is still present, with the same ID and other values.",
        answerFeedback: [
          "Numeric missing sorts above finite scores in Stata; it is not treated as zero.",
          null,
          "Sorting changes positions, not which observations exist.",
        ],
        hints: [
          "This task changes the order of rows, not the score variable.",
          "Use sort followed by the variable that should determine the order.",
        ],
      },
      numeric({
        title: "Read positions after sorting",
        explanation:
          "The in qualifier uses the current ordering. After sorting by score, the first observation is the student with the lowest observed score, regardless of that student’s ID.",
        task: "List id and score for the first three observations in the current order.",
        command: "list id score in 1/3",
        question: "What is the ID of the first observation now?",
        response: {
          expected: 17,
          unit: "student ID",
          resultPath: ["rows", 0, "values", 0],
          mistakes: [
            {
              value: 1,
              message:
                "The position is 1, but the ID column identifies the student. Read that column after the sort.",
            },
          ],
        },
        feedback:
          "ID 17 has score 43 and is now in the first position. The ID did not change when the row moved.",
        hints: [
          "Choose the two columns first, then restrict observation positions.",
          "The qualifier is in 1/3. It comes after the variable list.",
        ],
      }),
      {
        title: "Select by identity",
        explanation:
          "A condition on id follows a student through any ordering. This is useful when investigating a particular record or comparing a reproducible group of records.",
        task: "Display id and score for IDs 1, 2 and 3, using a condition on id.",
        command: "list id score if inlist(id, 1, 2, 3)",
        question:
          "Would sorting by hours change which students this condition selects?",
        answers: [
          "Yes; it always selects the first three rows",
          "No; it still selects the same three IDs",
          "Yes; it selects three new students at random",
        ],
        correct: 1,
        feedback:
          "The condition selects the same IDs. Their display order can change when you sort.",
        answerFeedback: [
          "That describes in 1/3. The if condition evaluates the ID values.",
          null,
          "Sorting is deterministic here and does not sample observations.",
        ],
        hints: [
          "Use if to select values rather than positions.",
          "inlist(id, 1, 2, 3) checks whether an ID is one of those three values.",
        ],
      },
      {
        title: "Restore a documented order",
        explanation:
          "An explicit final sort makes a printed table easier to compare across runs. Sorting alone does not establish that an identifier is unique; isid checks that separately.",
        task: "Sort by id and then verify that id uniquely identifies every observation.",
        command: "sort id\nisid id",
        ordered: true,
        question: "Which fact does a successful isid id check establish?",
        answers: [
          "ID values are consecutive integers",
          "ID values are unique and nonmissing",
          "ID values reveal the order in which records were collected",
        ],
        correct: 1,
        feedback:
          "isid checks uniqueness and nonmissingness. IDs can have gaps and need not encode a collection order.",
        answerFeedback: [
          "Unique identifiers can have gaps; isid does not require a consecutive sequence.",
          null,
          "Collection order requires metadata. It cannot be inferred from a successful uniqueness check.",
        ],
        hints: [
          "The editor can run several commands in sequence.",
          "Use sort for order, then isid for the key check. These are different operations.",
        ],
      },
    ],
  },
  {
    id: "do-files",
    title: "A reproducible do-file",
    track: "data",
    level: "Data work",
    minutes: 20,
    dataset: "study",
    summary:
      "Run a script in sections, diagnose a stopped command and begin from a known input.",
    steps: [
      numeric({
        title: "Run a short section",
        explanation:
          "A do-file records commands in the order they should run. Comments explain the analysis without executing. Run current executes the command at the cursor; Run all executes the full editor and stops at the first error.",
        task: "Write a comment describing the sample, then count observations with hours and score both observed.",
        command:
          "* Available observations for score on hours\ncount if !missing(score, hours)",
        question:
          "How many observations are available for this two-variable analysis?",
        response: { expected: 22, unit: "observations", resultPath: ["n"] },
        feedback:
          "There are 22 complete pairs. The comment documents why this count matters.",
        hints: [
          "A line beginning with * is a comment. The calculation still needs a command.",
          "missing(score, hours) identifies rows where either value is missing; ! reverses that condition.",
        ],
      }),
      {
        title: "Repair the stopped command",
        explanation:
          "The draft below misspells a variable. Run it to see the error, then fix it. Stata stops at a misspelled variable because it cannot determine the requested calculation; guessing would be unsafe.",
        task: "Correct the variable name and summarize hours and score.",
        starter: "summarize hours scroe",
        command: "summarize hours score",
        question:
          "What should you do when Stata reports a variable was not found?",
        answers: [
          "Check the names in memory and correct the command",
          "Replace that variable’s missing values with zero",
          "Continue as if the requested calculation had run",
        ],
        correct: 0,
        feedback:
          "Check the variable list in the data browser or use describe. The failed command produced no summary and changed no data.",
        answerFeedback: [
          null,
          "This is a name error, not a missing-data problem. No values need changing.",
          "A stopped command has not produced the requested result. Correct it before interpreting output.",
        ],
        hints: [
          "Compare scroe with the column names in the data browser.",
          "The intended variable is score. Correct that name; keep hours in the variable list.",
        ],
      },
      {
        title: "Continue a long command",
        explanation:
          "Three slashes at the end of a line continue a command onto the next line. The editor treats those lines as one command when you use Run current. A comma separates the model specification from its options.",
        task: "Estimate score on hours and attendance with robust standard errors, placing attendance and the option on the continuation line.",
        command: "regress score hours ///\n    attendance, vce(robust)",
        question: "What is the role of the three slashes?",
        answers: [
          "They estimate three separate models",
          "They join the next line to the current command",
          "They turn the entire following line into a comment",
        ],
        correct: 1,
        feedback:
          "The two physical lines form one regress command. The covariance option applies to that model.",
        answerFeedback: [
          "Only one regress command is present. The slashes change how its lines are read.",
          null,
          "A // comment ends a line; /// also continues the command onto the next line.",
        ],
        hints: [
          "Use /// at the end of the first line, after hours.",
          "Put attendance, vce(robust) on the second line. There is one comma before the options.",
        ],
      },
      numeric({
        title: "Start from a known input",
        explanation:
          "A script that depends on yesterday’s data in memory is difficult to reproduce. Begin from the original file and state the sample explicitly. The browser provides the three named teaching CSVs; export them with your do-file to rerun in Stata.",
        task: "Clear memory, load study.csv, and count observations with score, hours and attendance all observed.",
        command:
          'clear\nimport delimited using "study.csv", clear\ncount if !missing(score, hours, attendance)',
        requireReload: "study.csv",
        question:
          "How many complete observations are available after reloading the original data?",
        response: { expected: 21, unit: "observations", resultPath: ["n"] },
        feedback:
          "The original dataset again supplies 21 complete observations. A saved editor draft preserves comments; the executed history records successful commands.",
        hints: [
          "The import needs a quoted filename and the clear option.",
          'Start with import delimited using "study.csv", clear after clearing memory; finish with the complete-case count.',
        ],
      }),
    ],
  },
  {
    id: "temporary-samples",
    title: "Temporary samples with preserve",
    track: "data",
    level: "Data work",
    minutes: 18,
    dataset: "study",
    summary:
      "Keep a recoverable copy, examine a subset and restore all observations.",
    steps: [
      {
        title: "Keep a temporary copy",
        explanation:
          "preserve keeps one recoverable copy of the current data, including variables, labels and ordering. It is useful before a temporary change. It does not write a permanent backup file.",
        task: "Preserve the current dataset before changing its sample.",
        command: "preserve",
        question: "What has changed immediately after preserve?",
        answers: [
          "The current data have been restricted",
          "A temporary copy is available; current rows and values are unchanged",
          "A permanent data file has been saved to your computer",
        ],
        correct: 1,
        feedback:
          "The data in memory are unchanged. Use restore to recover the preserved copy after temporary work; export or save files for a durable copy.",
        answerFeedback: [
          "preserve does not select a sample. The next command will make the temporary change.",
          null,
          "The preserved copy is temporary. A permanent file requires a separate save or export.",
        ],
        hints: [
          "This command takes no variable list.",
          "Run preserve by itself. Only one copy can be active in this workspace.",
        ],
      },
      {
        title: "Restrict the working data",
        explanation:
          "keep if removes other observations from the current data. In contrast, summarize ... if only restricts that calculation. The preserved copy lets you recover the removed rows later.",
        task: "Keep only observations in group A.",
        command: 'keep if group == "A"',
        question: 'How does this differ from summarize score if group == "A"?',
        answers: [
          "Both commands permanently discard the other group",
          "keep changes the rows in memory; summarize with if does not",
          "keep changes group B’s values to missing",
        ],
        correct: 1,
        feedback:
          "There are now 12 rows in memory. Group B’s rows remain available in the preserved copy.",
        answerFeedback: [
          "A summary with if leaves every row in memory. This keep operation is also recoverable because you preserved first.",
          null,
          "The excluded rows are removed from the working dataset, not recoded to missing.",
        ],
        hints: [
          "Use keep with an if condition.",
          'Group is a string: compare group to the quoted value "A" using ==.',
        ],
      },
      numeric({
        title: "Account for missing outcomes",
        explanation:
          "Restricting to a group does not ensure every variable is observed. Compare the number of rows in memory with the nonmissing count in the summary table.",
        task: "Summarize score in the current group A sample.",
        command: "summarize score",
        question: "How many observed scores contribute to the mean?",
        response: {
          expected: 11,
          unit: "observed scores",
          resultPath: ["stats", 0, "n"],
          mistakes: [
            {
              value: 12,
              message:
                "There are 12 group A rows, but one score is missing. Read the Obs column for score.",
            },
          ],
        },
        feedback:
          "Eleven scores contribute. The twelfth group A row remains in memory with score missing.",
        hints: [
          "No if condition is needed now: group B has already been removed from the working data.",
          "Use summarize score and read its Obs column, not the total above the data browser.",
        ],
      }),
      {
        title: "Restore the full dataset",
        explanation:
          "restore replaces the current data with the preserved copy and releases that copy. Changes made since preserve disappear. Browser practice keeps the copy across Run actions; native Stata also restores automatically when the enclosing do-file or program ends.",
        task: "Restore the original 24-observation dataset.",
        command: "restore",
        question: "Which data return after restore?",
        answers: [
          "Only group B’s rows, appended to the current data",
          "The complete dataset as it was when preserve ran",
          "The original downloaded file regardless of when preserve ran",
        ],
        correct: 1,
        feedback:
          "restore returns to the state captured by preserve. If you had edited data before preserving, those earlier edits would also be in the copy.",
        answerFeedback: [
          "restore replaces the working data with the copy; it does not append selected rows.",
          null,
          "The reference point is preserve, not the original file. Earlier edits are part of that saved state.",
        ],
        hints: [
          "The copy has already been created; do not call preserve again.",
          "Run restore without a variable list or filename.",
        ],
      },
      numeric({
        title: "Verify the restoration",
        explanation:
          "Check a recovered dataset before continuing an analysis. The data browser and a count should agree about how many rows are in memory.",
        task: "Count every observation in the restored dataset.",
        command: "count",
        question: "How many observations are back in memory?",
        response: { expected: 24, unit: "observations", resultPath: ["n"] },
        feedback:
          "All 24 observations are present again. Command help also explains restore, preserve and restore, not for retaining or discarding a copy.",
        hints: [
          "An unqualified count includes rows with missing values.",
          "Use count by itself; adding a variable or condition would answer a different question.",
        ],
      }),
    ],
  },
  {
    id: "group-comparisons",
    title: "Group means and regression",
    track: "models",
    level: "Model specification",
    minutes: 22,
    dataset: "study",
    summary:
      "Connect a binary predictor, group means and an adjusted comparison.",
    steps: [
      {
        title: "Construct a binary predictor",
        explanation:
          "A numeric indicator can represent group membership in a regression. Set group_b to 1 for B and 0 for A, while keeping any unknown group missing. With an intercept, group A will be the reference group.",
        task: "Create group_b from group, leaving any missing group unclassified.",
        command: 'generate double group_b = group == "B" if !missing(group)',
        question: "Which observations get group_b = 0?",
        answers: [
          "The observations in group A",
          "The observations with missing group",
          "The observations in group B",
        ],
        correct: 0,
        feedback:
          "Group A receives 0 and group B receives 1. The condition protects unknown groups from becoming a known category, even though this dataset has none.",
        answerFeedback: [
          null,
          "The if condition excludes unknown groups, so they would receive missing in the new column.",
          "Comparing B to B is true, so group B receives 1.",
        ],
        hints: [
          "A string comparison produces a numeric 0 or 1.",
          'Use group == "B" as the expression and !missing(group) as the qualifier.',
        ],
      },
      numeric({
        title: "Read the reference-group mean",
        explanation:
          "A group mean uses the observed outcomes in that group. Group sizes and nonmissing outcome counts need not be the same.",
        task: "Summarize score for group A.",
        command: 'summarize score if group == "A"',
        question: "What is group A’s mean score?",
        response: {
          expected: 66.9090909090909,
          tolerance: 0.005,
          decimals: 2,
          unit: "score points",
          resultPath: ["stats", 0, "mean"],
        },
        feedback: "The mean is about 66.91 points, using 11 observed scores.",
        hints: [
          "Use summarize with an if qualifier; do not remove group B.",
          'The condition is group == "A". Read the Mean column for score.',
        ],
      }),
      numeric({
        title: "Read the comparison-group mean",
        explanation:
          "Calculate the second mean using the same outcome definition. The B-minus-A difference will be the coefficient of group_b in a regression with an intercept and no other predictors.",
        task: "Summarize score for group B.",
        command: 'summarize score if group == "B"',
        question: "What is group B’s mean score?",
        response: {
          expected: 70.91666666666667,
          tolerance: 0.005,
          decimals: 2,
          unit: "score points",
          resultPath: ["stats", 0, "mean"],
        },
        feedback:
          "The mean is about 70.92 points, using 12 scores. It exceeds A’s mean by about 4.01 points.",
        hints: [
          "Keep the same outcome and change only the group condition.",
          'Use if group == "B" and read the Mean column.',
        ],
      }),
      numeric({
        title: "Recover the mean difference",
        explanation:
          "For a 0/1 predictor with an intercept, OLS fits each group’s observed mean. The intercept is the reference-group mean; the indicator coefficient is the difference from that mean.",
        task: "Regress score on group_b with an intercept.",
        command: "regress score group_b",
        question: "What is the coefficient of group_b?",
        response: {
          expected: 4.007575757575801,
          tolerance: 0.005,
          decimals: 2,
          unit: "score points",
          resultPath: ["model", "coefficients", 0, "b"],
          mistakes: [
            {
              value: 70.92,
              tolerance: 0.01,
              message:
                "70.92 is B’s mean. The indicator coefficient is B’s mean minus A’s mean; read the group_b row.",
            },
          ],
        },
        feedback:
          "The coefficient is about 4.01 points: 70.92 minus 66.91. This is an unadjusted sample comparison.",
        hints: [
          "Place score first and the numeric indicator second.",
          "Read the coefficient on group_b, not the intercept or either separate group mean.",
        ],
      }),
      {
        title: "Adjust the comparison",
        explanation:
          "Adding hours compares the groups at a common fitted study time under a shared-slope model. It also excludes the row with missing hours, so both adjustment and sample membership differ from the preceding regression.",
        task: "Regress score on group_b and hours with robust standard errors.",
        command: "regress score group_b hours, vce(robust)",
        question: "What does the group_b coefficient describe now?",
        answers: [
          "The original unadjusted difference in means",
          "A fitted B-minus-A difference at the same hours, assuming a shared slope",
          "The effect of randomly assigning tutorial group",
        ],
        correct: 1,
        feedback:
          "This additive model assumes a constant group difference across hours. Neither the regression nor robust standard errors makes group membership random.",
        answerFeedback: [
          "Including hours changes the fitted comparison, and the available sample also changes.",
          null,
          "The data are observational and synthetic; no assignment design was supplied.",
        ],
        hints: [
          "Include both predictors after score, then add the covariance option.",
          "The option follows a comma: vce(robust). An interaction is not part of this shared-slope model.",
        ],
      },
    ],
  },
  {
    id: "sample-accounting",
    title: "Estimation and prediction samples",
    track: "models",
    level: "Model specification",
    minutes: 20,
    dataset: "study",
    summary:
      "Keep estimation availability separate from the rows that can receive a prediction.",
    steps: [
      {
        title: "Record the intended sample",
        explanation:
          "A named indicator makes a sample rule inspectable and reusable. Here, complete should equal 1 exactly when score, hours and attendance are all observed.",
        task: "Create the complete-case indicator named complete.",
        command:
          "generate double complete = !missing(score, hours, attendance)",
        question: "What does complete = 0 mean here?",
        answers: [
          "At least one required model variable is missing",
          "The observation is known to be unreliable",
          "All three required variables are missing",
        ],
        correct: 0,
        feedback:
          "The indicator records availability only. It does not diagnose why a value is missing or justify deleting that observation from every analysis.",
        answerFeedback: [
          null,
          "Missingness does not itself establish that the observed values are unreliable.",
          "missing(x, y, z) is true when any argument is missing; all three need not be missing.",
        ],
        hints: [
          "missing accepts more than one argument.",
          "Apply ! to missing(score, hours, attendance) to mark complete rows with 1.",
        ],
      },
      numeric({
        title: "Confirm the estimation count",
        explanation:
          "A regression requires an observed outcome and all included predictors. Supplying the sample indicator makes the rule explicit; it should agree with Stata’s complete-case selection.",
        task: "Regress score on hours and attendance among complete observations.",
        command: "regress score hours attendance if complete == 1",
        question: "How many observations entered the regression?",
        response: {
          expected: 21,
          unit: "observations",
          resultPath: ["model", "n"],
        },
        feedback:
          "The model uses 21 observations. The other three remain in memory.",
        hints: [
          "The sample condition follows the dependent variable and both predictors.",
          "Read Number of obs in the regression output, not the dataset’s row total.",
        ],
      }),
      {
        title: "Predict wherever predictors exist",
        explanation:
          "predict uses the fitted equation. It can calculate a fitted score for a row excluded only because its outcome was missing, provided both predictors are observed. This does not make that row part of estimation.",
        task: "Create the fitted-value variable named fitted without an if condition.",
        command: "predict double fitted",
        question:
          "Why can ID 21 receive a fitted value despite its missing score?",
        answers: [
          "predict silently refits the model after filling in score",
          "Its hours and attendance are observed, so the fitted equation can be evaluated",
          "The original missing score is changed to the fitted value",
        ],
        correct: 1,
        feedback:
          "Prediction uses observed hours and attendance. The original score remains missing, and the model is not refitted.",
        answerFeedback: [
          "predict evaluates the existing coefficients. It does not re-estimate the regression.",
          null,
          "The prediction is a separate variable. It does not replace the observed outcome.",
        ],
        hints: [
          "Use predict after the regression, before changing the original data.",
          "A new variable named fitted is sufficient. Omitting if allows prediction outside the estimation sample.",
        ],
      },
      numeric({
        title: "Count available predictions",
        explanation:
          "The prediction sample depends on predictors. The estimation sample also depended on the outcome. Those counts can differ even when the same fitted equation is used.",
        task: "Count observations with a nonmissing fitted value.",
        command: "count if !missing(fitted)",
        question: "How many fitted values are available?",
        response: {
          expected: 22,
          unit: "predictions",
          resultPath: ["n"],
          mistakes: [
            {
              value: 21,
              message:
                "21 rows estimated the model. One additional row has both predictors but a missing outcome, so it can receive a prediction.",
            },
          ],
        },
        feedback:
          "There are 22 fitted values: the 21 estimation observations and one additional row with missing score.",
        hints: [
          "Count the new variable’s observed values, not the complete indicator.",
          "Use !missing(fitted) as the condition.",
        ],
      }),
      numeric({
        title: "Locate the extra prediction",
        explanation:
          "A prediction outside the estimation sample is not an observed outcome or an independently validated forecast. Keep its status visible in any report.",
        task: "Count rows with a fitted value but no observed score.",
        command: "count if !missing(fitted) & missing(score)",
        question: "How many rows meet both conditions?",
        response: { expected: 1, unit: "observation", resultPath: ["n"] },
        feedback:
          "One row meets both conditions. There is no residual for that row because residual = observed score − fitted score requires the outcome.",
        hints: [
          "Both conditions must hold, so join them with &.",
          "Require a nonmissing fitted value and a missing score. Those conditions are different.",
        ],
      }),
    ],
  },
  {
    id: "functional-forms",
    title: "Logs, units and curvature",
    track: "models",
    level: "Model specification",
    minutes: 25,
    dataset: "wages",
    summary:
      "Interpret a log outcome and distinguish a polynomial coefficient from a slope.",
    steps: [
      {
        title: "Define a log outcome",
        explanation:
          "A natural logarithm requires a positive value. Preserve the original wage and create a separate transformed column. Zero, negative and missing values require an explicit decision rather than an arbitrary small constant.",
        task: "Create ln_wage as the natural log of positive, observed wage.",
        command:
          "generate double ln_wage = ln(wage) if wage > 0 & !missing(wage)",
        question:
          "What would happen to a row with wage = 0 under this command?",
        answers: [
          "ln_wage would be 0",
          "ln_wage would be missing",
          "The row would be removed from memory",
        ],
        correct: 1,
        feedback:
          "The qualifier excludes zero wages from the transformation, leaving ln_wage missing. It does not delete the row.",
        answerFeedback: [
          "ln(1), not ln(0), equals zero. A zero wage has no finite natural logarithm.",
          null,
          "generate creates a column. Rows excluded by its if condition remain in memory.",
        ],
        hints: [
          "Use ln(wage) and retain wage as the original variable.",
          "Combine wage > 0 with !missing(wage). Stata’s numeric missing also compares above zero.",
        ],
      },
      numeric({
        title: "Estimate a log-level model",
        explanation:
          "With log wage as the outcome and education in years, the education coefficient is a fitted log-wage difference per additional year, holding experience fixed. Multiplying it by 100 gives an approximate percentage difference.",
        task: "Regress ln_wage on education and experience.",
        command: "regress ln_wage education experience",
        question: "What is the education coefficient, in log points per year?",
        response: {
          expected: 0.04640097137267766,
          tolerance: 0.0005,
          decimals: 3,
          unit: "log points per year",
          resultPath: ["model", "coefficients", 0, "b"],
          mistakes: [
            {
              value: 4.64,
              tolerance: 0.01,
              message:
                "4.64 is the approximate percentage difference. This question asks for the coefficient in log points: read the unscaled coefficient.",
            },
          ],
        },
        feedback:
          "The coefficient is approximately 0.0464 log points, or about 4.64% as a first-order approximation. This remains a fitted association.",
        hints: [
          "The transformed outcome goes first in regress.",
          "Read the education row. Do not multiply by 100 for this question.",
        ],
      }),
      numeric({
        title: "Convert a stated log difference",
        explanation:
          "For a log difference b, the exact proportional change between exponentiated fitted log values is exp(b) − 1. This alone does not recover a difference in conditional arithmetic mean wages; retransformation of the error term also matters.",
        task: "For a stated log difference of 0.04, calculate 100 × (exp(0.04) − 1).",
        command: "display 100 * (exp(0.04) - 1)",
        question:
          "What exact percentage change corresponds to this stated 0.04 log difference?",
        response: {
          expected: 4.081077419238821,
          tolerance: 0.005,
          decimals: 2,
          unit: "%",
          resultPath: ["value"],
          mistakes: [
            {
              value: 4,
              message:
                "4% is the approximation 100b. Use the exponential expression to obtain the exact change between exponentiated fitted values.",
            },
          ],
        },
        feedback:
          "The exact change is about 4.08%. This calculation uses the stated example b = 0.04, not the education estimate from the previous step.",
        hints: [
          "display evaluates a scalar expression without changing the dataset.",
          "Subtract 1 after exponentiating, then multiply the entire difference by 100.",
        ],
      }),
      {
        title: "Add a squared predictor",
        explanation:
          "A quadratic lets the fitted slope vary with experience. Keep the linear term when adding the squared term unless a substantive restriction justifies dropping it.",
        task: "Create experience2 as experience squared.",
        command: "generate double experience2 = experience ^ 2",
        question:
          "If fitted wage is a + b × experience + c × experience², what is its slope at experience x?",
        answers: ["b + c", "b + 2cx", "c, the coefficient on experience²"],
        correct: 1,
        feedback:
          "The derivative is b + 2cx. Neither coefficient alone describes the slope at every experience value.",
        answerFeedback: [
          "Differentiating x² gives 2x, so the contribution of the squared term depends on experience.",
          null,
          "c governs curvature. The local slope also includes b and depends on x.",
        ],
        hints: [
          "Use a new variable so the original experience remains available.",
          "The exponent operator is ^. Multiplying experience by itself is equivalent.",
        ],
      },
      {
        title: "Fit and bound the interpretation",
        explanation:
          "Return to wage in dollars and include education, experience and experience². This is a different outcome specification from log wage. A fitted curve outside the observed experience range can behave very differently from the data-supported segment.",
        task: "Regress wage on education, experience and experience2.",
        command: "regress wage education experience experience2",
        question:
          "What should accompany a reported experience slope from this quadratic?",
        answers: [
          "The experience value where the slope is evaluated, its units and the sample range",
          "Only the sign of experience2",
          "A claim that the curve remains valid at any experience value",
        ],
        correct: 0,
        feedback:
          "State where the derivative is evaluated and keep the claim within the data and model assumptions. A quadratic form does not justify distant extrapolation.",
        answerFeedback: [
          null,
          "The squared coefficient describes curvature, not the complete local slope.",
          "The functional form can extrapolate numerically, but the data do not validate that extrapolation.",
        ],
        hints: [
          "The dependent variable is wage here, not ln_wage.",
          "Include both experience and experience2, as well as education.",
        ],
      },
    ],
  },
  {
    id: "interactions",
    title: "Different slopes across groups",
    track: "models",
    level: "Model specification",
    minutes: 25,
    dataset: "study",
    summary:
      "Build an interaction, choose a useful reference point and interpret both group slopes.",
    steps: [
      {
        title: "Choose the reference group",
        explanation:
          "An interaction allows the hours–score association to differ across groups. Begin with group_b = 1 for group B and 0 for A. The indicator’s coding determines the reference group.",
        task: "Create group_b, preserving unknown group values as missing.",
        command: 'generate double group_b = group == "B" if !missing(group)',
        question:
          "Which group’s hours slope will the main hours coefficient describe?",
        answers: [
          "Group A, where group_b = 0",
          "Group B, where group_b = 1",
          "An equally weighted mean of the two slopes",
        ],
        correct: 0,
        feedback:
          "When group_b = 0, the interaction term is zero. The main hours coefficient therefore describes group A’s slope.",
        answerFeedback: [
          null,
          "Group B’s slope includes both the main hours coefficient and the interaction coefficient.",
          "This parameterization uses A as the reference; it does not force an average-slope interpretation.",
        ],
        hints: [
          "Use the same indicator coding throughout the model.",
          'The expression is group == "B"; exclude missing group values with the if qualifier.',
        ],
      },
      {
        title: "Set a useful reference point",
        explanation:
          "Centering hours at 5 makes hours_c = 0 correspond to five study hours. This changes the meanings of the intercept and group coefficient, while leaving the fitted values of a fully specified interaction model unchanged.",
        task: "Create hours_c by subtracting 5 from hours.",
        command: "generate double hours_c = hours - 5",
        question:
          "At what study time will the group_b coefficient compare the groups?",
        answers: [
          "Zero hours",
          "Five hours",
          "The sample mean, regardless of the value subtracted",
        ],
        correct: 1,
        feedback:
          "The group coefficient compares the fitted scores when hours_c = 0, which is five original study hours.",
        answerFeedback: [
          "Zero on the centered scale corresponds to five on the original scale.",
          null,
          "Centering at 5 chooses five hours. It is the sample mean only if the mean happens to equal 5.",
        ],
        hints: [
          "Subtract the reference value from every observed hour value.",
          "Missing hours remain missing under arithmetic; no replacement is needed.",
        ],
      },
      {
        title: "Construct the product",
        explanation:
          "Multiplying centered hours by the indicator gives zero for observed group A hours and hours_c for group B. Include both constituent predictors when estimating the model. You can also write c.hours_c##i.group_b in regress; this lesson creates the columns so you can inspect their values.",
        task: "Create hours_b as hours_c multiplied by group_b.",
        command: "generate double hours_b = hours_c * group_b",
        question:
          "What is hours_b for a group B student who studies seven hours?",
        answers: ["0", "2", "7"],
        correct: 1,
        feedback:
          "Centered hours are 7 − 5 = 2 and group_b = 1, so the product is 2.",
        answerFeedback: [
          "The product is zero for observed group A values, where group_b = 0.",
          null,
          "The product uses centered hours, so subtract 5 before multiplying.",
        ],
        hints: [
          "Multiply the centered variable by the indicator, not by the string group.",
          "The expression is hours_c * group_b. Retain both original columns.",
        ],
      },
      numeric({
        title: "Read the difference in slopes",
        explanation:
          "Fit score on hours_c, group_b and hours_b. The interaction coefficient is B’s hours slope minus A’s hours slope; it is not B’s full slope. A small sample estimate need not imply a precisely established population difference.",
        task: "Estimate the interaction model with all three predictors.",
        command: "regress score hours_c group_b hours_b",
        question: "What is the estimated B-minus-A difference in hours slopes?",
        response: {
          expected: -0.5754150476863384,
          tolerance: 0.005,
          decimals: 2,
          unit: "score points per hour",
          resultPath: ["model", "coefficients", 2, "b"],
        },
        feedback:
          "The estimated difference is about −0.58 points per hour. Group A’s slope is about 5.65 and group B’s is about 5.08; uncertainty still matters.",
        hints: [
          "Include hours_c, group_b and hours_b after score.",
          "Read the hours_b row. Adding it to the hours_c coefficient gives B’s full slope.",
        ],
      }),
      {
        title: "Check the two fitted relationships",
        explanation:
          "Fitted values now follow a separate line for each group. The coefficient on group_b compares those lines at five hours; the comparison changes with hours because their slopes differ.",
        task: "Create fitted values named fitted_interaction.",
        command: "predict double fitted_interaction",
        question:
          "How is B’s fitted score minus A’s fitted score calculated at h original hours?",
        answers: [
          "group_b coefficient alone at every h",
          "group_b coefficient + hours_b coefficient × (h − 5)",
          "hours_c coefficient + hours_b coefficient × h",
        ],
        correct: 1,
        feedback:
          "The fitted group difference equals the group coefficient plus the interaction coefficient times centered hours. Both groups’ shared intercept and main hours term cancel in the difference.",
        answerFeedback: [
          "That is the comparison at five hours only. The interaction makes it vary elsewhere.",
          null,
          "The main hours term is present in both groups and cancels. The interaction uses centered hours.",
        ],
        hints: [
          "predict evaluates the most recent model using the constructed columns.",
          "Use a new variable name. If you later change hours, rebuild the centered and interaction columns before refitting or predicting.",
        ],
      },
    ],
  },
  {
    id: "debugging",
    title: "Diagnose and repair an analysis",
    track: "independent",
    level: "Independent practice",
    minutes: 25,
    dataset: "study",
    summary:
      "Repair syntax, a missing-value classification, reversed variables and a residual sign.",
    steps: [
      numeric({
        title: "A condition that will not run",
        explanation:
          "The draft uses assignment syntax where Stata expects a comparison. Run it to inspect the error, then correct the condition. The data should remain unchanged.",
        task: "Repair the command so it counts group A observations.",
        starter: 'count if group = "A"',
        command: 'count if group == "A"',
        question: "How many observations does the repaired condition select?",
        response: { expected: 12, unit: "observations", resultPath: ["n"] },
        feedback:
          "The repaired comparison selects 12 observations. Equality tests use ==; generate and replace use = to assign an expression.",
        hints: [
          "The error concerns the comparison operator, not the group value.",
          'Use two equals signs to test whether group equals "A".',
        ],
      }),
      {
        title: "A command that runs but misclassifies",
        explanation:
          "A syntactically valid command can still implement the wrong rule. The draft classifies unknown hours as high study because numeric missing compares above finite values. Run it and inspect ID 19 before repairing it.",
        task: "Create high_study for hours ≥ 6, leaving unknown hours missing. If you already ran the draft, repair the existing variable with replace.",
        starter: "generate double high_study = hours >= 6",
        command: "generate double high_study = hours >= 6 if !missing(hours)",
        repairWhen: {
          variables: ["high_study"],
          command:
            "replace high_study = hours >= 6 if !missing(hours)\nreplace high_study = . if missing(hours)",
        },
        question: "Why is an explicit missing-value rule needed?",
        answers: [
          "An unknown input would otherwise be recorded as a known high-study category",
          "Stata cannot compare observed numbers",
          "The rule should remove every student below six hours",
        ],
        correct: 0,
        feedback:
          "Preserving unknowns prevents a data-quality problem from becoming a false classification. A successful command is not evidence that its rule was appropriate.",
        answerFeedback: [
          null,
          "Observed numeric comparisons work. The issue is how numeric missing is ordered.",
          "The task creates an indicator; it does not remove low-study observations.",
        ],
        hints: [
          "If the variable does not exist, guard generate with if !missing(hours). If it exists, change only its missing-input rows.",
          "After running the flawed draft, use replace high_study = . if missing(hours). Loading a fresh generate command would instead fail because the variable already exists.",
        ],
      },
      {
        title: "A model with reversed roles",
        explanation:
          "The draft is a valid regression, but it predicts hours from score. The intended analysis predicts score from hours. Reversing an OLS regression is not generally equivalent to taking a reciprocal slope.",
        task: "Repair the model so score is the dependent variable and hours is the predictor.",
        starter: "regress hours score",
        command: "regress score hours",
        question: "What are the repaired hours coefficient’s units?",
        answers: [
          "Study hours per score point",
          "Score points per study hour",
          "A unitless correlation",
        ],
        correct: 1,
        feedback:
          "The outcome is score and the predictor is hours, so the slope has score points per hour as its units.",
        answerFeedback: [
          "Those are the units of the reversed model in the draft.",
          null,
          "A regression slope carries units; a correlation is dimensionless.",
        ],
        hints: [
          "Stata’s first variable after regress is the dependent variable.",
          "Put score before hours. No data transformation is needed.",
        ],
      },
      {
        title: "A residual with the wrong sign",
        explanation:
          "The draft calculates fitted minus observed, reversing the usual residual. Run it to inspect the values, then repair the expression. A correct residual is observed score minus fitted score.",
        task: "Create fitted and residual, with residual = score − fitted. If the draft has run, use replace to repair residual.",
        starter:
          "predict double fitted\ngenerate double residual = fitted - score",
        command:
          "predict double fitted\ngenerate double residual = score - fitted",
        repairWhen: {
          variables: ["fitted", "residual"],
          command: "replace residual = score - fitted",
        },
        question:
          "Where is an observation with a positive corrected residual relative to the fitted line?",
        answers: [
          "Above the line",
          "Below the line",
          "Necessarily far from all the other observations",
        ],
        correct: 0,
        feedback:
          "A positive observed-minus-fitted residual places the point above the line. Its sign alone says nothing about how unusual its magnitude is.",
        answerFeedback: [
          null,
          "Below the line means observed < fitted, giving a negative residual.",
          "A positive residual can be small. Unusualness requires a scale and comparison.",
        ],
        hints: [
          "After the draft runs, fitted already exists. You only need to repair residual.",
          "Use replace residual = score - fitted if the draft has run. Otherwise create fitted and then generate the correct difference.",
        ],
      },
      {
        title: "Inspect the repaired calculation",
        explanation:
          "The direction and shape of a residual plot should be consistent with the repaired definition. A plot is a diagnostic, not a certificate that the model is correctly specified or causal.",
        task: "Plot residual vertically against fitted horizontally.",
        command: "scatter residual fitted",
        question: "What belongs in a reproducible account of this repair?",
        answers: [
          "The corrected definition and commands, with the original data retained",
          "Only a final screenshot, because the erroneous draft no longer matters",
          "A statement that all model assumptions have now been verified",
        ],
        correct: 0,
        feedback:
          "Keep the original data and the corrected commands. History and your notes can document what was wrong and why the repair was needed.",
        answerFeedback: [
          null,
          "A screenshot does not reproduce the calculations or explain the repair.",
          "Correcting a residual sign does not verify the substantive model assumptions.",
        ],
        hints: [
          "The scatter command puts its first variable on the vertical axis.",
          "Both variables should already exist. Plot them without generating new versions.",
        ],
      },
    ],
  },
];
