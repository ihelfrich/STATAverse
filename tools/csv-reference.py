"""Generate bounded public synthetic CSV fixtures with Python's csv module."""
import csv
import io
import json
import random
from pathlib import Path

rng = random.Random(20261104)
alphabet = list(' abcXYZ019,;\t"\n\ré<>&=')
cases = []
for delimiter in (",", "\t", ";"):
    for index in range(10):
        rows = [["id", "text", "value"]]
        rows.extend(
            [f"{row:03}", "".join(rng.choice(alphabet) for _ in range(rng.randrange(0, 60))), str(row / 7)]
            for row in range(1, 9)
        )
        stream = io.StringIO(newline="")
        csv.writer(stream, delimiter=delimiter, lineterminator="\r\n").writerows(rows)
        text = stream.getvalue()
        reread = list(csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, strict=True))
        assert reread == rows
        cases.append({"id": f"{ord(delimiter)}-{index}", "delimiter": delimiter, "text": text, "expected": reread})
target = Path(__file__).resolve().parents[1] / "tests/fixtures/csv-reference.json"
target.write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n")
print(f"Wrote {len(cases)} synthetic CSV cases")
