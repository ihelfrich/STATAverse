"""Run bundled teaching scripts in disposable directories; never publish license logs.

Uses an existing licensed Stata installation. No packages or Java are installed.
--csv-fallback substitutes insheet for import delimited in temporary project copies
when the local Stata Java runtime is unavailable; receipts disclose that change.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--executable', default='/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp')
parser.add_argument('--output', default='docs/verification/stata-script-audit.json')
parser.add_argument('--csv-fallback', action='store_true')
parser.add_argument('--only', help='Run only paths containing this text')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
destination = Path(tempfile.mkdtemp(prefix='stataverse-native-check-'))
scripts = sorted((root / 'CodeLibrary/scripts').glob('*.do'))
scripts += sorted((root / 'ZeroToHero/projects').glob('*/analysis.do'))
scripts += [root / 'tools/stata-snippets.do']
if args.only:
    scripts = [path for path in scripts if args.only in str(path.relative_to(root))]
    if not scripts:
        parser.error('--only matched no scripts')
results = []
for index, source in enumerate(scripts):
    folder = destination / str(index)
    folder.mkdir()
    text = source.read_text()
    changes = []
    if source.name == 'analysis.do':
        text = text.replace('local data_dir "data"', f'local data_dir "{root / "ZeroToHero/data"}"')
        changes.append('data_dir resolved to repository teaching CSV directory')
        if args.csv_fallback:
            text = text.replace('import delimited using', 'insheet using')
            changes.append('insheet substituted for Java-dependent import delimited')
    candidate = folder / 'candidate.do'
    candidate.write_text(text)
    receipt = folder / 'receipt.txt'
    wrapper = folder / 'audit.do'
    argument = '' if source.name.startswith('02_method_decision_tree') else f' "{root}"'
    wrapper.write_text(
        'set processors 1\n'
        f'capture noisily do "{candidate}"{argument}\n'
        'local result = _rc\n'
        f'file open auditfile using "{receipt}", write text replace\n'
        'file write auditfile "`result\'" _n\n'
        'file close auditfile\nexit, clear\n'
    )
    try:
        subprocess.run([args.executable, '-b', 'do', str(wrapper)], cwd=folder,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45, check=False)
        code = receipt.read_text().strip() if receipt.exists() else 'no receipt'
    except subprocess.TimeoutExpired:
        code = 'timeout'
    log = (folder / 'audit.log').read_text(errors='replace') if (folder / 'audit.log').exists() else ''
    warnings = len(re.findall(r'^Graph export failed;', log, flags=re.M))
    entry = {'script': str(source.relative_to(root)), 'return_code': code,
             'graph_export_failures': warnings, 'temporary_substitutions': changes}
    results.append(entry)
    print(json.dumps(entry), flush=True)
report = {'method': 'Native Stata batch, one processor; each script in a disposable directory',
          'limits': ['Decision-tree scripts exercise their default settings.',
                     'Successful execution does not certify every explanatory claim or estimator assumption.',
                     'Graph-export warnings are counted separately from completed numerical analysis.',
                     'Raw logs remain outside the repository because Stata prints license information.'],
          'results': results}
output = root / args.output
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, indent=2) + '\n')
print(f'Raw local logs: {destination}')
raise SystemExit(0 if all(item['return_code'] == '0' for item in results) else 1)
