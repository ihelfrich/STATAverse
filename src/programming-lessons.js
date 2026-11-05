import { step } from "./lesson-schema.js";

export const PROGRAMMING_LESSONS = [
  {
    id: "macros-loops",
    title: "Repeated work with macros and loops",
    track: "data",
    level: "Do-files",
    minutes: 25,
    dataset: "study",
    runTogether: true,
    summary:
      "Write reusable commands, inspect their substitutions and distinguish program decisions from row filters.",
    steps: [
      step(
        "A variable name stored as text",
        "A local macro holds text that Stata inserts before interpreting a command. The opening character in a reference is a backtick; the closing character is an apostrophe. Here, `outcome' becomes score. Run the definition and the command together with Run all. Running only the second line starts a separate scope and loses the local.",
        "Define outcome as score, then summarize the variable named by that local.",
        "local outcome score\nsummarize `outcome'",
        "What does the local outcome contain?",
        ["The text score", "All 24 score values", "The mean of score"],
        0,
        "The local contains a variable name as text. summarize reads the score column only after that text has been substituted.",
        {
          hints: [
            "Use local followed by a name and the text it should hold.",
            "Write local outcome score, then summarize `outcome' on the next line. Run both lines together.",
          ],
          answerFeedback: [
            null,
            "A local does not hold this dataset's column. It holds text; the expanded command decides how to use that text.",
            "No calculation occurs in local outcome score. summarize calculates the mean after substituting the name.",
          ],
        },
      ),
      step(
        "Evaluate a value before substitution",
        "An equals sign changes a local definition: Stata evaluates the expression first. local scale = 60/7 stores a number; local scale 60/7 stores expression text. Substituting those into a larger expression can change its grouping. Parentheses make that distinction visible.",
        "Compare 2 divided by the evaluated value 60/7 with 2 divided by the substituted expression text.",
        "local evaluated = 60/7\nlocal text 60/7\ndisplay 2 / `evaluated'\ndisplay 2 / `text'",
        "Why do these two display commands return different numbers?",
        [
          "A local always rounds its contents to an integer",
          "Text substitution produces 2 / 60 / 7 in the second command",
          "display uses a different dataset on each line",
        ],
        1,
        "The evaluated local yields about 0.2333. The text local yields 2 / 60 / 7, about 0.004762. Use parentheses when substituting expression text whose grouping matters.",
        {
          hints: [
            "Define one local with = and one without it, then use the same surrounding expression for each.",
            "The second expanded command is display 2 / 60/7. Division proceeds from left to right.",
          ],
          answerFeedback: [
            "Evaluated numeric locals can hold decimals. The difference here comes from the expression formed after substitution.",
            null,
            "Both display expressions are constants. Neither reads a variable or changes the dataset.",
          ],
        },
      ),
      step(
        "Repeat a command over a list",
        "foreach assigns each list item to a local and executes the body with that value. Each summarize below uses its variable's available observations. The opening brace belongs at the end of the header; the closing brace belongs on its own line. Results show the commands after substitution.",
        "Summarize hours, score and attendance separately using one foreach block.",
        "local measures hours score attendance\nforeach v of local measures {\n summarize `v'\n}",
        "Which command runs on the second iteration?",
        ["summarize v", "summarize hours score attendance", "summarize score"],
        2,
        "On the second iteration, the loop local v contains score. The body becomes summarize score. The loop removes v when it ends; measures remains available until this run finishes.",
        {
          hints: [
            "Create the list before foreach and run the complete program together.",
            "Use foreach v of local measures, then refer to `v' inside the body.",
          ],
          answerFeedback: [
            "v is the local's name. The reference `v' is replaced before summarize looks for a data variable.",
            "Each iteration substitutes one item. The loop produces three separate summary commands.",
            null,
          ],
        },
      ),
      step(
        "Use the dataset's variable list",
        "foreach of varlist resolves names against the current dataset. This catches a misspelled variable before the loop executes. A range such as hours-attendance follows column order, not alphabetical order. A new variable can use the substituted name as part of its own name.",
        "Create copy_hours and copy_attendance, then list them beside their source columns.",
        "foreach v of varlist hours-attendance {\n generate double copy_`v' = `v'\n}\nlist id hours copy_hours attendance copy_attendance in 1/5",
        "What determines which variables hours-attendance includes?",
        [
          "Their order in the dataset",
          "Their numerical values",
          "Their alphabetical order",
        ],
        0,
        "The range runs from hours through attendance in the current column order. In these data those columns are adjacent. Reordering columns can change what a range includes.",
        {
          hints: [
            "Use foreach v of varlist hours-attendance to resolve the range before iterating.",
            "Inside the loop, generate double copy_`v' = `v' creates a different named column on each iteration.",
          ],
          answerFeedback: [
            null,
            "A varlist selects columns by their names and positions. It does not inspect observation values.",
            "Stata variable ranges follow the dataset's column order. They are not alphabetical ranges.",
          ],
        },
      ),
      step(
        "Generate powers with an integer loop",
        "forvalues supplies a sequence of integers. Substitution can put that integer in a variable name and in an expression. With p = 2/3, the loop executes twice. Missing hours produce missing powers; raising a missing value to a power does not recover it.",
        "Create hours2 and hours3, then inspect their values for the first five students.",
        "forvalues p = 2/3 {\n generate double hours`p' = hours^`p'\n}\nlist id hours hours2 hours3 in 1/5",
        "How many new columns does this loop create?",
        [
          "One: hoursp",
          "Two: hours2 and hours3",
          "Three: hours1, hours2 and hours3",
        ],
        1,
        "The inclusive range starts at 2 and ends at 3. Each iteration substitutes its integer into both the new name and the exponent.",
        {
          hints: [
            "Use forvalues p = 2/3 with a braced body.",
            "The body is generate double hours`p' = hours^`p'. Add the list command after the closing brace.",
          ],
          answerFeedback: [
            "The macro reference is replaced with an integer before the new variable name is read. The literal name hoursp is never created.",
            null,
            "The lower bound is 2. forvalues does not automatically start at 1.",
          ],
        },
      ),
      step(
        "A program decision and a row condition",
        "A programming if chooses whether to execute a block once. A data variable in that condition uses its first observation, which makes such conditions sensitive to sorting. An if qualifier or a generated comparison instead evaluates each row. Use _N when deciding whether a sample has observations, and use row conditions for observation-level decisions.",
        "Compare a block chosen using the first student's hours with a comparison evaluated separately for each student.",
        "if hours > 5 {\n generate double block_choice = 1\n}\nelse {\n generate double block_choice = 0\n}\ngenerate double row_choice = hours > 5 & !missing(hours)\nlist id hours block_choice row_choice in 1/5",
        "Why does student 5 have block_choice = 0 but row_choice = 1?",
        [
          "The if block examines all rows and averages their conditions",
          "Student 5 has missing hours",
          "The block used the first student's hours; row_choice used student 5's hours",
        ],
        2,
        "The first student has 2 hours, so the else block fills the entire block_choice column with zero. Student 5 has 6 hours, so that student's row comparison is true. The missing-value check prevents an unobserved value from counting as greater than 5.",
        {
          hints: [
            "Run the whole if/else structure together, then create row_choice outside the block.",
            "Use generate double row_choice = hours > 5 & !missing(hours) for the row-by-row comparison.",
          ],
          answerFeedback: [
            "A programming if evaluates one condition. A variable reference uses its first observation; it does not average conditions over rows.",
            "Student 5 has 6 observed hours. The discrepancy comes from which observation the program condition used.",
            null,
          ],
        },
      ),
    ],
  },
];
