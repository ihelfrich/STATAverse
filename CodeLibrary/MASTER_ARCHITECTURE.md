# STATAverse: World-Class Econometrics Learning System
## Architecture Document v2.0
**Date**: January 15, 2026
**Standard**: Publication-ready mastery for top management journals

---

## Mission Statement

Build the **world's foremost STATA resource** for applied econometrics—nuanced, novel, meaningful, and real. After completing this system, students should be able to:

1. **Publish** in top journals (AMJ, SMJ, ASQ, MS, SMJ)
2. **Answer** every methodological question in advanced applied econometrics
3. **Defend** their methods to editors and reviewers with confidence
4. **Teach** these methods to others using plain language

---

## Design Principles

### 1. Three-Level Learning Architecture

**Level 1: Intuition Building** (Beginner-Accessible)
- Start with everyday examples (coffee shops, hiring decisions, ice cream sales)
- Use visual analogies and plain language
- Introduce technical terms **after** intuition is established
- Example: Ice cream/shark attacks before "confounding variable"

**Level 2: Technical Mastery** (Graduate-Level Rigor)
- Mathematical foundations from Kennedy, Cameron & Trivedi, Angrist & Pischke
- Stata implementation with publication-quality code
- Comprehensive diagnostic workflows
- Assumption testing and violation handling

**Level 3: Publication Readiness** (Top Journal Standards)
- AMJ/SMJ reporting guidelines
- Reviewer response templates
- Robustness check batteries
- Common reviewer objections and responses
- Publication-ready tables and figures

### 2. Course Alignment Matrix

Every module maps to MGTO 80430 sessions:

| Session | Topic | STATAverse Modules | Books Referenced |
|---------|-------|-------------------|------------------|
| 1 | Intro, Trends, Replication | `00_foundations.md` | Angrist & Pischke Ch 1 |
| 2 | DGP, Regression, Causality | `01_regression_deep_dive.do` | Kennedy Ch 1-3, Cameron Ch 3 |
| 3 | Controls, Moderation, Nonlinear | `02_moderation_masterclass.do` | Busenbark et al. 2022 ORM |
| 4 | Binary, Count, Qualitative DVs | `03_limited_dvs_part1.do` | Cameron Ch 14-17, Kennedy Ch 16-17 |
| 5 | **Assignment 1 Work Session** | Assignment 1 template + solutions | Hoetker 2007 |
| 6 | Non-normal, Ratios, PSM | `04_limited_dvs_part2.do` | Certo et al. 2020 ORM |
| 7 | Endogeneity Sources | `05_endogeneity_diagnosis.do` | Hill et al. 2021 JOM |
| 8 | IV, 2SLS, Identification | `06_instrumental_variables.do` | Angrist & Pischke Ch 4 |
| 9 | **Assignment 2 Work Session** | Assignment 2 template + solutions | Semadeni et al. 2014 |
| 10 | Panel FE/RE | `07_panel_data_part1.do` | Kennedy Ch 18, Cameron Ch 8 |
| 11 | Hybrid, GEE, Variance Decomp | `08_panel_data_part2.do` | Certo et al. 2017 SMJ |
| 12 | Publication Process | `09_publication_toolkit.do` | Bliese et al. 2024 AMJ |
| 13 | **Assignment 3 Repository** | Comprehensive methods toolkit | All references |
| 14 | Presentations | Presentation feedback guide | |
| 15 | Final Paper Due | | |

### 3. Jargon Management Protocol

**Rule**: Never use a technical term without defining it first.

**Three-Part Introduction**:
1. **Everyday analogy** - "Imagine you're trying to figure out if..."
2. **Plain-language definition** - "What we're really asking is..."
3. **Technical term** - "Econometricians call this [TERM]"

**Example**:
```
Imagine you're trying to understand if raising prices hurts sales. But you
only raised prices during busy seasons—when you would have sold more anyway!
Now you can't tell if the sales change was because of price or because of
the season. Your price variable is "tangled up" with season.

Econometricians call this ENDOGENEITY—when your explanatory variable is
correlated with unmeasured factors that also affect the outcome.
```

### 4. Simulation-First Pedagogy

