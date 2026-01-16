## Overview
Create standard folders, set session defaults, and start a log file.

## When to use
Start every Stata project with a clean structure and a log.

## Inputs
None (creates folders in the current working directory).

## Outputs
data/, do/, output/ folders and a log file in output/.

## Script
```stata
clear all
set more off

capture mkdir data
capture mkdir do
capture mkdir output

log using "output/session.log", replace
```

## Notes
Adjust the log filename to match the task or date.
