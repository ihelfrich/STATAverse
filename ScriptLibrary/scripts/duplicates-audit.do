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
