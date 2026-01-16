#!/usr/bin/env python3
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
assets_data = root / "assets" / "data"
assets_data.mkdir(parents=True, exist_ok=True)

entries = []

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
