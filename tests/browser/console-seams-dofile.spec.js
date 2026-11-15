import { test, expect } from "@playwright/test";

// A do-file run in the Console is echoed as Stata 19's log echoes it: its
// comments and blank lines are lines of their own, with no blank line after
// them, each command is shown as typed, and a command wider than the
// linesize goes on after "> ". The expected text is Stata 19's log of the
// same do-file (version 17, linesize 79), blank lines and all.

async function ready(page) {
  await page.goto("/Console/");
  await expect(page.locator("#console-status")).toHaveText("Ready.");
}

test("a do-file's comments, blank lines and long lines are shown as Stata's log shows them", async ({
  page,
}) => {
  await ready(page);
  await page
    .locator("#console-source")
    .fill(
      [
        "* star comment",
        "",
        "// slash comment",
        'display "a" // trailing',
        "/* block",
        "   comment */",
        'display "b" /* inline */',
        "* star comment ///",
        'display "swallowed"',
        'display "this is a quite long string that goes past the seventy-nine character line limit of the log"',
        "",
      ].join("\n"),
    );
  await page.locator("#console-run").click();
  // Comments are not counted as commands.
  await expect(page.locator("#console-status")).toContainText("Ran 3 commands");
  // Each record as the page draws it: its command lines, what it printed,
  // and the blank line a command (not a comment) is followed by.
  const shown = await page.locator("#console-output").evaluate((node) =>
    [...node.querySelectorAll(".console-record")]
      .flatMap((record) => [
        ...record.querySelector(".console-command").textContent.split("\n"),
        ...(record.querySelector(".console-lines")?.textContent ?? "")
          .split("\n")
          .slice(0, -1),
        // A blank line ends the record when its text ends in two line
        // breaks: one that ends its last line, and one of its own.
        ...(record.textContent.endsWith("\n\n") ? [""] : []),
      ])
      .join("\n"),
  );
  expect(shown).toContain(
    [
      ". * star comment",
      ".",
      ". // slash comment",
      '. display "a" // trailing',
      "a",
      "",
      ". /* block",
      ">    comment */",
      '. display "b" /* inline */',
      "b",
      "",
      ". * star comment ///",
      '> display "swallowed"',
      '. display "this is a quite long string that goes past the seventy-nine characte',
      '> r line limit of the log"',
    ].join("\n"),
  );
  expect(shown).not.toContain("\nswallowed");
});
