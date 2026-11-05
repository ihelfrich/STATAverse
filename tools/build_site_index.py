#!/usr/bin/env python3
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
assets_data = root / "assets" / "data"
assets_data.mkdir(parents=True, exist_ok=True)

entries = [{
    "type": "module", "title": "Analysis lab: Regression and adjustment",
    "summary": "Simulate omitted-variable bias, trace partial regression and investigate influential observations with exact Stata exports.",
    "tags": ["interactive", "regression", "OLS", "FWL", "omitted variable bias", "influence", "leverage", "Cook"],
    "level": "Intermediate and advanced", "path": "Labs/",
}, {
    "type": "module", "title": "Analysis lab: Uncertainty and repeated samples",
    "summary": "Compare conventional, HC1 and clustered confidence intervals, simulate coverage with Monte Carlo uncertainty, and export the exact sample and Stata commands.",
    "tags": ["interactive", "inference", "confidence intervals", "Monte Carlo", "heteroskedasticity", "clustering", "standard errors", "power"],
    "level": "Intermediate and advanced", "path": "Labs/Inference/",
}, {
    "type": "module", "title": "Analysis lab: Merge and reshape",
    "summary": "Trace source records and cells through merges and reshapes. Inspect duplicate keys, missing matches, conflicting values and retained samples; export a complete Stata project.",
    "tags": ["interactive", "merge", "reshape", "keys", "duplicates", "data preparation", "panel", "wide", "long"],
    "level": "Beginner to advanced", "path": "Labs/Data/",
}]

practice_path = assets_data / "practice-lessons.json"
if practice_path.exists():
    for item in json.loads(practice_path.read_text()):
        entries.append({
            "type": "module", "title": f"Browser practice: {item['title']}",
            "summary": item["summary"], "tags": ["practice", "interactive", "stata"],
            "level": item["level"], "path": f"Learn/#{item['id']}",
        })

investigation_path = assets_data / "lab-investigations.json"
if investigation_path.exists():
    for item in json.loads(investigation_path.read_text()):
        entries.append({
            "type": "module", "title": f"Guided investigation: {item['title']}",
            "summary": item["summary"], "tags": ["practice", "interactive", "merge", "reshape", "data preparation"],
            "level": item["level"], "path": f"Labs/Data/#investigation={item['id']}",
        })

scripts_path = root / "ScriptLibrary" / "scripts.json"
if scripts_path.exists():
    scripts = json.loads(scripts_path.read_text())
    for item in scripts:
        entries.append({
            "type": "script",
            "title": item["title"],
            "summary": item["summary"],
            "tags": item.get("tags", []),
            "level": item.get("level", ""),
            "path": f"ScriptLibrary/script.html?id={item['id']}",
        })

zt_modules = [
    ("Econometric mindset", "ZeroToHero/modules/00-econometric-mindset.html", ["concepts", "design"], "module"),
    ("Stata foundations", "ZeroToHero/modules/01-stata-foundations.html", ["workflow", "stata"], "module"),
    ("OLS intuition", "ZeroToHero/modules/02-ols-intuition.html", ["ols", "math"], "module"),
    ("Limited outcomes", "ZeroToHero/modules/03-limited-outcomes.html", ["binary", "count"], "module"),
]
for title, path, tags, typ in zt_modules:
    entries.append({
        "type": typ,
        "title": f"Zero-to-Hero: {title}",
        "summary": "Graduate-ready module in the Zero-to-Hero path.",
        "tags": tags,
        "level": "Graduate",
        "path": path,
    })

for title, path, tags in [
    ("Coffee chain weekly", "ZeroToHero/datasets/coffee-chain.html", ["dataset", "panel", "retail"]),
    ("Warehouse picking", "ZeroToHero/datasets/warehouse-picking.html", ["dataset", "ops", "productivity"]),
    ("Fulfillment delays", "ZeroToHero/datasets/fulfillment-delays.html", ["dataset", "logit", "count"]),
]:
    entries.append({
        "type": "dataset",
        "title": title,
        "summary": "Clean dataset with documentation and starter code.",
        "tags": tags,
        "level": "All",
        "path": path,
    })

for title, path, tags in [
    ("Project 01: Promo impact + staffing", "ZeroToHero/projects/project-01.html", ["project", "ols"]),
    ("Project 02: Delay risk + delay days", "ZeroToHero/projects/project-02.html", ["project", "logit", "count"]),
]:
    entries.append({
        "type": "project",
        "title": title,
        "summary": "Applied project with deliverables and Stata workflows.",
        "tags": tags,
        "level": "Graduate",
        "path": path,
    })

biz_modules = [
    ("Foundations and workflow", "STATAForBusiness/modules/00-foundations.html", ["workflow", "stata"], "module"),
    ("Linear regression basics", "STATAForBusiness/modules/01-linear-regression.html", ["ols"], "module"),
]
for title, path, tags, typ in biz_modules:
    entries.append({
        "type": typ,
        "title": f"Stata for Business: {title}",
        "summary": "Graduate methods aligned module.",
        "tags": tags,
        "level": "Graduate",
        "path": path,
    })

pages = [
    ("STATAverse Home", "index.html", ["home"]),
    ("Zero-to-Hero Overview", "ZeroToHero/index.html", ["overview"]),
    ("Script Library", "ScriptLibrary/index.html", ["scripts"]),
    ("Code Library", "CodeLibrary/index.html", ["code", "library", "scripts"]),
    ("Code Library Architecture", "CodeLibrary/architecture.html", ["code", "library", "docs"]),
    ("Code Library Innovation", "CodeLibrary/innovation.html", ["code", "library", "docs"]),
    ("Code Library Transformation", "CodeLibrary/transformation.html", ["code", "library", "docs"]),
    ("Method Lab", "MethodLab/index.html", ["methods", "decision", "lab"]),
    ("Script Builder", "ScriptLibrary/builder.html", ["scripts", "builder"]),
    ("Site Search", "Search/index.html", ["search"]),
    ("Workspace", "Workspace/index.html", ["workspace"]),
    ("Topics Map", "Topics/index.html", ["topics", "map"]),
    ("Reading Library", "Readings/index.html", ["readings", "references"]),
]
for title, path, tags in pages:
    entries.append({
        "type": "page",
        "title": title,
        "summary": "Primary navigation page.",
        "tags": tags,
        "level": "All",
        "path": path,
    })

(assets_data / "site-index.json").write_text(json.dumps(entries, indent=2) + "\n")
print("Wrote site-index.json with", len(entries), "entries")
