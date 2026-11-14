// The message Stata prints for the command error #, recorded from Stata 19
// (version 17) by running capture noisily error # for every code from 1 to
// 9,999. A code not listed prints only its return code. Code 914 (which
// names the computer's temporary directory) is left out.

/** Codes with a one-line message; [first, last, text] covers a run. */
const ONE_LINE = [
  [2, "connection timed out"],
  [3, "no dataset in use"],
  [4, "no; dataset in memory has changed since last saved"],
  [5, "not sorted"],
  [18, "you must start with an empty dataset"],
  [100, 101, "invalid syntax"],
  [102, "too few variables specified"],
  [103, "too many variables specified"],
  [104, "nothing to input"],
  [106, "type mismatch"],
  [107, "not possible with numeric variable"],
  [108, "not possible with string variable"],
  [109, "type mismatch"],
  [110, 111, "invalid syntax"],
  [119, "statement out of context"],
  [120, "invalid %format"],
  [121, "invalid numlist"],
  [122, "invalid numlist has too few elements"],
  [123, "invalid numlist has too many elements"],
  [124, "invalid numlist has elements out of order"],
  [125, "invalid numlist has elements outside of allowed range"],
  [126, "invalid numlist has noninteger elements"],
  [127, "invalid numlist has missing values"],
  [130, "expression too long"],
  [131, "not possible with test"],
  [132, 133, "invalid syntax"],
  [134, "too many values"],
  [135, "not possible with weighted data"],
  [140, "repeated categorical variable in term"],
  [141, "repeated term"],
  [142, "attempt to classify extraneous variable"],
  [143, "variable left unclassified"],
  [144, "variable classified inconsistently"],
  [145, "term contains more than 8 variables"],
  [147, "term not in model"],
  [148, "too few categories"],
  [149, "too many categories"],
  [151, "non r-class program may not set r()"],
  [152, "non e-class program may not set e()"],
  [153, "non s-class program may not set s()"],
  [161, "ado-file has commands outside of program define ... end"],
  [162, "ado-file does not define command"],
  [170, "unable to chdir"],
  [171, "internal FV error: FV information not complete"],
  [172, "internal FV error: FV terms not parsed"],
  [173, "internal FV error: out of range for FV terms"],
  [174, "internal FV error: out of range for FV ivars"],
  [175, "factor level out of range"],
  [176, "internal MS error: generic"],
  [180, "invalid attempt to modify label"],
  [181, "may not label strings"],
  [182, "not labeled"],
  [184, "may not be combined"],
  [190, "request may not be combined with by"],
  [191, "request may not be combined with by() option"],
  [196, "could not restore sort order because variables were dropped"],
  [197, 198, "invalid syntax"],
  [199, "unrecognized command"],
  [301, "last estimates not found"],
  [302, "last test not found"],
  [303, "equation not found"],
  [304, 305, "ml model not found"],
  [310, "not possible because object(s) in use"],
  [321, "requested action not valid after most recent estimation command"],
  [322, "something that should be true of your estimation results is not"],
  [401, "may not use noninteger frequency weights"],
  [402, "negative weights encountered"],
  [403, "may not specify norobust with pweights"],
  [404, "not possible with pweighted data"],
  [406, "not possible with analytic weights"],
  [407, "weights must be the same for all observations in a group"],
  [411, "nonpositive values encountered"],
  [412, "redundant or inconsistent constraints"],
  [421, "could not determine between-subject error term; use bse() option"],
  [422, "could not determine between-subject basic unit; use bseunit() option"],
  [430, "convergence not achieved"],
  [450, "0/1 variable required"],
  [451, "invalid values for time variable"],
  [452, "invalid values for factor variable"],
  [459, "something that should be true of your data is not"],
  [460, "fpc must be >= 0"],
  [461, "fpc for all observations within a stratum must be the same"],
  [
    462,
    "fpc must be <= 1 if a rate, or >= no. sampled units per stratum if unit totals",
  ],
  [463, "sum of weights equals zero"],
  [464, "poststratum weights must be constant within poststrata"],
  [465, "poststratum weights must be >= 0"],
  [466, "standardization weights must be constant within standard strata"],
  [467, "standardization weights must be >= 0"],
  [471, "esample() invalid"],
  [481, "equation/system not identified"],
  [501, "matrix operation not found"],
  [503, "conformability error"],
  [504, "matrix has missing values"],
  [505, "matrix not symmetric"],
  [506, "matrix not positive definite"],
  [507, "name conflict"],
  [508, "matrix has zero values on diagonal"],
  [509, "matrix operators that return matrices not allowed in this context"],
  [601, "file not found"],
  [602, "file already exists"],
  [603, "file could not be opened"],
  [604, "log file already open"],
  [606, "no log file open"],
  [607, "no cmdlog file open"],
  [608, "file is read-only; cannot be modified or erased"],
  [609, "file xp format"],
  [610, "file not Stata format"],
  [611, "record too long"],
  [612, "unexpected end of file"],
  [613, "file does not contain dictionary"],
  [614, "dictionary invalid"],
  [615, "cannot determine separator -- use tab or comma option"],
  [616, "wrong number of values in checksum file"],
  [621, "already preserved"],
  [622, "nothing to restore"],
  [631, "host not found"],
  [632, "web filename not supported in this context"],
  [633, "may not write files over internet"],
  [639, "file transmission error (checksums do not match)"],
  [640, "package file too long"],
  [641, "package file invalid"],
  [651, "may not seek past end of file"],
  [660, "proxy host not found"],
  [662, "proxy server refused request to send"],
  [663, "remote connection to proxy failed"],
  [665, "could not set socket nonblocking"],
  [667, "wrong version winsock.dll"],
  [668, "could not find a valid winsock.dll"],
  [669, "invalid URL"],
  [670, "invalid network port number"],
  [671, "unknown network protocol"],
  [672, "server refused to send file"],
  [673, "authorization required by server"],
  [674, "unexpected response from server"],
  [675, "server reported server error"],
  [676, "server refused request to send"],
  [677, "remote connection failed"],
  [678, "could not open local network socket"],
  [681, "too many open files"],
  [682, "could not connect to odbc dsn"],
  [683, "could not fetch variable in odbc table"],
  [688, "file is corrupt"],
  [691, "I/O error"],
  [692, "file I/O error on read"],
  [693, "file I/O error on write"],
  [694, "could not rename file"],
  [695, "could not copy file"],
  [699, "insufficient disk space"],
  [702, "op. sys. refused to start new process"],
  [703, "op. sys. refused to open pipe"],
  [791, "system administrator will not allow you to change this setting"],
  [909, "op. sys. refuses to provide memory"],
  [910, "value too small"],
  [912, "value too large"],
  [920, "macro substitution results in line that is too long"],
  [950, "insufficient memory"],
  [1000, "system limit exceeded - see manual"],
  [1001, "too many values"],
  [1002, "too many by variables"],
  [1003, "too many options"],
  [1004, "command too long"],
  [1400, "numerical overflow"],
  [2000, "no observations"],
  [2001, "insufficient observations"],
  [2002, "all observations predicted perfectly"],
  [3000, "Mata compile-time error"],
  [3001, 3999, "Mata run-time error"],
  [4000, "class system limit exceeded"],
  [4001, "class-system reference out of range"],
  [4002, "class-system reference not defined"],
  [4003, "invalid class-system reference"],
  [4005, "invalid type usage"],
  [4006, "invalid attribute type"],
  [4007, "no current class context"],
  [4008, "too many class keys"],
  [4009, "invalid class reference or reference found where not expected"],
  [4010, "class key not found"],
  [4011, "name too long"],
  [4012, "name not found"],
  [4013, "not a class type"],
  [4014, "not a class"],
  [4015, "class types are not the same"],
  [4017, "name already declared in current class"],
  [4018, "class type not found"],
  [4019, "source and target types are not compatible"],
  [4020, "not an array"],
  [4022, "no active class"],
  [4023, "class member function not found"],
  [4025, "clone creator may only be used with classes"],
  [4026, "rvalue invalid"],
  [4027, "incompatible types"],
  [4028, "target of assignment no longer available"],
  [4029, "invalid array reference"],
  [4030, "invalid array initializer"],
  [4031, "already exists"],
  [4050, "class system failure"],
  [4051, "class context out of range"],
  [4052, "class element too large to store"],
  [4099, "system failure in .class files"],
  [5000, "Java not available on this platform"],
  [5001, "unable to allocate memory for Java virtual machine"],
  [5002, "failure to dynamically load Java runtime library"],
  [5003, "unable to create Java virtual machine"],
  [5004, "Java installation not found"],
  [5005, "unable to attach to existing Java virtual machine"],
  [5006, "Java class not specified"],
  [5007, "Java method not specified"],
  [5008, "Java virtual machine is not available at this time"],
  [5051, "value null where non-null value expected"],
  [5100, "a Java runtime exception occurred"],
  [5101, "a general error occurred while executing Java code"],
  [6101, "time-series operators not allowed"],
  [6102, "factor-variable operators not allowed"],
  [6103, "interaction operators not allowed"],
  [6104, "factor-variable and time-series operators not allowed"],
  [6105, "o. operator not allowed"],
  [6106, "iweights not allowed with robust"],
  [7196, "invalid attempt to modify label"],
  [7197, "invalid file specification"],
  [7198, "multiple by's not allowed"],
  [8001, "irrelevant under Unix"],
  [8002, "request ignored because of batch mode"],
  [8003, "request ignored because this feature has been disabled by your site"],
  [8005, "note: not possible in Stata(console)"],
  [9000, "system failure"],
  [9196, "could not restore sort index -- system header not found"],
];

