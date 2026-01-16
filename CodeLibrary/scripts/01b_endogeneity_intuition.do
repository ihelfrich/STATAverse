*******************************************************************************
* Understanding Endogeneity: An Intuition-First Guide
* Purpose: Build deep understanding BEFORE introducing technical terms
* Author: STATAverse
* Last updated: 2026-01-15
*
* Philosophy: If you can't explain it simply, you don't understand it well enough.
*             We'll use everyday examples, visual intuition, and plain language.
*******************************************************************************

clear all
set more off
set seed 2026

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}     Understanding a Tricky Problem in Data Analysis"
display "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}Let's build intuition with a story, then connect it to your research."
display "{txt}═════════════════════════════════════════════════════════════════"

*******************************************************************************
* THE STORY: Ice Cream and Shark Attacks
*******************************************************************************

display _n(2) "{txt}THE STORY: A Misleading Relationship"
display "{txt}─────────────────────────────────────────────────────────────────"

display _n "{txt}Imagine you collected data from beaches and noticed:"
display "{txt}  • Days with HIGH ice cream sales → MORE shark attacks"
display "{txt}  • Days with LOW ice cream sales → FEWER shark attacks"

display _n "{txt}Question: Does ice cream cause shark attacks?"

display _n "{txt}Your gut says NO, right? But the data DOES show a relationship!"

display _n "{txt}The REAL story:"
display "{txt}  • Hot weather → people buy ice cream (connection #1)"
display "{txt}  • Hot weather → people swim more → more shark encounters (connection #2)"
display "{txt}  • Temperature is the HIDDEN CAUSE of both"

display _n "{txt}This is called a 'confounding variable' or 'hidden cause problem.'"
display "{txt}When we ignore it, we get the WRONG answer about ice cream."

display _n(2) "{txt}Let's see this with made-up data..."

* Generate the ice cream/shark attack example
set obs 100
generate temperature = runiform(60, 95)  // Temperature in degrees F

* Ice cream sales depend on temperature
generate ice_cream_sales = -100 + 2*temperature + rnormal(0, 10)

* Shark attacks ALSO depend on temperature (people swim more when hot)
generate shark_attacks = -5 + 0.1*temperature + rnormal(0, 1)

* Make sure we don't have negative values
replace shark_attacks = 0 if shark_attacks < 0

display _n "{txt}Now let's see what happens if we IGNORE temperature..."

* The WRONG analysis (ignoring the hidden cause)
quietly regress shark_attacks ice_cream_sales
local wrong_coef = _b[ice_cream_sales]

display _n "{err}❌ WRONG ANALYSIS (ignoring temperature):"
display "{err}  Result: Ice cream coefficient = " %5.3f `wrong_coef'
display "{err}  This suggests ice cream causes shark attacks!"
display "{err}  But we KNOW that's not true..."

* The RIGHT analysis (accounting for temperature)
quietly regress shark_attacks ice_cream_sales temperature
local right_coef = _b[ice_cream_sales]

display _n "{txt}✓ CORRECT ANALYSIS (including temperature):"
display "{txt}  Result: Ice cream coefficient = " %5.3f `right_coef'
display "{txt}  Now ice cream has little/no effect!"
display "{txt}  The temperature explains both, so ice cream's 'effect' disappears."

display _n "{txt}KEY INSIGHT:"
display "{txt}  When there's a HIDDEN CAUSE affecting both your X and Y,"
display "{txt}  you'll see a relationship that ISN'T really there."
display "{txt}  This is the core problem we need to solve!"

*******************************************************************************
* REAL RESEARCH EXAMPLE: Training and Performance
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  REAL RESEARCH EXAMPLE: Employee Training"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}Question: Does employee training improve performance?"

display _n "{txt}The problem:"
display "{txt}  • Good managers → invest in training (connection #1)"
display "{txt}  • Good managers → have high-performing teams (connection #2)"
display "{txt}  • Manager quality is HIDDEN in your data"

display _n "{txt}If you just compare:"
display "{txt}  'Trained employees' vs 'Untrained employees'"
display "{txt}  You're ALSO comparing:"
display "{txt}  'Good managers' vs 'Bad managers'"
display "{txt}  → Training looks better than it really is!"