Every major concept includes:
1. **Data generation with known truth**: `generate y = 2*x + u` where β=2 is known
2. **Wrong method demonstration**: Show what goes wrong (bias, incorrect inference)
3. **Correct method implementation**: Fix the problem
4. **Visual proof**: Graph showing bias correction

### 5. Anti-Pattern Library

Teach through **common mistakes**:
- ❌ Interpreting logit coefficients as marginal effects
- ❌ Controlling for post-treatment variables
- ❌ Using ratios as DVs without correction
- ❌ Ignoring clustered standard errors
- ❌ Weak instruments (worse than OLS!)
- ❌ Mechanical interaction interpretation

Each mistake gets:
- Working example where you **know** the truth
- Demonstration of bias magnitude
- Correct approach side-by-side
- Visual proof

### 6. Publication-Ready Code

Every script includes:
```stata
* Section 1: Setup and Data Generation
* Section 2: Descriptive Statistics (for Table 1)
* Section 3: Correlation Matrix (for Table 2)
* Section 4: Main Analysis (for Table 3)
* Section 5: Robustness Checks (for Table 4+)
* Section 6: Visualization (for Figures)
* Section 7: Export Results (for LaTeX/Word)
```

All tables match **AMJ/SMJ formatting standards**.

---

## Module Structure

### Standard Module Template

Every `.do` file follows this structure:

```stata
*******************************************************************************
* MODULE [XX]: [TITLE]
* Course Alignment: MGTO 80430 Session [X]
* Reading: [Key papers from syllabus]
* Learning Objectives:
*   1. [Objective 1]
*   2. [Objective 2]
*   ...
*
* Three-Level Structure:
*   LEVEL 1: Intuition (Lines XXX-XXX)
*   LEVEL 2: Implementation (Lines XXX-XXX)
*   LEVEL 3: Publication (Lines XXX-XXX)
*******************************************************************************

*==============================================================================
* LEVEL 1: INTUITION - Building Understanding
*==============================================================================

display "═══════════════════════════════════════════════════════════"
display "   What is [CONCEPT]? (And Why Should You Care?)"
display "═══════════════════════════════════════════════════════════"

* [Everyday example with plain language]
* [Visual analogy]
* [Only then introduce technical terms]

*==============================================================================
* LEVEL 2: IMPLEMENTATION - Technical Mastery
*==============================================================================

* [Kennedy mathematical foundation]
* [Cameron & Trivedi Stata implementation]
* [Diagnostic workflows]
* [Assumption testing]

*==============================================================================
* LEVEL 3: PUBLICATION - Journal-Ready Code
*==============================================================================

* [AMJ/SMJ reporting standards]
* [Publication-quality tables]
* [Publication-quality figures]
* [Robustness checks]
* [Reviewer response templates]

*==============================================================================
* GLOSSARY: Technical Terms Translated
*==============================================================================

* [Plain-language definitions for all jargon]
```

---

## Core Modules (Aligned with MGTO 80430)

### **Session 2: Regression Foundations**
**File**: `01_regression_deep_dive.do`
- **Level 1**: Coffee shop pricing example
- **Level 2**: OLS algebra, BLUE properties, Gauss-Markov theorem
- **Level 3**: Publication-ready regression tables

**Key References**:
- Kennedy Ch 1-3
- Cameron & Trivedi Ch 3-4
- Angrist & Pischke Ch 2

### **Session 3: Moderation & Non-Linearity**
**File**: `02_moderation_masterclass.do`
- **Level 1**: Why advertising works differently for different products
- **Level 2**: Marginal effects approach (Busenbark et al. 2022)
- **Level 3**: Marginsplots for publication

**Key Innovation**: Implement Busenbark et al. (2022) ORM "marginal effects approach" exactly as expected by management journals.

**Key References**:
- Busenbark et al. 2022 (ORM) - **PRIMARY**
- Haans et al. 2016 (SMJ) - U-shaped relationships
- Edwards & Parry 1993 - Polynomial regression

### **Session 4: Limited DVs Part 1**
**File**: `03_limited_dvs_part1.do`
- **Level 1**: Why can't we use OLS for yes/no decisions?
- **Level 2**: Logit, probit, count models (Hoetker 2007)
- **Level 3**: Marginal effects reporting (AMJ standard)

