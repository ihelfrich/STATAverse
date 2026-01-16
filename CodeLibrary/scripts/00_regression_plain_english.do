*******************************************************************************
* Understanding Regression: A Plain English Guide
* Purpose: Build intuition for what regression ACTUALLY tells you
* Author: STATAverse
* Last updated: 2026-01-15
*
* Target audience: Complete beginners, no statistics background assumed
* Philosophy: Start with everyday reasoning, add numbers, introduce terms last
*******************************************************************************

clear all
set more off

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}   What Is Regression? (And Why Should You Care?)"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}Regression answers questions like:"
display "{txt}  • If I raise prices by $1, how much will sales drop?"
display "{txt}  • Does advertising actually work?"
display "{txt}  • Which factors matter most for customer satisfaction?"

display _n "{txt}It's just a systematic way of answering:"
display "{txt}  'When X changes, how much does Y typically change?'"

*******************************************************************************
* EXAMPLE 1: Coffee Shop Sales
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  EXAMPLE: Understanding Your Coffee Shop"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}You run a coffee shop. You want to know:"
display "{txt}  'If I change my price, what happens to daily sales?'"

display _n "{txt}You have data from 100 days with different prices."
display "{txt}Let's make up some realistic numbers..."

* Generate example data
set obs 100
generate price = runiform(2.50, 4.50)  // Coffee price between $2.50 and $4.50

* Sales depend on price (higher price = fewer sales, generally)
* Let's say true relationship: Sales = 200 - 30*price + random variation
generate sales = 200 - 30*price + rnormal(0, 15)

label variable price "Coffee price ($)"
label variable sales "Daily sales (cups)"

display _n "{txt}Here's what your data looks like (first 10 days):"
list price sales in 1/10, clean noobs

*******************************************************************************
* LOOKING AT THE PATTERN
*******************************************************************************

display _n(2) "{txt}STEP 1: Look at the Pattern"
display "{txt}─────────────────────────────────────────────────────────────────"

display _n "{txt}Before any fancy analysis, let's just think:"
display "{txt}  • On high-price days, do you sell more or fewer cups?"
display "{txt}  • On low-price days, do you sell more or fewer cups?"

* Show summary for low vs high price days
display _n "{txt}Low-price days (under $3.50):"
quietly summarize sales if price < 3.50
local low_avg = r(mean)
display "{txt}  Average sales: " %5.1f `low_avg' " cups"

display _n "{txt}High-price days (over $3.50):"
quietly summarize sales if price >= 3.50
local high_avg = r(mean)
display "{txt}  Average sales: " %5.1f `high_avg' " cups"

