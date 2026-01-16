## Overview
Build the core habits that make Stata work reproducible: do-files, logs, clear data steps, and quick data checks.

## Learning goals
- Start every project with a clean, repeatable do-file.
- Load data and verify rows, columns, and types.
- Create, label, and save variables safely.
- Produce a quick descriptive check and a basic graph.

## Prereqs
- Stata installed (Stata 16-18)

## Data
- Source: Stata built-in sample data
- Load:
```stata
sysuse auto, clear
```

## Step 1: Start a clean session
[TRY]
- [ ] Run:
```stata
clear all
set more off
```

[PREDICT]
- [ ] What does each command change about your session?

[CHECK]
- Expected: Stata should be cleared, and output should not pause.

[REFLECT]
- Write 1-2 sentences on why this matters for reproducibility.

## Step 2: Load data and inspect structure
[TRY]
- [ ] Run:
```stata
sysuse auto, clear
describe
summarize
```

[PREDICT]
- [ ] How many observations do you expect? What variables look continuous vs. categorical?

[CHECK]
- Expected: About 70+ observations and about a dozen variables. You should see variables like price, mpg, weight, and foreign.

[REFLECT]
- Write a short note on which variables you might treat as outcomes vs. predictors.

## Step 3: Check missingness and categorical values
[TRY]
- [ ] Run:
```stata
codebook rep78
misstable summarize
```

[PREDICT]
- [ ] Which variables do you think have missing values and why?

[CHECK]
- Expected: rep78 has missing values. misstable should list missing counts per variable.

[REFLECT]
- In one sentence, explain why missingness matters for regression.

## Step 4: Create and label a new variable
[TRY]
- [ ] Run:
```stata
generate price_k = price / 1000
label variable price_k "Price (thousands)"
order price_k, after(price)
```

[PREDICT]
- [ ] How should price_k relate to price numerically?

[CHECK]
- Expected: price_k equals price divided by 1000, and appears next to price in the data order.

[REFLECT]
- Explain when rescaling helps interpretation.

## Step 5: Quick visuals
[TRY]
- [ ] Run:
```stata
histogram price, width(1000)
scatter price mpg
```

[PREDICT]
- [ ] What direction do you expect for price vs. mpg?

[CHECK]
- Expected: A negative relationship is typical; higher mpg often corresponds to lower price.

[REFLECT]
- Write one sentence describing the pattern in plain language.

## Step 6: Save a working copy
[TRY]
- [ ] Run:
```stata
save auto_working.dta, replace
```

[PREDICT]
- [ ] Where will this file be saved? How can you check?

[CHECK]
- Expected: The file saves to your current working directory.

[REFLECT]
- Note your current working directory and why it matters.

## Self-test
1) Why do we start with clear all and set more off?
2) What is the difference between describe and summarize?
3) How would you check missingness for one variable only?

Answer key (short)
- Q1: Clears memory and prevents output pausing, improving reproducibility.
- Q2: describe shows variable metadata; summarize shows basic stats.
- Q3: Use codebook varname or misstable summarize varname.
