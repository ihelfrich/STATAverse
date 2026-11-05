version 17
clear all
set more off
display "CASE negative-power: " %21.15g -2^2
display "CASE chained-power: " %21.15g 2^3^2
display "CASE negative-round: " %21.15g round(-1.5)
display "CASE zero-unit-round: " %21.15g round(1.4,0)
display "CASE missing-range-low: " %21.15g inrange(5,.,10)
display "CASE missing-range-high: " %21.15g inrange(5,1,.)
display "CASE missing-range-value: " %21.15g inrange(.,1,.)
display "CASE missing-logical: " %21.15g !.
display "CASE logical-comparison: " %21.15g !2==1
display "CASE arithmetic-missing: " %21.15g 0*.
display "CASE missing-equality: " %21.15g .==.
display "CASE negative-power-paren: " %21.15g (-2)^2
display "STATAVERSE_EXPRESSIONS_COMPLETE"
