## Overview
This module establishes the Stata workflow you will use in every project: clean setup, clear logs,
transparent data steps, and reliable outputs.

## Learning goals
- Build a consistent project folder structure.
- Load data and validate the contents.
- Save a clean working copy with labels.
- Document your steps with a do-file and log.

## Project structure
Use a simple structure that keeps data, code, and outputs separate.

```
project-name/
  data/
  do/
  output/
```

## Step 1: Start a do-file and log
[TRY]
- [ ] Create a new do-file named `01-stata-foundations.do`.
- [ ] Run:
```stata
clear all
set more off
capture mkdir data
capture mkdir do
capture mkdir output
log using "output/01-stata-foundations.log", replace
```

[PREDICT]
- [ ] What happens if you run the log command twice without `replace`?

[CHECK]
- Expected: Stata will refuse to overwrite the existing log.

[REFLECT]
- Why do logs matter for reproducibility?

## Step 2: Import a dataset
Download the Coffee Chain Weekly dataset and place it in `data/`.

[TRY]
- [ ] Run:
```stata
import delimited using "data/coffee_chain_weekly.csv", clear
```

[PREDICT]
- [ ] How many rows do you expect? What is the unit of observation?

[CHECK]
- Expected: 144 rows. The unit is store-week.

[REFLECT]
- Write a sentence explaining the unit of analysis.

## Step 3: Inspect and label
[TRY]
- [ ] Run:
```stata
describe
summarize price sales foot_traffic
codebook region store_type
```

[PREDICT]
- [ ] Which variables are categorical? Which are continuous?

[CHECK]
- Expected: region and store_type are categorical; price, sales, foot_traffic are continuous.

[REFLECT]
- Why is it useful to distinguish categorical vs. continuous early?

## Step 4: Make a clean working copy
[TRY]
- [ ] Run:
```stata
label variable sales "Weekly unit sales"
label variable promo "Promotion indicator"
compress
save "data/coffee_chain_working.dta", replace
```

[PREDICT]
- [ ] What does `compress` do?

[CHECK]
- Expected: Reduces storage size when possible without losing information.

[REFLECT]
- Why keep a working copy separate from the raw data?

## Step 5: Quick preview in the browser
<div class="data-preview" data-csv-preview="../data/coffee_chain_weekly.csv" data-preview-rows="5"></div>

## Step 6: Close the log
[TRY]
- [ ] Run:
```stata
log close
```

[PREDICT]
- [ ] Where is the log saved?

[CHECK]
- Expected: In the `output/` folder.

[REFLECT]
- Write one sentence on how logs help when you share work.

## Self-test
1) What does `set more off` change?
2) Why is the unit of observation important?
3) When should you use `compress`?

Answer key (short)
- Q1: It prevents Stata from pausing output.
- Q2: It tells you what each row represents, which affects model choice.
- Q3: After import or merges, to reduce file size safely.
