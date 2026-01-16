# STATAverse: Applied Econometrics for Researchers

**A revolutionary learning platform that bridges the gap between understanding methods and doing research.**

[![Stata Version](https://img.shields.io/badge/Stata-16%2B-blue)](https://www.stata.com/)
[![Status](https://img.shields.io/badge/Status-Phase%201%20Complete-success)]()
[![Tested](https://img.shields.io/badge/All%20Code-Tested%20%E2%9C%85-brightgreen)]()

---

## 🎯 Purpose

STATAverse provides:
- **Simulation-based learning** that builds intuition for complex methods
- **Production-ready code** you can use immediately in your research
- **Anti-pattern library** that teaches through common mistakes
- **Decision support tools** for choosing the right method
- **Complete diagnostic workflows** with publication guidance

Built for PhD students, applied researchers, and econometrics instructors.

---

## 🌟 What Makes STATAverse Different?

### Traditional Approach
📖 Read about method → 🤔 Try to understand → ❓ Struggle with code → 😰 Hope it's right

### STATAverse Approach
▶️ Run simulation → 👀 See the problem → ✨ See the solution → 📊 Get publication-ready output

---

## 📦 Core Components

### 1. **Code Library** (`code_library/`)
Production-ready, tested Stata scripts:

- **[Endogeneity Simulator](code_library/01_endogeneity_simulator.do)** - See bias with your own eyes
- **[Method Decision Tree](code_library/02_method_decision_tree.do)** - "What method should I use?"
- **[Anti-Pattern Library](code_library/03_anti_patterns.do)** - Learn what NOT to do
- **[Assumption Checker](code_library/04_assumption_checker.do)** - Complete diagnostic workflows
- **[Moderation Mastery](code_library/05_moderation_mastery.do)** - Marginal effects approach

See the full [Code Library README](code_library/README.md) for details.

### 2. **Course-Aligned Modules** (`mgto80430/`)
Graduate-level learning path aligned with advanced applied econometrics:
- Foundations & workflow
- Linear regression
- Panel data methods
- Endogeneity & IV
- Limited dependent variables
- Causal inference designs

### 3. **Templates** (`templates/`)
Authoring templates for creating new lessons and labs.

---

## 🚀 Quick Start

```bash
# Clone or navigate to STATAverse
cd /Users/ian/gemini_playground/tutoring/STATA

# Run any module (example: endogeneity simulator)
stata-mp -b code_library/01_endogeneity_simulator.do

# View output
cat code_library/01_endogeneity_simulator.log

# Check generated graphs
ls code_library/*.png
```

---

## 🎓 Learning Philosophy

### The Enhanced 4-Loop Method
1. **TRY** - Run commands
2. **PREDICT** - Write expected output
3. **CHECK** - Compare to guide
4. **REFLECT** - Explain in plain language

**Plus:**
- **SIMULATE** - Generate data with known properties
- **COMPARE** - Wrong way vs. right way
- **VISUALIZE** - Publication-quality graphs
- **REPORT** - Templates for methods sections

### Design Goals
- **Executable understanding**: Every concept has runnable code
- **Visual proof**: See problems and solutions graphically
- **Negative examples**: Learn from common mistakes (anti-patterns)
- **Publication-ready**: Code you can adapt for your research
- **Reproducible workflow**: Do-files, logs, clean project structure
- **Transferable habits**: Data hygiene, model choice, interpretation

---

## 📊 What You Can Do

### For Learning
- Build intuition through simulation
- See exactly why methods work (or fail)
- Avoid common mistakes before submission
- Master complex topics (endogeneity, moderation, panel data)

### For Research
- Quick-reference decision support ("What method?")
- Copy-paste diagnostic workflows
- Generate publication-ready figures
- Methods section templates

### For Teaching
- Live demonstrations in class
- Visual aids for complex topics
- Homework assignments built-in
- Updated with latest methodological advances

---

## 🎯 Alignment with PhD Training

Directly supports advanced econometrics courses like MGTO 80430:
- ✅ Endogeneity & IV estimation (Sessions 7-8)
- ✅ Panel data methods (Sessions 10-11)
- ✅ Limited dependent variables (Sessions 4, 6)
- ✅ Moderation/interaction (Session 3)
- ✅ Methods reporting (Session 12)

---

## 📚 Structure

```
STATAverse/
├── code_library/          # Tested, ready-to-use scripts
│   ├── 01_endogeneity_simulator.do
│   ├── 02_method_decision_tree.do
│   ├── 03_anti_patterns.do
│   ├── 04_assumption_checker.do
│   ├── 05_moderation_mastery.do
│   └── README.md
├── mgto80430/             # Course-aligned modules
│   ├── modules/
│   └── README.md
├── templates/             # Authoring templates
│   ├── lesson.md
│   └── lab.md
├── _testing/              # Testing framework
│   └── test_runner.do
├── README.md              # This file
└── INNOVATION_SUMMARY.md  # Detailed innovation documentation
```

---

## 🔬 Technical Details

- **Tested with**: Stata 18 MP (compatible with Stata 16-18)
- **All code verified**: Automated testing framework
- **Dependencies**: Base Stata installation (optional packages noted in scripts)
- **Output**: Publication-ready graphs, comprehensive logs

---

## 🌟 Key Innovations

1. **Simulation-based intuition**: Generate data with KNOWN properties, see exact bias
2. **Anti-pattern library**: Learn through mistakes (with working counter-examples)
3. **Decision trees**: Get method recommendations based on your data
4. **Complete workflows**: Not just "run this," but "test, diagnose, report"
5. **Marginal effects focus**: Modern interpretation approaches (Busenbark et al. 2022)
6. **Visual diagnostics**: See assumptions, violations, and solutions

---

## 📖 Documentation

- **[Innovation Summary](INNOVATION_SUMMARY.md)** - Detailed overview of what makes this different
- **[Code Library README](code_library/README.md)** - Guide to all available scripts
- **[MGTO 80430 README](mgto80430/README.md)** - Course-aligned learning path

---

## 🚀 Coming Soon

Phase 2 modules in development:
- Panel data toolkit (FE, RE, hybrid, GEE, variance decomposition)
- Difference-in-differences (with recent advances)
- Publication tables generator
- Power analysis & sample size calculations
- Matching methods (PSM, CEM, balance diagnostics)

---

## 🤝 How to Use This

### For Students
Start with the course-aligned modules (`mgto80430/`), then explore the code library for specific topics.

### For Researchers
Jump straight to the [Code Library](code_library/) - find your method or problem, run the code.

### For Instructors
Use simulations for live demos, assign code library scripts as homework, adapt templates for new content.

---

## 📝 Citation & Attribution

This platform builds on best practices from:
- Kennedy (2008): *A Guide to Econometrics*
- Cameron & Trivedi (2010): *Microeconometrics Using Stata*
- Angrist & Pischke (2009): *Mostly Harmless Econometrics*
- Recent methodological advances (cited within scripts)

Created by Dr. Ian Helfrich for students, colleagues, and the research community.

---

## 🌐 Website

Full interactive platform coming soon at: [ihelfrich.github.io/STATAverse](https://ihelfrich.github.io/STATAverse)

---

**STATAverse**: Where econometric methods meet research reality.

*Last updated: 2026-01-15*
