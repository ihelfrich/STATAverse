const orders = {
  mode: "merge",
  example: "orders",
  keys: ["customer"],
  type: "m:1",
  keep: "all",
  overlap: "master",
  reverse: false,
  duplicate: false,
  missing: false,
};
const long = {
  mode: "reshape",
  direction: "long",
  stubs: ["score", "hours"],
  issue: "none",
};
const register = { ...orders, example: "overlap", type: "1:1" };
const number = (prompt, answer, metric) => ({
  type: "number",
  prompt,
  answer,
  metric,
});
const choice = (prompt, options, answer) => ({
  type: "choice",
  prompt,
  options,
  answer,
});

export const DATA_INVESTIGATIONS = [
  {
    id: "matching-records",
    title: "Matching records",
    level: "Beginner",
    minutes: 15,
    summary:
      "Identify a key, trace matches and decide which records belong in the result.",
    steps: [
      {
        id: "unique-side",
        title: "The unique side of a merge",
        setup: orders,
        reference: "orders",
        instruction:
          "Compare the customer column in Orders and Customers. The current m:1 declaration allows several orders to link to one customer record. Read the key audit below each source table.",
        hint: "Count distinct customer IDs in the using table. Its row count and distinct-key count agree.",
        question: number(
          "How many distinct customer keys are in the using table?",
          5,
          { kind: "distinctSource", side: "using", column: "customer" },
        ),
        explanation:
          "The using table contains five distinct customer keys and five rows. Repeated customer IDs in Orders are expected because a customer can place several orders. This is why the using side must be unique in this m:1 merge.",
      },
      {
        id: "repeated-customer",
        title: "Two orders, one customer",
        setup: orders,
        reference: "orders",
        instruction:
          "Select the result row for order 102. Compare its source trace with order 101: the orders occupy different master rows but share a customer record.",
        trace: { row: { order: 102 } },
        hint: "Order 102 is result row 2. The trace shows master row 2 and using row 1.",
        question: number("How many source orders belong to customer 1?", 2, {
          kind: "countSource",
          side: "master",
          where: { customer: 1 },
        }),
        explanation:
          "Orders 101 and 102 both match customer 1. The customer attributes are repeated in two result rows; the merge has not created a second customer in the source register.",
      },
      {
        id: "unmatched-order",
        title: "An order without a customer record",
        setup: orders,
        reference: "orders",
        instruction:
          "Select order 106 in the result. Use the trace to explain its empty region field and _merge value of 1.",
        trace: { row: { order: 106 } },
        hint: "Order 106 has customer key 9. Look for that key in the using table.",
        question: choice(
          "Why is region empty for order 106?",
          [
            "No using record has customer key 9.",
            "The matched customer record has a missing region.",
            "The amount is missing, so Stata discarded the region.",
          ],
          0,
        ),
        explanation:
          "The using table has no record for customer 9. Region comes only from that table, so the result has an empty string. This differs from a matched record whose region was already missing.",
      },
      {
        id: "retain-orders",
        title: "Retain the original orders",
        setup: orders,
        target: { keep: "master" },
        reference: "keep-master",
        instruction:
          "You need one result row for every source order, including orders without a customer match. Change Rows to retain to the option that preserves those records and excludes customers with no order.",
        hint: "Choose Rows with a master record. Matched rows only would also remove order 106.",
        question: number("How many result rows remain?", 7, {
          kind: "retainedRows",
        }),
        explanation:
          "Seven rows remain: six matched orders and order 106. The customer-only row for customer 5 is excluded. The retention rule follows the intended observational unit rather than treating every unmatched record as an error.",
      },
      {
        id: "composite-key",
        title: "A key with two variables",
        setup: { ...orders, example: "terms", type: "1:1", keys: ["id"] },
        target: { keys: ["id", "term"] },
        reference: "composite-key",
        instruction:
          "The scores and attendance example starts with an invalid 1:1 merge on id alone. Each student appears in several terms. Add the variable that distinguishes those records, then inspect the merge categories.",
        hint: "Select both id and term as key variables. Neither source may repeat the complete student–term pair.",
        question: number(
          "How many result rows have records in both sources?",
          4,
          { kind: "matchedRows" },
        ),
        explanation:
          "Four student–term pairs match. Student 2 in term 2 has only a score record; student 3 in term 2 has only an attendance record. Matching on id alone would not identify which term belongs with which record.",
      },
      {
        id: "missing-identity",
        title: "A match without an observed key",
        setup: { ...orders, missing: true },
        reference: "orders-missing-key",
        instruction:
          "A row with a missing customer key has been added to each source. Select the merged row whose customer is a dot, then inspect both contributing records.",
        trace: { row: { customer: null } },
        hint: "The missing-key match appears after the observed numeric keys. It has a record in both sources.",
        question: choice(
          "What does this successful match establish?",
          [
            "Both records belong to the same customer.",
            "Both key values are missing; their real-world identity remains unresolved.",
            "Stata found the correct customer from the other variables.",
          ],
          1,
        ),
        explanation:
          "Stata matches identical missing key values. It does not infer customer identity from the amount or region. A technically successful match therefore still needs a substantive review of the sources.",
      },
    ],
  },
  {
    id: "repeated-measurements",
    title: "Reshaping repeated measurements",
    level: "Beginner to intermediate",
    minutes: 15,
    summary:
      "Follow values between wide and long layouts and distinguish different sources of missingness.",
    steps: [
      {
        id: "term-index",
        title: "From a suffix to an index",
        setup: long,
        reference: "reshape-long-none",
        instruction:
          "Select the term cell with value 2 in result row 2. The suffixes in score2 and hours2 have become a value of term. Compare the number of students with the number of rows.",
        trace: { row: { id: 1, term: 2 }, column: "term" },
        hint: "Select the 2 in the term column, rather than either measurement. The trace will identify a column suffix.",
        question: number(
          "How many distinct students are in the long result?",
          3,
          { kind: "distinctResult", column: "id" },
        ),
        explanation:
          "The result has six rows but still three students. Each student now has two term rows. Treating all six rows as independent students would confuse the layout with the sampling unit.",
      },
      {
        id: "measurement-cell",
        title: "Follow one measurement",
        setup: long,
        reference: "reshape-long-none",
        instruction:
          "Select the score of 75 for student 1 in term 2. Follow the highlighted source cell.",
        trace: { row: { id: 1, term: 2 }, column: "score" },
        hint: "The source row remains student 1; the term determines which numbered score column supplies the value.",
        question: choice(
          "Which source column supplies this score?",
          ["score1", "score2", "hours2"],
          1,
        ),
        explanation:
          "score2 supplies the value 75. Reshaping changes where the measurement is stored; it does not average the scores or calculate a new value.",
      },
      {
        id: "observed-missing",
        title: "A missing value already in the source",
        setup: long,
        reference: "reshape-long-none",
        instruction:
          "Select the missing score for student 2 in term 2. Inspect the source cell identified by the trace.",
        trace: { row: { id: 2, term: 2 }, column: "score" },
        hint: "The wide source has a score2 column, and the cell for student 2 contains a dot.",
        question: choice(
          "Why is this result value missing?",
          [
            "The score2 column was absent.",
            "Student 2 had no source row.",
            "The source cell existed and was already missing.",
          ],
          2,
        ),
        explanation:
          "The source cell exists but contains an ordinary numeric missing value. Reshape preserves it. Its origin differs from a cell created because a source column or repeated record is absent.",
      },
      {
        id: "absent-column",
        title: "A measurement column is absent",
        setup: { ...long, issue: "gap" },
        reference: "reshape-long-gap",
        instruction:
          "The hours2 column has been removed from the source. Select hours for student 1 in term 2, then inspect the same term for the other students.",
        trace: { row: { id: 1, term: 2 }, column: "hours" },
        hint: "The score2 column still establishes term 2. Each student therefore needs an hours cell for that term even though no hours2 column exists.",
        question: number(
          "How many hours values are missing because that source column is absent?",
          3,
          { kind: "countResult", where: { hours: null } },
        ),
        explanation:
          "Three hours cells are missing, one for each student in term 2. The selected score family supplies that term index. Reshape completes the layout with missing values; it does not invent study-hour measurements.",
      },
      {
        id: "all-measurements",
        title: "Carry both measurements into wide data",
        setup: { ...long, direction: "wide", stubs: ["score"] },
        target: { stubs: ["score", "hours"] },
        reference: "reshape-wide-none",
        instruction:
          "This long-to-wide attempt selects only score. Hours varies within each student and cannot remain a single constant column. Add the other measurement family to preserve both terms of study hours.",
        hint: "Select hours as well as score. The wide result should contain score1, score2, hours1 and hours2.",
        question: number("How many rows should the wide result contain?", 3, {
          kind: "retainedRows",
        }),
        explanation:
          "Each of the three students occupies one wide row. Scores and hours become term-specific columns. A variable outside the stubs must agree across a student's source rows if it is to remain one column.",
      },
      {
        id: "changing-group",
        title: "Preserve a changing attribute",
        setup: { ...long, direction: "wide", issue: "varying" },
        target: { stubs: ["score", "hours", "group"] },
        reference: "reshape-wide-varying-included",
        instruction:
          "Student 1 changes group from A to B. Include group among the stubs, then select group2 for student 1 to verify that both group values have been retained.",
        trace: { row: { id: 1 }, column: "group2" },
        hint: "Select the group checkbox. The result will have separate group1 and group2 columns.",
        question: choice(
          "What still needs a substantive decision?",
          [
            "Whether the change in group is valid or a source-data error.",
            "Whether Stata is allowed to keep string measurements.",
            "Whether one of the two group values should automatically be deleted.",
          ],
          0,
        ),
        explanation:
          "The reshaped result preserves the change; it does not explain it. If group membership should be fixed, investigate the source. If membership legitimately changes, term-specific group columns retain that information.",
      },
    ],
  },
  {
    id: "merge-decisions",
    title: "Conflicting values and sample decisions",
    level: "Intermediate",
    minutes: 15,
    summary:
      "Compare master retention, update and replacement, then examine what an altered key excludes.",
    steps: [
      {
        id: "default-overlap",
        title: "A matched record can contain a conflict",
        setup: register,
        reference: "overlap-master",
        instruction:
          "Select customer 3. The master has region West and a missing age; the using record has region North and age 35. Inspect what the default merge retains.",
        trace: { row: { customer: 3 } },
        hint: "The default retains overlapping master values, including missing values. The trace shows both versions.",
        question: number(
          "What is _merge for customer 3 under the default rule?",
          3,
          { kind: "resultValue", where: { customer: 3 }, column: "_merge" },
        ),
        explanation:
          "The default merge reports code 3 because the key matched. It retains West and a missing age. Code 3 alone does not establish that overlapping values agree.",
      },
      {
        id: "fill-missing",
        title: "Fill a missing master value",
        setup: register,
        target: { overlap: "update" },
        reference: "overlap-update",
        instruction:
          "Choose Fill missing master values, then select customer 2. Compare the empty master region with South in the using record.",
        trace: { row: { customer: 2 } },
        hint: "The update rule fills the missing region. Neither observed age conflicts with the other.",
        question: choice(
          "What does _merge = 4 mean for this record?",
          [
            "The record was unmatched.",
            "At least one missing master value was filled and no observed values conflicted.",
            "Four fields were changed.",
          ],
          1,
        ),
        explanation:
          "The region becomes South and age stays 40. Code 4 describes the update outcome for this matched record; it is not a count of changed fields.",
      },
      {
        id: "conflict-precedence",
        title: "A fill and a conflict in the same row",
        setup: { ...register, overlap: "update" },
        reference: "overlap-update",
        instruction:
          "Select customer 3 under the update rule. Age is filled, but the two observed region values conflict. Inspect the retained values and the merge code.",
        trace: { row: { customer: 3 } },
        hint: "A conflict in any overlapping variable takes precedence over a successful fill elsewhere in the same row.",
        question: number("What is _merge for customer 3 with update?", 5, {
          kind: "resultValue",
          where: { customer: 3 },
          column: "_merge",
        }),
        explanation:
          "Code 5 records the region conflict even though age was filled with 35. Update retains the observed master region West. A code 5 row may therefore contain both a conflict and an update.",
      },
      {
        id: "missing-using",
        title: "Replacement does not erase observed values",
        setup: { ...register, overlap: "update" },
        target: { overlap: "replace" },
        reference: "overlap-replace",
        instruction:
          "Choose Fill missing and replace conflicts. Inspect customer 3 to see the region replacement, then select customer 4, whose using region and age are missing.",
        trace: { row: { customer: 4 } },
        hint: "Update replace can replace an observed conflict with an observed using value. A missing using value does not replace an observed master value.",
        question: number("What age remains for customer 4?", 50, {
          kind: "resultValue",
          where: { customer: 4 },
          column: "age",
        }),
        explanation:
          "Age remains 50 and region remains East for customer 4. The replacement rule does not erase them with missing using values. Choosing that rule still requires a reason to prefer the using source when observed values conflict.",
      },
      {
        id: "overdefined-key",
        title: "Adding attributes changes the match",
        setup: { ...register, keep: "matched" },
        target: { keys: ["customer", "region", "age"] },
        reference: "no-matches-retained",
        instruction:
          "Keep Matched rows only, then add region and age to the key. These sources disagree on at least one of those attributes for every shared customer. Inspect the resulting sample.",
        hint: "Select customer, region and age together. The merge now requires the complete tuple to agree.",
        question: number("How many matched rows remain?", 0, {
          kind: "retainedRows",
        }),
        explanation:
          "No rows remain. The new key has changed the definition of a match; it has not resolved the disagreements. Attributes that need comparison should not automatically become identifying keys merely to suppress conflicts.",
      },
    ],
  },
];

