## Overview
Identify duplicate records and create a duplicate flag.

## When to use
Check whether IDs are unique before merging.

## Inputs
A dataset loaded in memory and candidate keys.

## Outputs
Duplicate flags and optional cleaned data.

## Options
- Use duplicates report for quick counts.
- Use duplicates tag to flag duplicates.
- Drop duplicates only after review.

## Script
```stata
* Duplicates audit

* Example: check uniqueness of id
* duplicates report id

* Tag duplicates
duplicates tag id, gen(dup_id)

tab dup_id

* Review duplicates
list id if dup_id > 0

* A repeated ID does not establish that a row is disposable.
* Verify the unit of analysis and source records before resolving duplicates.
```

## Related concepts
- merge-1-1
- merge-m-1