/**
 * Codes whose message goes on below its first line: paragraphs indented by
 * four and wrapped to the line size less two, a blank line between them, or
 * lines printed as they are.
 */
const EXTENDED = {
  146: {
    head: "too many variables or values (matsize too small)",
    paragraphs: [
      "You can increase matsize using the set matsize command; see help matsize.",
    ],
  },
  900: {
    head: "no room to add more variables",
    paragraphs: [
      "Up to 5,000 variables are currently allowed, although you could reset the maximum using set maxvar; see help memory.",
    ],
  },
  901: {
    head: "no room to add more observations",
    paragraphs: [
      "Up to 1,099,511,627,775 observations are allowed if you have enough memory.",
    ],
  },
  902: {
    head: "no room to add more variables because of width",
    paragraphs: [
      "Width refers to the number of bytes required to store a single observation; it is the sum of the widths of the individual variables.  The maximum width allowed is 1,048,576 bytes.  You just attempted to exceed that.",
    ],
  },
  903: {
    head: "no room to promote variable (e.g., change int to float) because of width",
    paragraphs: [
      "Width refers to the number of bytes required to store a single observation; it is the sum of the widths of the individual variables.  The maximum width allowed is 1,048,576 bytes.  You just attempted to exceed that.",
    ],
  },
  907: {
    head: "maxvar too small",
    paragraphs: [
      "You have attempted to use an interaction with too many levels or attempted to fit a model with too many variables.  You need to increase maxvar; it is currently 5000.  Use set maxvar; see help maxvar.",
      "If you are using factor variables and included an interaction that has lots of missing cells, try set emptycells drop to reduce the required matrix size; see help set emptycells.",
      "If you are using factor variables, you might have accidentally treated a continuous variable as a categorical, resulting in lots of categories.  Use the c. operator on such variables.",
    ],
  },
  908: {
    head: "matsize too small",
    paragraphs: [
      "You have attempted to create a matrix with too many rows or columns or attempted to fit a model with too many variables.  You need to increase matsize; it is currently 400.  Use set matsize; see help matsize.",
      "If you are using factor variables and included an interaction that has lots of missing cells, try set emptycells drop to reduce the required matrix size; see help set emptycells.",
      "If you are using factor variables, you might have accidentally treated a continuous variable as a categorical, resulting in lots of categories.  Use the c. operator on such variables.",
    ],
  },
  913: {
    head: "op. sys. refuses to provide sufficient memory;",
    fixed: [
      "    op. sys. provided base request, but then refused to provide",
      "    sufficient memory for matsize",
    ],
  },
  915: {
    head: "unable to allocate matrix;",
    paragraphs: [
      "You have attempted to create a matrix with too many rows or columns or attempted to fit a model with too many variables.",
      "You are using Stata/MP which supports matrices with up to 65534 rows or columns.  This is the maximum matrix size.",
      "If you are using factor variables and included an interaction that has lots of missing cells, try set emptycells drop to reduce the required matrix size; see help set emptycells.",
      "If you are using factor variables, you might have accidentally treated a continuous variable as a categorical, resulting in lots of categories.  Use the c. operator on such variables.",
    ],
  },
  916: {
    head: "unable to allocate matrix;",
    paragraphs: [
      "You have attempted to create a matrix with too many rows or columns or attempted to fit a model with too many variables.",
      "Assuming that you are not playing with set max_memory, your system administrator froze the max_memory setting at its current value.  Contact your system administrator if you need to change this setting.",
      "If you are using factor variables and included an interaction that has lots of missing cells, try set emptycells drop to reduce the required matrix size; see help set emptycells.",
      "If you are using factor variables, you might have accidentally treated a continuous variable as a categorical, resulting in lots of categories.  Use the c. operator on such variables.",
    ],
  },
  4024: {
    head: "creators new, clone, clone1, copy, and reference may not be combined",
    fixed: [" with super"],
  },
  5009: {
    head: "error finding Java/JShell integration classes",
    paragraphs: [
      "To use Java/JShell integration, java_home must be set to use a JDK; perhaps java_home is set to use a JRE instead.",
    ],
  },
};