export const investigationTarget = (step) => ({
  ...structuredClone(step.setup),
  ...structuredClone(step.target || {}),
});
const responseFeedback = {
  "unmatched-order": {
    1: "A matched record would show a using row in the trace. Customer 9 has no using record, so region has no source value to copy.",
    2: "Order 106 has amount 35. Amount is not a merge key here and does not determine whether region is copied.",
  },
  "missing-identity": {
    0: "Equality of two missing keys does not identify a customer. The merge supplies no evidence that these records belong to the same person.",
    2: "This merge compares only customer, the selected key. It does not search amount or region for an alternative identity.",
  },
  "measurement-cell": {
    0: "score1 supplies term 1, whose score for this student is 60. The selected row is term 2.",
    2: "hours2 supplies the study-hours measurement. Reshape keeps score and hours as separate families.",
  },
  "observed-missing": {
    0: "score2 exists in the wide table. Its cell for student 2 is a dot; the trace points to that existing cell.",
    1: "Student 2 appears in source row 2. Its other measurements remain available even though score2 is missing.",
  },
  "changing-group": {
    1: "The successful result already contains string columns group1 and group2. The unresolved issue is why membership changed.",
    2: "Reshape preserves both group values. Deleting one would discard a change that may be valid; investigate the source before deciding.",
  },
  "fill-missing": {
    0: "The trace identifies records in both sources. Codes 1 and 2 describe unmatched records; this row received an update.",
    2: "The merge code classifies the outcome. It does not count changes: only region was filled in this row.",
  },
};
const same = (a, b) =>
  Array.isArray(b)
    ? Array.isArray(a) &&
      a.length === b.length &&
      [...a].sort().every((x, i) => x === [...b].sort()[i])
    : a === b;