**Key References**:
- Hoetker 2007 (SMJ) - **PRIMARY**
- Cameron & Trivedi Ch 14-17
- Kennedy Ch 16-17

### **Session 6: Limited DVs Part 2**
**File**: `04_limited_dvs_part2.do`
- **Level 1**: What's wrong with ratios? (The "divided we fall" problem)
- **Level 2**: Quantile regression, fractional response models
- **Level 3**: PSM implementation and balance checks

**Key References**:
- Certo et al. 2020 (ORM) - **PRIMARY** (ratio dangers)
- Villadsen & Wulff 2021 (SO) - Fractional response
- Li 2013 (ORM) - PSM guide

### **Session 7: Endogeneity Diagnosis**
**File**: `05_endogeneity_diagnosis.do`
- **Level 1**: Ice cream and shark attacks story
- **Level 2**: Sources of endogeneity (Hill et al. 2021)
- **Level 3**: Sensitivity analysis (ITCV, Oster's delta)

**Key References**:
- Hill et al. 2021 (JOM) - **PRIMARY**
- Busenbark et al. 2022 (JOM) - ITCV
- Oster 2019 - Coefficient stability

### **Session 8: Instrumental Variables**
**File**: `06_instrumental_variables.do`
- **Level 1**: Finding a "randomizer" in observational data
- **Level 2**: 2SLS, weak instrument tests, overidentification
- **Level 3**: IV in top journals (Sanders & Hambrick 2007 replication)

**Key References**:
- Angrist & Pischke Ch 4 - **PRIMARY**
- Semadeni et al. 2014 (SMJ) - Simulation warnings
- Cameron & Trivedi Ch 6

### **Session 10: Panel Data Part 1**
**File**: `07_panel_data_part1.do`
- **Level 1**: Why following the same people matters
- **Level 2**: Fixed effects, random effects, Hausman test
- **Level 3**: Panel diagnostics for publication

**Key References**:
- Kennedy Ch 18
- Cameron & Trivedi Ch 8
- Certo & Semadeni 2006 (JOM)

### **Session 11: Panel Data Part 2**
**File**: `08_panel_data_part2.do`
- **Level 1**: Within vs. between variation explained
- **Level 2**: Hybrid models (Certo et al. 2017), GEE (Ballinger 2004)
- **Level 3**: Variance decomposition (Quigley & Graffin 2016)

**Key References**:
- Certo et al. 2017 (SMJ) - **PRIMARY** (hybrid models)
- Ballinger 2004 (ORM) - GEE
- Quigley & Graffin 2016 (SMJ) - Variance decomposition

### **Session 12: Publication Toolkit**
**File**: `09_publication_toolkit.do`
- Automated regression tables (esttab, estout)
- Figure generation matching journal standards
- Robustness check batteries
- Reviewer response templates

**Key References**:
- Bliese et al. 2024 (AMJ) - Theory-methods-data links
- DeCelles et al. 2021 (AMJ) - Transparency standards

---

## Assignment Support Modules

### **Assignment 1: Limited Dependent Variables**
**File**: `assignment_01_limited_dvs.do`
- Complete worked example
- Methods section template
- Results section template
- Common mistakes and fixes

### **Assignment 2: Endogeneity**
**File**: `assignment_02_endogeneity.do`
- IV identification strategy
- Instrument validation
- Methods section template
- Robustness checks

### **Assignment 3: Methods Repository**
**File**: `assignment_03_toolkit_builder.do`
- Spreadsheet generator
- Method decision tree
- Stata code library
- Citation manager

---

## Supplementary Modules (Beyond Course)

### **Difference-in-Differences**
**File**: `10_diff_in_diff.do`
- Parallel trends testing
- Event studies
- Staggered adoption (Roth et al. 2023)

### **Hazard Models**
**File**: `11_survival_analysis.do`
- Cox proportional hazards
- Competing risks
- Time-varying covariates

### **Matching Methods**
**File**: `12_matching_toolkit.do`
- PSM with caliper matching
- Coarsened exact matching (CEM)
- Balance diagnostics

---

## Quality Standards

### Code Testing Protocol
1. ✅ Runs without errors in Stata 18 MP
2. ✅ Generates expected output (verified)
3. ✅ Creates publication-quality visualizations
4. ✅ Exports tables in LaTeX and Word formats
5. ✅ Includes comments explaining every section
6. ✅ Cites relevant methodological papers

### Documentation Standards
1. Every script has learning objectives
2. Every technical term defined in glossary
3. Every method linked to journal examples
4. Every diagnostic explained (not just run)

### Pedagogical Standards
1. Intuition before mathematics
2. Visual proof before statistical tests
3. Plain language before jargon
4. Everyday examples before technical cases

---

## Success Metrics

After completing STATAverse, students should be able to:

### Knowledge Metrics
- [ ] Explain every method to a non-technical audience
- [ ] Choose the correct method for any research design
- [ ] Diagnose assumption violations
- [ ] Implement fixes for violated assumptions

### Skill Metrics
- [ ] Write publication-ready methods sections
- [ ] Generate AMJ/SMJ-quality tables and figures
- [ ] Respond to reviewer methodological concerns
- [ ] Conduct comprehensive robustness checks

### Confidence Metrics
- [ ] Present methods in job talks without fear
- [ ] Defend methodological choices to editors
- [ ] Review others' methods accurately
- [ ] Teach these methods to others

---

## References Integration

### Primary Textbooks
1. **Kennedy (2008)**: Intuition and "General Notes" (not Technical Notes initially)
2. **Cameron & Trivedi (2022)**: Stata implementation and advanced topics
3. **Angrist & Pischke (2009)**: Causal inference and identification strategies

### Key Methodological Papers (by Topic)

**Moderation**:
- Busenbark et al. 2022 (ORM) - **Must cite for interactions**
- Haans et al. 2016 (SMJ) - U-shaped relationships

**Limited DVs**:
- Hoetker 2007 (SMJ) - Logit/probit in strategy
- Certo et al. 2020 (ORM) - Ratio dangers

**Endogeneity**:
- Hill et al. 2021 (JOM) - Comprehensive endogeneity review
- Busenbark et al. 2022 (JOM) - ITCV sensitivity

**Instrumental Variables**:
- Semadeni et al. 2014 (SMJ) - IV dangers
- Angrist & Pischke 2009 Ch 4

**Panel Data**:
- Certo et al. 2017 (SMJ) - Within-between decomposition
- Ballinger 2004 (ORM) - GEE
- Quigley & Graffin 2016 (SMJ) - Variance decomposition

**Publication Standards**:
- Bliese et al. 2024 (AMJ) - Theory-methods-data links
- DeCelles et al. 2021 (AMJ) - Transparency

---

## Development Roadmap

### Phase 1: Core Sessions (Priority)
- [x] Session 2: Regression foundations
- [ ] Session 3: Moderation masterclass
- [ ] Session 4: Limited DVs Part 1
- [ ] Session 6: Limited DVs Part 2
- [ ] Session 7: Endogeneity diagnosis
- [ ] Session 8: Instrumental variables
- [ ] Session 10: Panel data Part 1
- [ ] Session 11: Panel data Part 2
- [ ] Session 12: Publication toolkit

### Phase 2: Assignment Support
- [ ] Assignment 1 template + solutions
- [ ] Assignment 2 template + solutions
- [ ] Assignment 3 toolkit builder

### Phase 3: Website Integration
- [ ] Interactive HTML versions
- [ ] Search functionality
- [ ] Video walkthroughs
- [ ] Downloadable code packages

### Phase 4: Advanced Extensions
- [ ] Difference-in-differences
- [ ] Survival analysis
- [ ] Matching methods
- [ ] Synthetic controls
- [ ] RDD

---

## Contact & Contribution

**Creator**: Dr. Ian Helfrich
**Website**: https://ihelfrich.github.io/STATAverse/
**Purpose**: World-class applied econometrics education

**Philosophy**:
> "The best econometrics resource teaches you to think like an economist,
> code like a programmer, and write like a scholar. Intuition first,
> rigor always, publication-ready throughout."

---

**Version**: 2.0
**Last Updated**: 2026-01-15
**Status**: Active Development - Priority on MGTO 80430 alignment