/** The first line of each code's message. */
export const STANDARD_MESSAGES = {};
for (const entry of ONE_LINE) {
  const [first, last, text] =
    entry.length === 2 ? [entry[0], entry[0], entry[1]] : entry;
  for (let code = first; code <= last; code++) STANDARD_MESSAGES[code] = text;
}
for (const [code, { head }] of Object.entries(EXTENDED))
  STANDARD_MESSAGES[code] = head;

/**
 * A paragraph broken into lines of at most width characters, indented by
 * four. The two spaces Stata leaves after a sentence are kept, except where
 * a line breaks.
 */
function wrap(paragraph, width) {
  const out = [];
  let line = "";
  for (const word of paragraph.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && word && 4 + next.trimEnd().length > width) {
      out.push(line.trimEnd());
      line = word;
    } else if (line || word) line = next;
  }
  if (line) out.push(line.trimEnd());
  return out.map((text) => `    ${text}`);
}

/**
 * Stata's message for the return code, as error # prints it at the given
 * line size, or "" for a code it has no message for.
 */
export function standardMessage(code, linesize = 80) {
  const extended = EXTENDED[code];
  if (!extended) return STANDARD_MESSAGES[code] ?? "";
  const body = extended.fixed
    ? extended.fixed
    : extended.paragraphs.flatMap((paragraph, k) => [
        ...(k ? [""] : []),
        ...wrap(paragraph, linesize - 2),
      ]);
  return [extended.head, ...body].join("\n");
}