display _n "{txt}Difference: " %5.1f (`low_avg' - `high_avg') " cups"
display "{txt}→ Looks like higher prices = fewer sales (makes sense!)"

*******************************************************************************
* RUNNING A REGRESSION (The Simple Way)
*******************************************************************************

display _n(3) "{txt}STEP 2: Get a More Precise Answer"
display "{txt}─────────────────────────────────────────────────────────────────"

display _n "{txt}Regression gives us a more precise answer:"
display "{txt}  'On average, when price increases by $1, sales change by ___'"

display _n "{txt}Let's run it:"
regress sales price

display _n(2) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  HOW TO READ THIS OUTPUT"
display "{txt}═════════════════════════════════════════════════════════════════"

local coef = _b[price]
local se = _se[price]
local tstat = _b[price]/_se[price]
local pval = 2*ttail(e(df_r), abs(`tstat'))

display _n "{txt}THE MOST IMPORTANT NUMBER: The Coefficient"
display "{txt}─────────────────────────────────────────────────────────────────"
display "{txt}  Price coefficient: " %6.2f `coef'

display _n "{txt}What this means in PLAIN ENGLISH:"
display "{txt}  'When price increases by $1, we typically sell"
display "{txt}   " %5.1f abs(`coef') " fewer cups' (negative = decrease)"

display _n "{txt}Compare to our TRUE relationship: -30 cups per dollar"
display "{txt}  We got: " %5.1f `coef'
display "{txt}  Pretty close! (small difference due to random variation)"

display _n(2) "{txt}THE SECOND MOST IMPORTANT: How Sure Are We?"
display "{txt}─────────────────────────────────────────────────────────────────"
display "{txt}  Standard error: " %6.2f `se'

display _n "{txt}What this means:"
display "{txt}  'Our estimate could easily be off by ±" %5.1f (2*`se') "'"
display "{txt}  (We use roughly 2 × standard error as margin of error)"

display _n "{txt}So the true effect is probably between:"
display "{txt}  " %6.2f (`coef' - 2*`se') " and " %6.2f (`coef' + 2*`se') " cups per dollar"

display _n(2) "{txt}THE 'IS IT REAL?' CHECK: P-value"
display "{txt}─────────────────────────────────────────────────────────────────"
display "{txt}  P-value: " %6.4f `pval'

display _n "{txt}What this means:"
display "{txt}  Rule of thumb: If p < 0.05, the effect is probably real"
display "{txt}                 If p > 0.05, it might just be random chance"

if `pval' < 0.05 {
    display _n "{txt}  ✓ Our p-value is " %5.3f `pval' " (less than 0.05)"
    display "{txt}    → We're confident price DOES affect sales"
}
else {
    display _n "{txt}  ✗ Our p-value is " %5.3f `pval' " (more than 0.05)"
    display "{txt}    → The relationship might just be random"
}

display _n(2) "{txt}THE 'HOW WELL DOES IT WORK?' MEASURE: R-squared"
display "{txt}─────────────────────────────────────────────────────────────────"
display "{txt}  R-squared: " %5.3f e(r2)

display _n "{txt}What this means:"
display "{txt}  '" %4.1f (100*e(r2)) "% of the variation in sales is explained by price'"

display _n "{txt}Think of it like:"
display "{txt}  • R² = 0.00 means price tells you NOTHING about sales"
display "{txt}  • R² = 1.00 means price PERFECTLY predicts sales"
display "{txt}  • R² = 0.70 means price explains a lot (70%), but not everything"

display _n "{txt}The remaining " %4.1f (100*(1-e(r2))) "% comes from other factors:"
display "{txt}  • Weather (rainy days = more coffee?)"
display "{txt}  • Day of week (Mondays = more coffee?)"
display "{txt}  • Random fluctuations"

*******************************************************************************
* ADDING MORE VARIABLES (Multiple Regression)
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  ADDING MORE FACTORS: Does Weather Matter?"
display "{txt}═════════════════════════════════════════════════════════════════"

* Add weather to our data
generate temperature = runiform(40, 85)  // Temperature in degrees F
* Cold weather → more coffee
replace sales = sales + 0.3*(70 - temperature)  // Extra sales when cold

label variable temperature "Temperature (°F)"

display _n "{txt}Now let's include BOTH price AND temperature:"

regress sales price temperature

local coef_price = _b[price]
local coef_temp = _b[temperature]

display _n(2) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  INTERPRETING WITH MULTIPLE FACTORS"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}Price coefficient: " %6.2f `coef_price'
display "{txt}  Meaning: 'Holding temperature constant, a $1 price increase"
display "{txt}            leads to " %5.1f abs(`coef_price') " fewer cups sold'"

display _n "{txt}Temperature coefficient: " %6.2f `coef_temp'
if `coef_temp' < 0 {
    display "{txt}  Meaning: 'Holding price constant, each degree warmer"
    display "{txt}            leads to " %5.1f abs(`coef_temp') " fewer cups sold'"
    display "{txt}  Makes sense: Cold weather = more coffee!"
}

display _n "{txt}The magic phrase: 'HOLDING OTHER FACTORS CONSTANT'"
display "{txt}  This means we're isolating each variable's unique effect."

*******************************************************************************
* COMMON MISTAKES AND MISCONCEPTIONS
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  Common Mistakes (Don't Do These!)"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}❌ MISTAKE #1: Correlation ≠ Causation"
display "{txt}  Just because X and Y move together doesn't mean X causes Y!"
display "{txt}  Example: Ice cream sales and shark attacks (both caused by heat)"

display _n "{txt}❌ MISTAKE #2: P-value Isn't Everything"
display "{txt}  p < 0.05 means 'probably real', NOT 'definitely important'"
display "{txt}  A tiny, meaningless effect can be statistically significant!"
display "{txt}  Example: Price effect of 0.1 cups (p<0.001) vs 30 cups (p<0.001)"
display "{txt}           Both significant, but very different importance!"

display _n "{txt}❌ MISTAKE #3: Ignoring Practical Significance"
display "{txt}  Always ask: 'Is this effect BIG ENOUGH to matter?'"
display "{txt}  Example: If coffee costs $3, effect of 0.5 cups/day = tiny"
display "{txt}           But effect of 50 cups/day = huge!"

display _n "{txt}❌ MISTAKE #4: Extrapolating Too Far"
display "{txt}  Your data goes from $2.50-$4.50"
display "{txt}  Don't predict what happens at $0.50 or $10.00!"
display "{txt}  The relationship might be totally different there."

display _n "{txt}❌ MISTAKE #5: Forgetting Hidden Causes"
display "{txt}  You found: Higher advertising → Higher sales"
display "{txt}  But: Companies advertise more when demand is high"
display "{txt}  → You might be seeing demand, not advertising's effect!"

*******************************************************************************
* PLAIN-LANGUAGE GLOSSARY
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  Jargon Translator"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}📖 DEPENDENT VARIABLE (also called outcome, Y)"
display "{txt}   Plain English: The thing you're trying to understand/predict"
display "{txt}   Example: Sales, performance, profit, satisfaction"

display _n "{txt}📖 INDEPENDENT VARIABLE (also called predictor, X)"
display "{txt}   Plain English: The factor you think might affect the outcome"
display "{txt}   Example: Price, advertising, training, experience"

display _n "{txt}📖 COEFFICIENT"
display "{txt}   Plain English: How much Y changes when X increases by 1 unit"
display "{txt}   Example: -30 means 'each $1 price increase → 30 fewer sales'"

display _n "{txt}📖 STANDARD ERROR"
display "{txt}   Plain English: How uncertain we are about our estimate"
display "{txt}   Smaller = more confident, Larger = less confident"

display _n "{txt}📖 P-VALUE"
display "{txt}   Plain English: 'What's the chance this is just random?'"
display "{txt}   Low (< 0.05) = probably real, High (> 0.05) = might be random"

display _n "{txt}📖 R-SQUARED"
display "{txt}   Plain English: 'How much of the pattern do we explain?'"
display "{txt}   0% = explains nothing, 100% = explains everything"

display _n "{txt}📖 HETEROSKEDASTICITY (het-er-oh-sked-ass-tiss-it-ee)"
display "{txt}   Plain English: 'Prediction errors vary across your data'"
display "{txt}   Example: Easy to predict sales for low-price days,"
display "{txt}            Hard to predict for high-price days"
display "{txt}   Fix: Use 'robust standard errors' (we'll show you how)"

display _n "{txt}📖 MULTICOLLINEARITY (mult-ee-coll-in-ee-air-ity)"
display "{txt}   Plain English: 'Your X variables are too similar'"
display "{txt}   Example: Including both 'revenue' and 'sales volume'"
display "{txt}            (they're basically the same thing!)"
display "{txt}   Problem: Can't tell which one actually matters"

display _n "{txt}📖 RESIDUAL"
display "{txt}   Plain English: 'Prediction error' or 'what we got wrong'"
display "{txt}   Calculation: Actual value - Predicted value"
display "{txt}   Example: Predicted 100 cups, sold 110 → residual = +10"

*******************************************************************************
* PRACTICAL CHECKLIST
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  Your Pre-Flight Checklist Before Running Regression"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}✓ QUESTION: Do I have a clear question?"
display "{txt}  Bad: 'Let's see what relates to sales'"
display "{txt}  Good: 'Does price affect sales?'"

display _n "{txt}✓ DATA: Do I have enough data points?"
display "{txt}  Rule of thumb: At least 10-20 observations per variable"
display "{txt}  2 variables → need 20+ observations"
display "{txt}  10 variables → need 100+ observations"

display _n "{txt}✓ RELATIONSHIP: Have I looked at a scatterplot?"
display "{txt}  Always plot your data first!"
display "{txt}  If it doesn't look linear, regression might not work"

display _n "{txt}✓ CONFOUNDERS: What else might matter?"
display "{txt}  List factors that could affect BOTH your X and Y"
display "{txt}  Try to measure and include them"

display _n "{txt}✓ DIRECTION: Does X cause Y, or Y cause X?"
display "{txt}  Be honest: Can you really claim causation?"
display "{txt}  When in doubt, say 'associated' not 'caused'"

*******************************************************************************
* SUMMARY: THE THREE SENTENCES
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  Everything You Need to Remember (3 Sentences)"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}1. THE COEFFICIENT tells you:"
display "{txt}   'When X increases by 1 unit, Y typically changes by ___ units'"

display _n "{txt}2. THE P-VALUE tells you:"
display "{txt}   'Is this pattern probably real (< 0.05) or maybe just random (> 0.05)?'"

display _n "{txt}3. THE R-SQUARED tells you:"
display "{txt}   'How much of the variation in Y does our model explain?'"

display _n(2) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}EVERYTHING ELSE is just details, diagnostics, or fancy extensions."
display "{txt}Master these three, and you understand regression!"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}Next steps:"
display "{txt}  → Practice with your own data"
display "{txt}  → Always ask: 'Does this make practical sense?'"
display "{txt}  → When reporting, use plain language first, jargon second"
