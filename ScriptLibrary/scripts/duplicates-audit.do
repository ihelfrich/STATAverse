* Duplicates audit

* Example: check uniqueness of id
* duplicates report id

* Tag duplicates
duplicates tag id, gen(dup_id)

tab dup_id

* Review duplicates
list id if dup_id > 0

* Optional: drop duplicates
* duplicates drop id, force
