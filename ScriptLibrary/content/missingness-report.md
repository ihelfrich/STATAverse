## Overview
Summarize missing values and flag rows with any missing data.

## When to use
Quickly understand missing patterns.

## Inputs
A dataset loaded in memory.

## Outputs
Summary tables and a row-level missing indicator.

## Script
```stata
misstable summarize

egen miss_any = rowmiss(_all)
label variable miss_any "Row has missing data"

tab miss_any
```

## Notes
Use misstable patterns for more detail.
