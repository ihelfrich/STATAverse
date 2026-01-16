## Overview
Initialize a clean Stata session, create folders, and start a log.

## When to use
Use at the start of every project to keep your work reproducible.

## Inputs
None. Uses the current working directory.

## Outputs
data/, do/, output/ folders and a session log file.

## Options
- Change the log filename to match your task or date.
- Set a project root with cd before creating folders.
- Use text logs for portability (log using ... , text).

## Script
```stata
* Project setup and logging
* This script creates standard folders and a log file.

version 16
clear all
set more off
set varabbrev off
set linesize 120
set seed 12345

* Optional: set your project root
* cd "/path/to/project"

capture mkdir data
capture mkdir do
capture mkdir output

log using "output/session.log", replace text

* Use this block to record context
display "Session started: " c(current_date) " " c(current_time)
```

## Related concepts
- import-csv
- missingness-report
