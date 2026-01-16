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
