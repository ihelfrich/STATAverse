import { step, numeric } from "./lesson-schema.js";

export const GROUPED_LESSONS = [
  {
    id: "group-statistics",
    title: "Group statistics within individual data",
    track: "data",
    level: "Data work",
    minutes: 22,
    dataset: "study",
    summary:
      "Attach group means, inspect their source observations and distinguish assignment from contribution.",
    steps: [
      step(
        "Available measurements",
        "A row can contain some observed measurements and some missing ones. egen rownonmiss() counts across the named columns within each observation. Unlike count, it creates a variable with one result per student.",
        "Create available as the number of nonmissing values among hours, score and attendance.",
        "egen double available = rownonmiss(hours score attendance)",
        "What does available = 3 establish for a student?",
        [
          "All three named measurements are observed",
          "The student belongs to a group of three",
          "The three measurements are equal",
        ],
        0,
        "Three means that hours, score and attendance are all observed. It says nothing about their values or accuracy.",
        {
          hints: [
            "This is a calculation across columns within a row, so no grouping variable is needed.",
            "Use egen double available = rownonmiss(...), with the three variable names inside the parentheses.",
          ],
          answerFeedback: [
            null,
            "The count concerns columns within one observation. Group size is a different quantity.",
            "Nonmissingness does not compare magnitudes or units. Three unequal measurements can all be observed.",
          ],
        },
      ),
      step(
        "A tutorial-group mean",
        "egen mean() calculates a mean and attaches it to observations. With by(group), the calculation is separate for each tutorial group. Open Inspect rows in Results to see the scores and nonmissing count behind either mean.",
        "Create group_score as each tutorial group's mean score, retaining the individual observations.",
        "egen double group_score = mean(score), by(group)",
        "Why does group A have 12 source rows but 11 nonmissing scores?",
        [
          "One student was removed from the dataset",
          "One student has no observed score but still belongs to group A",
          "The mean counts the first student twice",
        ],
        1,
        "The missing score contributes neither a value nor a denominator observation to the mean. That student's row remains, and the calculated group mean is attached to it too.",
        {
          hints: [
            "Use egen to calculate across observations. The by() option identifies the grouping variable.",
            "The function is mean(score), and the grouping option follows the comma: by(group).",
          ],
          answerFeedback: [
            "egen adds a column; it does not remove the student whose score is missing.",
            null,
            "There is one input per observed score. The difference in counts comes from missingness, not duplicate weighting.",
          ],
        },
      ),
      numeric({
        title: "A noncontributing observation",
        explanation:
          "ID 21 has a missing score. Its group_score nevertheless contains the mean of group A's observed scores. Attaching that mean does not recover the student's unobserved exam result.",
        task: "List id, score and group_score for student 21.",
        command: "list id score group_score if id == 21",
        question: "What group_score value is attached to student 21?",
        response: {
          expected: 736 / 11,
          tolerance: 0.005,
          decimals: 2,
          unit: "score points",
          resultPath: ["rows", 0, "values", 2],
          mistakes: [
            {
              value: 0,
              message:
                "The original score is missing, not zero. Read the separate group_score column.",
            },
          ],
        },
        feedback:
          "The attached value is about 66.91. It describes the observed group mean, not student 21's exam score.",
        hints: [
          "Select the student's ID value with if, rather than relying on a position.",
          "Put the three requested variable names after list, then use if id == 21.",
        ],
      }),
      step(
        "Within-group deviations",
        "Subtracting a group's observed mean expresses each observed score as a deviation from that mean. In that same calculation sample, the deviations average to zero. The individual deviations can still be large, and the missing score remains missing.",
        "Create deviation = score - group_score, then summarize deviation for group A.",
        'generate double deviation = score - group_score\nsummarize deviation if group == "A"',
        "What does a mean deviation near zero tell you?",
        [
          "All students have the same score",
          "Positive and negative deviations balance in the observed group",
          "The group's mean score is zero",
        ],
        1,
        "Centering balances the deviations by construction. It does not remove variation between students; small numerical rounding differences around zero are immaterial here.",
        {
          hints: [
            "The generated variable subtracts the already attached group mean from each student's observed score.",
            'Run generate first, then summarize deviation if group == "A" on a second line.',
          ],
          answerFeedback: [
            "A zero average does not require every deviation to be zero. Inspect the standard deviation or individual rows.",
            null,
            "The calculation centers scores around their group mean; it does not change that mean into an original score of zero.",
          ],
        },
      ),
      step(
        "Calculation and assignment samples",
        "An if qualifier on egen affects two things: which observations enter the calculation and which observations receive the resulting value. Here, a student with missing hours is excluded even if their score is observed. A selected student with missing score can still receive the group mean.",
        "Create observed_hours_score as the group mean score among students whose hours are observed.",
        "egen double observed_hours_score = mean(score) if !missing(hours), by(group)",
        "Which student is excluded from assignment by this qualifier?",
        [
          "Every student with a missing score",
          "Every student in group A",
          "The student whose hours are missing",
        ],
        2,
        "The qualifier tests hours. Within its selected rows, mean(score) then ignores missing scores. Selection and nonmissingness of the summarized variable are separate conditions.",
        {
          hints: [
            "Keep by(group), but place the if qualifier before the comma.",
            "The selection is if !missing(hours). The summarized source remains score.",
          ],
          answerFeedback: [
            "The if qualifier does not test score. A selected row with missing score still receives the calculated mean.",
            "The qualifier does not test group membership; both tutorial groups can contribute.",
            null,
          ],
        },
      ),
      numeric({
        title: "Two different assignments",
        explanation:
          "Student 19 has missing hours and an observed score of 66. Student 21 has observed hours and a missing score. Removing 19 from the mean's sample changes group A's observed-score mean, while student 21 still receives the new group value.",
        task: "List id, hours, score, group_score and observed_hours_score for IDs 19 and 21.",
        command:
          "list id hours score group_score observed_hours_score if inlist(id, 19, 21)",
        question: "What observed_hours_score value is attached to student 21?",
        response: {
          expected: 67,
          unit: "score points",
          resultPath: ["rows", 1, "values", 4],
          mistakes: [
            {
              value: 66.909,
              tolerance: 0.01,
              message:
                "That is the earlier mean using all observed scores. Read observed_hours_score, which excludes the score of the student with missing hours.",
            },
          ],
        },
        feedback:
          "Student 21 receives 67. Student 19 receives missing in the new column because the if qualifier excluded that row from assignment.",
        hints: [
          "Compare both derived columns on the two specified rows.",
          "Use inlist(id, 19, 21) as the if condition. Read the new mean in the row for ID 21.",
        ],
      }),
    ],
  },
  {
    id: "collapse-samples",
    title: "Collapse and common calculation samples",
    track: "data",
    level: "Data work",
    minutes: 20,
    dataset: "study",
    summary:
      "Change the observational unit, compare variablewise and casewise summaries, and restore the individual data.",
    steps: [
      step(
        "The individual-level copy",
        "collapse replaces the working dataset with summary observations. A preserved copy lets you return to the original rows after inspecting a summary. It remains a temporary in-memory copy, not a file backup.",
        "Preserve the individual student data before collapsing them.",
        "preserve",
        "What does preserve do at this point?",
        [
          "Saves a permanent file on disk",
          "Keeps one temporary copy while leaving the working data unchanged",
          "Changes the data into group summaries",
        ],
        1,
        "The current dataset still contains 24 students. The preserved copy can recover these rows after a temporary transformation.",
        {
          hints: [
            "No variable list or filename is needed.",
            "Run preserve by itself, then check the preserved-copy indicator.",
          ],
          answerFeedback: [
            "preserve keeps an in-memory copy. Export or save a file for a portable backup.",
            null,
            "collapse performs the aggregation. preserve only retains the copy you can restore.",
          ],
        },
      ),
      step(
        "A group-level dataset",
        "A collapsed row represents a group, not an individual student. By default, each statistic uses the observed values of its own source variable. Equal counts do not establish that two statistics used the same students.",
        "Collapse by group, creating mean_hours and mean_score as means, plus n_hours and n_score as their nonmissing counts.",
        "collapse (mean) mean_hours=hours mean_score=score (count) n_hours=hours n_score=score, by(group)",
        "Group A has n_hours = 11 and n_score = 11. Do those counts establish an identical sample?",
        [
          "Yes; equal counts require identical observations",
          "No; the missing hours and score can belong to different students",
          "No; collapse always draws a new random sample",
        ],
        1,
        "Hours are missing for ID 19; score is missing for ID 21. The two means use different sets of eleven students. Inspect rows to see both source columns.",
        {
          hints: [
            "Name each output explicitly so means and counts can coexist for the same source.",
            "Put both mean assignments after (mean), both count assignments after (count), then add by(group).",
          ],
          answerFeedback: [
            "Counts describe how many observations contributed, not their identities. Different sets can have equal sizes.",
            null,
            "collapse calculates deterministic summaries of the selected rows. It does not resample them.",
          ],
        },
      ),
      step(
        "Restoration with a retained copy",
        "The next comparison must start from individual measurements. restore, preserve recovers them and keeps the temporary copy available for another transformation.",
        "Restore the individual dataset while retaining its preserved copy.",
        "restore, preserve",
        "What should be in memory after this command?",
        [
          "The 24 students, with a preserved copy still available",
          "Two summary rows and a preserved copy",
          "The 24 students with no remaining preserved copy",
        ],
        0,
        "The working data contain the original 24 students, and the preserved-copy indicator remains visible.",
        {
          hints: [
            "Ordinary restore would release the copy after recovering it.",
            "Use the preserve option on restore: restore, preserve.",
          ],
          answerFeedback: [
            null,
            "Restoration replaces the summary data with the retained individual observations.",
            "That describes ordinary restore. The preserve option keeps the copy for another comparison.",
          ],
        },
      ),
      step(
        "A common calculation sample",
        "The cw option requires a complete case across all source variables in the collapse command. Here it removes any row missing hours or score before calculating either mean. It does not require attendance, which is not a source in this command.",
        "Repeat the same grouped means and counts, now using casewise deletion.",
        "collapse (mean) mean_hours=hours mean_score=score (count) n_hours=hours n_score=score, by(group) cw",
        "Which observations are excluded before these summaries are calculated?",
        [
          "Every row missing hours, score or attendance",
          "Only the row with a missing score",
          "Rows missing hours or score",
        ],
        2,
        "The source list contains hours and score. ID 19 and ID 21 are excluded; the missing attendance for ID 20 does not affect this command.",
        {
          hints: [
            "Keep all the existing outputs and grouping; add the casewise-deletion option.",
            "Use by(group) cw after the comma. cw applies to every source variable in the command.",
          ],
          answerFeedback: [
            "Casewise deletion uses the command's source variables, not every variable in the dataset. Attendance is not included.",
            "A row missing hours also fails the common-sample requirement, even if its score is observed.",
            null,
          ],
        },
      ),
      numeric({
        title: "The common denominator",
        explanation:
          "Group A loses two different students under the common-sample requirement. Both summaries now refer to the same remaining observations. Casewise deletion makes the samples comparable but does not by itself correct selection bias from missing data.",
        task: "List group, n_hours and n_score in the collapsed dataset.",
        command: "list group n_hours n_score",
        question: "How many students contribute to each group A mean now?",
        response: {
          expected: 10,
          unit: "students",
          resultPath: ["rows", 0, "values", 1],
          mistakes: [
            {
              value: 11,
              message:
                "Eleven was the variablewise count. Two different group A students fail the common requirement.",
            },
            {
              value: 2,
              message:
                "Two is the number excluded from group A, not the number remaining.",
            },
          ],
        },
        feedback:
          "Ten group A students have both hours and score observed. Group B retains all twelve for these two variables.",
        hints: [
          "The counts are now variables in the summary dataset, so list can display them.",
          "Read n_hours or n_score for the row labeled A; both refer to the same ten students.",
        ],
      }),
      step(
        "Individual observations restored",
        "A summary dataset has a different observational unit. Regressions or graphs using it would concern group summaries rather than the original students. Restore before continuing an individual-level analysis.",
        "Restore the individual data and release the temporary preserved copy.",
        "restore",
        "Which description is correct after restoration?",
        [
          "The collapsed means are additional student rows",
          "The original 24 students are back; the summary columns are no longer in memory",
          "The two excluded students have been permanently deleted",
        ],
        1,
        "The original rows and variables are restored. The executed summaries remain in Results, where their captured source rows can still be inspected.",
        {
          hints: [
            "This time the temporary comparison is finished, so the preserved copy need not be retained.",
            "Use restore without an option.",
          ],
          answerFeedback: [
            "Summary rows are not students, and restore replaces rather than appends them.",
            null,
            "The casewise exclusions affected only the temporary summary calculation. The preserved rows remain available for restoration.",
          ],
        },
      ),
    ],
  },
];