display _n(2) "{txt}Let's simulate this..."

clear
set obs 500

* Generate the HIDDEN CAUSE: manager quality (we don't observe this!)
generate manager_quality = rnormal(50, 15)

* Training depends on manager quality (good managers train more)
generate training_hours = 10 + 0.5*manager_quality + rnormal(0, 5)
replace training_hours = 0 if training_hours < 0

* Performance depends on BOTH training AND manager quality
* Let's say training truly adds 2 points per hour
* But manager quality adds 1 point per unit
generate performance = 20 + 2*training_hours + 1*manager_quality + rnormal(0, 5)

label variable manager_quality "Manager quality (UNOBSERVED)"
label variable training_hours "Training hours"
label variable performance "Employee performance"

display _n "{txt}TRUE relationships:"
display "{txt}  • Training → +2 points per hour (the real effect)"
display "{txt}  • Manager quality → +1 point per unit (hidden confounder)"

display _n "{txt}THE WRONG WAY (what most people do first):"
display "{txt}─────────────────────────────────────────────────────────────────"

regress performance training_hours

local biased = _b[training_hours]
display _n "{err}❌ We estimated: Training → +" %5.2f `biased' " points per hour"
display "{txt}   True effect:   Training → +2.00 points per hour"
display "{txt}   Bias:          " %+5.2f (`biased' - 2)
display _n "{err}   We're giving training TOO MUCH credit!"
display "{err}   Some of that 'effect' is really the manager's quality."

*******************************************************************************
* WHAT MAKES THIS PROBLEM TRICKY?
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  Why This Problem is Hard to Spot"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}Three things make this problem sneaky:"

display _n "{txt}1. THE HIDDEN VARIABLE ISN'T IN YOUR DATA"
display "{txt}   • You can't just 'add it to your analysis'"
display "{txt}   • It might be unmeasurable (quality, ability, motivation)"
display "{txt}   • Or you just didn't collect it"

display _n "{txt}2. THE RELATIONSHIP LOOKS REAL"
display "{txt}   • You'll see p < 0.05 (statistically significant)"
display "{txt}   • The data genuinely shows a pattern"
display "{txt}   • But it's the WRONG pattern!"

display _n "{txt}3. IT'S EVERYWHERE"
display "{txt}   • Education and earnings (ability is hidden)"
display "{txt}   • Medicine and health (severity is hidden)"
display "{txt}   • Marketing and sales (demand is hidden)"

*******************************************************************************
* SOLUTION PREVIEW: Instrumental Variables
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  The Solution: Finding a Special Kind of Variable"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}We need something called an 'instrument' (fancy word, simple idea):"

display _n "{txt}An instrument is a variable that:"
display "{txt}  ✓ DOES affect your treatment/policy (training, education, etc.)"
display "{txt}  ✓ Does NOT directly affect your outcome (except through treatment)"
display "{txt}  ✓ Is NOT related to the hidden confounder"

display _n "{txt}Example for training:"
display "{txt}  • Instrument: Company POLICY change requiring training"
display "{txt}  • This affects WHO gets trained"
display "{txt}  • But the policy itself doesn't directly affect performance"
display "{txt}  • And it's unrelated to manager quality"

display _n(2) "{txt}Let's create an instrument in our data..."

* Create an instrument: corporate policy change (exogenous shock)
generate training_policy = rbinomial(1, 0.5)  // Random policy exposure

* Policy affects training, but NOT through manager quality
replace training_hours = training_hours + 20*training_policy

display _n "{txt}Now we can use this 'instrument' to get the TRUE effect:"

* Two-stage process (we'll explain this more later)
* Stage 1: How does policy affect training?
quietly regress training_hours training_policy
predict training_predicted

* Stage 2: How does PREDICTED training affect performance?
quietly regress performance training_predicted

local iv_estimate = _b[training_predicted]
display _n "{txt}✓ WITH INSTRUMENT: Training → +" %5.2f `iv_estimate' " points per hour"
display "{txt}  True effect:        Training → +2.00 points per hour"
display "{txt}  Bias:               " %+5.2f (`iv_estimate' - 2)
display _n "{txt}  Much closer to the truth!"

*******************************************************************************
* VISUAL INTUITION: What's Really Happening
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  Visual Intuition: The Hidden Cause Problem"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}Think of it like this:"

display _n "{txt}WRONG MODEL (what we see):"
display "{txt}  Training ───────→ Performance"
display "{txt}  (We think training directly causes good performance)"

display _n "{txt}REALITY (what's actually happening):"
display "{txt}                Manager Quality"
display "{txt}                   ↙          ↘"
display "{txt}           Training     Performance"
display "{txt}                 ↘          ↗"
display "{txt}  (Manager quality causes BOTH, creating fake relationship)"

display _n "{txt}WITH INSTRUMENT (our solution):"
display "{txt}  Policy → Training → Performance"
display "{txt}           (no back door through manager quality!)"

*******************************************************************************
* PLAIN-LANGUAGE GLOSSARY
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  Plain-Language Glossary"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}Let's connect the intuition to the technical terms:"

display _n "{txt}📖 ENDOGENEITY (en-doj-en-ay-ity)"
display "{txt}   Intuition: Hidden cause problem"
display "{txt}   What it means: Your X variable is entangled with other stuff"
display "{txt}                  that also affects Y"
display "{txt}   Why it matters: You'll get the WRONG answer about X's effect"

display _n "{txt}📖 CONFOUNDER (or OMITTED VARIABLE)"
display "{txt}   Intuition: The hidden cause"
display "{txt}   What it means: A variable that affects both X and Y,"
display "{txt}                  but you didn't measure it (or can't)"
display "{txt}   Example: Manager quality, ability, motivation"

display _n "{txt}📖 INSTRUMENTAL VARIABLE (IV)"
display "{txt}   Intuition: A special tool that helps isolate the real effect"
display "{txt}   What it means: A variable that:"
display "{txt}                  • Affects your treatment/policy"
display "{txt}                  • But only affects outcome THROUGH treatment"
display "{txt}   Example: Policy change, lottery, geographic distance"

display _n "{txt}📖 BIAS"
display "{txt}   Intuition: Being systematically wrong"
display "{txt}   What it means: Your estimate is consistently too high or too low"
display "{txt}   NOT the same as: Sampling error (random variation)"

display _n "{txt}📖 EXOGENEITY (ex-oj-en-ay-ity)"
display "{txt}   Intuition: No hidden cause problem"
display "{txt}   What it means: X is NOT entangled with other stuff affecting Y"
display "{txt}   This is what we WANT: Clean, interpretable relationships"

*******************************************************************************
* WHEN SHOULD YOU WORRY ABOUT THIS?
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  When Should You Worry About Hidden Causes?"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}❓ Ask yourself these questions:"

display _n "{txt}1. REVERSE CAUSALITY?"
display "{txt}   Could Y actually cause X (instead of X causing Y)?"
display "{txt}   Example: Does advertising increase sales?"
display "{txt}            OR do companies advertise more when sales are high?"

display _n "{txt}2. SELECTION BIAS?"
display "{txt}   Do certain types of people/firms choose treatment?"
display "{txt}   Example: Do better students choose harder courses?"
display "{txt}            Then grades might not reflect course difficulty!"

display _n "{txt}3. OMITTED VARIABLES?"
display "{txt}   Is there something you DIDN'T measure that matters?"
display "{txt}   Example: Studying education's effect on earnings"
display "{txt}            But ability affects both education AND earnings"

display _n "{txt}4. MEASUREMENT ERROR?"
display "{txt}   Is your X measured with substantial error?"
display "{txt}   Example: Self-reported hours worked vs actual hours"
display "{txt}            Errors can create bias toward zero"

display _n "{txt}If you answered YES to any, you have an endogeneity problem!"

*******************************************************************************
* WHAT TO DO ABOUT IT
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  Your Options for Dealing with Hidden Causes"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}Option 1: MEASURE THE CONFOUNDER"
display "{txt}  • Best if possible!"
display "{txt}  • Just add it to your regression"
display "{txt}  • Problem: Often can't measure (ability, quality, motivation)"

display _n "{txt}Option 2: FIXED EFFECTS (panel data)"
display "{txt}  • If you observe same units over time"
display "{txt}  • Removes time-invariant confounders automatically"
display "{txt}  • Example: Compare each firm to ITSELF over time"

display _n "{txt}Option 3: INSTRUMENTAL VARIABLES"
display "{txt}  • Find a variable that affects X but not Y (except through X)"
display "{txt}  • Uses only 'clean' variation in X"
display "{txt}  • Hardest to find good instruments"

display _n "{txt}Option 4: RANDOMIZED EXPERIMENT"
display "{txt}  • Gold standard!"
display "{txt}  • Random assignment breaks the link to confounders"
display "{txt}  • Often not feasible in business/social science"

display _n "{txt}Option 5: BE TRANSPARENT ABOUT LIMITATIONS"
display "{txt}  • Sometimes we can't fix it"
display "{txt}  • Report results as ASSOCIATIONS, not CAUSAL EFFECTS"
display "{txt}  • Discuss what confounders might be present"

*******************************************************************************
* PRACTICAL WORKFLOW
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  Your Workflow: From Question to Answer"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}STEP 1: Start with your research question"
display "{txt}  Example: 'Does training improve performance?'"

display _n "{txt}STEP 2: Draw the relationships"
display "{txt}  • What causes your treatment (training)?"
display "{txt}  • What causes your outcome (performance)?"
display "{txt}  • What affects BOTH?"

display _n "{txt}STEP 3: List potential confounders"
display "{txt}  • Manager quality ✓"
display "{txt}  • Employee motivation ✓"
display "{txt}  • Prior experience ✓"

display _n "{txt}STEP 4: Can you measure them?"
display "{txt}  • Manager quality: Maybe (ratings, tenure)"
display "{txt}  • Motivation: Hard (no good measure)"
display "{txt}  • Experience: Yes (years in role)"

display _n "{txt}STEP 5: Control for what you can"
display "{txt}  {result}regress performance training experience manager_rating"

display _n "{txt}STEP 6: Acknowledge what you can't fix"
display "{txt}  'Our estimates may be biased upward if trained"
display "{txt}   employees are more motivated (unmeasured)'"

display _n "{txt}STEP 7: Look for an instrument OR sensitivity analysis"
display "{txt}  • Instrument: Policy change, randomized rollout"
display "{txt}  • Sensitivity: How big would confounder need to be?"

*******************************************************************************
* SUMMARY: THE BIG PICTURE
*******************************************************************************

display _n(3) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}  The Big Picture"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}🎯 The Core Problem:"
display "{txt}   When X and Y are both caused by something hidden,"
display "{txt}   they'll appear related even if X doesn't cause Y."

display _n "{txt}🔍 How to Spot It:"
display "{txt}   Ask: Could there be a hidden cause of both?"
display "{txt}   Look for: Selection, reverse causality, omitted variables"

display _n "{txt}🛠️  How to Fix It:"
display "{txt}   Measure confounders → Add them to model"
display "{txt}   Panel data → Use fixed effects"
display "{txt}   Good instrument → Use IV regression"
display "{txt}   Can't fix → Be transparent about limitations"

display _n "{txt}📊 How to Report It:"
display "{txt}   Be honest: 'This is an association, not causal proof'"
display "{txt}   Or: 'We use [method] to address endogeneity'"
display "{txt}   Always: Discuss remaining limitations"

display _n(2) "{txt}═════════════════════════════════════════════════════════════════"
display "{txt}Remember: Perfect causal inference is rare outside experiments."
display "{txt}Your job is to:"
display "{txt}  1. Think carefully about confounders"
display "{txt}  2. Address what you can"
display "{txt}  3. Be transparent about what you can't"
display "{txt}═════════════════════════════════════════════════════════════════"

display _n "{txt}Next step: See module 01_endogeneity_simulator.do for"
display "{txt}technical implementation with real Stata code."
