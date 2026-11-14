import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";
import { addTextFile, parseDelimitedText } from "../src/runtime/delimited.js";
import { MISSING } from "../src/runtime/values.js";

// The results here are those Stata 19 gives for the same files; the wider
// set recorded from Stata 19 is in runtime-userdata-delimited.test.mjs.
const CSV =
  'ID,Name,Score,Weight,Note\n1,"Smith, Ann",71.5,60,"said ""hi"""\n2,Bo,,70000,\n3,Cy,80,3000000000,plain\n';
const session = (text = CSV, name = "people.csv") => {
  const s = new Session();
  addTextFile(s, name, text);
  return s;
};

test("import delimited reads names, types, quotes and missing values", () => {
  const s = session(),
    result = s.run('import delimited using "people.csv", clear');
  assert.equal(result.rc, 0);
  assert.deepEqual(result.output[0].lines, [
    "(encoding automatically selected: ISO-8859-1)",
    "(5 vars, 3 obs)",
  ]);
  assert.deepEqual(
    s.data.variables.map((v) => [v.name, v.type]),
    [
      ["id", "byte"],
      ["name", "str10"],
      ["score", "float"],
      ["weight", "double"],
      ["note", "str9"],
    ],
  );
  assert.deepEqual(s.data.get("name").data, ["Smith, Ann", "Bo", "Cy"]);
  assert.deepEqual(s.data.get("note").data, ['said "hi"', "", "plain"]);
  assert.deepEqual(Array.from(s.data.get("score").data), [71.5, MISSING, 80]);
  assert.equal(s.data.get("id").label, "ID");
});

test("import delimited options and refusals", () => {
  assert.deepEqual(
    session().run("import delimited people.csv, case(preserve) clear") && null,
    null,
  );
  const preserve = session();
  preserve.run("import delimited people.csv, case(preserve)");
  assert.deepEqual(preserve.data.names, [
    "ID",
    "Name",
    "Score",
    "Weight",
    "Note",
  ]);
  const none = session("1;2.5;x\n3;4;y\n", "plain.txt");
  none.run('import delimited "plain.txt"');
  assert.deepEqual(none.data.names, ["v1", "v2", "v3"]);
  assert.equal(none.data.n, 2);
  const tab = session("a\tb\n1\t2\n", "t.tsv");
  tab.run("import delimited t.tsv, delimiters(tab)");
  assert.deepEqual(tab.data.names, ["a", "b"]);
  const strings = session();
  strings.run("import delimited people.csv, stringcols(1)");
  assert.equal(strings.data.get("id").type, "str1");
  assert.equal(session().run("import delimited nosuch.csv").rc, 601);
  // import excel exists now; Stata 19 cannot load a CSV as a workbook, r(603).
  assert.equal(session().run("import excel people.csv").rc, 603);
  const busy = session();
  assert.equal(
    busy.run("clear\nset obs 1\ngenerate x = 1\nimport delimited people.csv")
      .rc,
    4,
  );
  assert.equal(busy.run("import delimited people.csv, clear").rc, 0);
  assert.equal(busy.run("use people.csv, clear").rc, 610);
});

test("export delimited writes what import delimited reads back", () => {
  const s = session();
  s.run("import delimited people.csv\nexport delimited using out.csv\n");
  assert.equal(s.run("export delimited using out.csv").rc, 602);
  const text = s.files.get("out.csv").text;
  assert.equal(text.split("\n")[1], '1,"Smith, Ann",71.5,60,"said ""hi"""');
  const before = JSON.stringify(
    s.data.variables.map((v) => [v.name, v.type, Array.from(v.data)]),
  );
  s.run("import delimited out.csv, clear");
  assert.equal(
    JSON.stringify(
      s.data.variables.map((v) => [v.name, v.type, Array.from(v.data)]),
    ),
    before,
  );
  const listing = s.run("dir").output[0].lines.join("\n");
  assert.match(listing, /out\.csv/);
  assert.match(listing, /people\.csv/);
});

test("the delimited parser handles line endings and embedded newlines", () => {
  const rows = parseDelimitedText('a,b\r\n"x\ny",2\r\n\r\n3,4', ",");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["x\ny", "2"],
    ["3", "4"],
  ]);
});
