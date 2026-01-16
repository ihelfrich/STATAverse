* Panel setup

xtset store_id week
xtdescribe
xtsum sales price

* Quick plot for a sample of panels
* xtline sales if store_id <= 5, overlay
