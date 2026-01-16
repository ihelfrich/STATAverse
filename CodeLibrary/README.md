# STATAverse: Applied Econometrics for Researchers

**A practical learning platform that connects method intuition with real research work.**

[![Stata Version](https://img.shields.io/badge/Stata-16%2B-blue)](https://www.stata.com/)
[![Status](https://img.shields.io/badge/Status-Phase%201%20Complete-success)]()
[![Tested](https://img.shields.io/badge/All%20Code-Tested-brightgreen)]()

---

## Purpose

STATAverse provides:
- **Simulation-based learning** that builds intuition for complex methods
- **Production-ready code** you can use immediately in your research
- **Anti-pattern library** that teaches through common mistakes
- **Decision support tools** for choosing the right method
- **Complete diagnostic workflows** with publication guidance

Built for PhD students, applied researchers, and econometrics instructors.

---

## What this does well
- Moves from intuition to code without skipping diagnostics.
- Shows common mistakes alongside the correct approach.
- Produces clean output you can defend and report.

---

## Core components

### 1. **Code Library** (`scripts/`)
Production-ready, tested Stata scripts:

- **[Endogeneity Simulator](scripts/01_endogeneity_simulator.do)** - See bias with your own eyes
- **[Method Decision Tree](scripts/02_method_decision_tree.do)** - "What method should I use?"
- **[Anti-Pattern Library](scripts/03_anti_patterns.do)** - Learn what NOT to do
- **[Assumption Checker](scripts/04_assumption_checker.do)** - Complete diagnostic workflows
- **[Moderation Mastery](scripts/05_moderation_mastery.do)** - Marginal effects approach

See the full script inventory in `scripts/`.

---

## Quick start

```bash
# Navigate to the Code Library
cd /Users/ian/gemini_playground/STATAverse/CodeLibrary

# Run any module (example: endogeneity simulator)
stata-mp -b scripts/01_endogeneity_simulator.do

# View output
cat scripts/01_endogeneity_simulator.log

# Check generated graphs
ls scripts/*.png
```

---

## Learning philosophy

### The Enhanced 4-Loop Method
1. **TRY** - Run commands
2. **PREDICT** - Write expected output
3. **CHECK** - Compare to guide
4. **REFLECT** - Explain in plain language

Plus:
- **SIMULATE** - Generate data with known properties
- **COMPARE** - Wrong way vs. right way
- **VISUALIZE** - Clear graphs with diagnostics
- **REPORT** - Templates for methods sections

### Design Goals
- **Executable understanding**: Every concept has runnable code
- **Visual proof**: See problems and solutions graphically
- **Negative examples**: Learn from common mistakes (anti-patterns)
- **Publication-ready**: Code you can adapt for your research
- **Reproducible workflow**: Do-files, logs, clean project structure
- **Transferable habits**: Data hygiene, model choice, interpretation

---

## What you can do

### For Learning
- Build intuition through simulation
- See exactly why methods work (or fail)
- Avoid common mistakes before submission
- Master complex topics (endogeneity, moderation, panel data)

### For Research
- Quick-reference decision support ("What method?")
- Copy-paste diagnostic workflows
- Generate reporting-ready figures
- Methods section templates

### For Teaching
- Live demonstrations in class
- Visual aids for complex topics
- Homework assignments built-in
- Updated with latest methodological advances

---

## Curriculum alignment

Designed to match graduate econometrics expectations:
- Endogeneity & IV estimation
- Panel data methods
- Limited dependent variables
- Moderation/interaction
- Methods reporting and diagnostics

---

## Structure

```
STATAverse/
  CodeLibrary/
    scripts/           # Tested, ready-to-use scripts
    README.md
    MASTER_ARCHITECTURE.md
    INNOVATION_SUMMARY.md
    TRANSFORMATION_SUMMARY.md
  (site content)
```

---

## Technical details

- **Tested with**: Stata 18 MP (compatible with Stata 16-18)
- **All code verified**: Automated testing framework
- **Dependencies**: Base Stata installation (optional packages noted in scripts)
- **Output**: Clear graphs, comprehensive logs

---

## Key innovations

1. **Simulation-based intuition**: Generate data with KNOWN properties, see exact bias
2. **Anti-pattern library**: Learn through mistakes (with working counter-examples)
3. **Decision trees**: Get method recommendations based on your data
4. **Complete workflows**: Not just "run this," but "test, diagnose, report"
5. **Marginal effects focus**: Modern interpretation approaches (Busenbark et al. 2022)
6. **Visual diagnostics**: See assumptions, violations, and solutions

---

## Documentation

- **[Innovation Summary](INNOVATION_SUMMARY.md)** - Detailed overview of what makes this different
- **[Code Library README](README.md)** - Guide to all available scripts

---

## Coming soon

Phase 2 modules in development:
- Difference-in-differences (with recent advances)
- Publication tables generator
- Power analysis & sample size calculations
- Matching methods (PSM, CEM, balance diagnostics)

---

## How to use this

### For Students
Start with the intuition-first scripts, then explore advanced modules for specific topics.

### For Researchers
Jump straight to the [Code Library](scripts/) - find your method or problem, run the code.

### For Instructors
Use simulations for live demos, assign code library scripts as homework, adapt templates for new content.

---

## Citation and attribution

This platform builds on best practices from:
- Kennedy (2008): *A Guide to Econometrics*
- Cameron & Trivedi (2010): *Microeconometrics Using Stata*
- Angrist & Pischke (2009): *Mostly Harmless Econometrics*
- Recent methodological advances (cited within scripts)

Created by Dr. Ian Helfrich for students, colleagues, and the research community.

---

## Website

Full interactive platform coming soon at: [ihelfrich.github.io/STATAverse](https://ihelfrich.github.io/STATAverse)

---

**STATAverse**: Where econometric methods meet research reality.

*Last updated: 2026-01-15*