export function assessInvestigation(
  step,
  { settings, result, selected, traceTouched },
  answer,
) {
  const target = investigationTarget(step);
  if (
    Object.entries(target).some(([key, value]) => !same(settings[key], value))
  )
    return {
      passed: false,
      kind: "settings",
      message:
        "The current settings do not yet match this task. Follow the instruction above; the hint identifies the relevant control.",
    };
  if (!result)
    return {
      passed: false,
      kind: "result",
      message: "Resolve the operation error before checking this answer.",
    };
  if (step.trace) {
    const row = result.data.rows[selected.row],
      column = result.data.columns[selected.column]?.name;
    if (
      !traceTouched ||
      !row ||
      Object.entries(step.trace.row).some(
        ([key, value]) => row[key] !== value,
      ) ||
      (step.trace.column && column !== step.trace.column)
    )
      return {
        passed: false,
        kind: "trace",
        message:
          "Select the requested result row or cell so its source appears in the trace, then check again.",
      };
  }
  const question = step.question;
  const valid =
    question.type === "number"
      ? typeof answer === "string" &&
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(answer.trim()) &&
        Number(answer) === question.answer
      : typeof answer === "string" && answer === String(question.answer);
  if (!valid)
    return {
      passed: false,
      kind: "answer",
      message:
        question.type === "number"
          ? "That value does not agree with the current result. Use the source and result tables, then enter a number without units."
          : responseFeedback[step.id]?.[answer] ||
            "Choose an interpretation, using the source trace and the result as evidence.",
    };
  return { passed: true, kind: "passed", message: step.explanation };
}
