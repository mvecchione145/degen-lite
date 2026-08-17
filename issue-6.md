
6. README says 151 smoke-test checks; there are 153

Labels: docs

README.md:64. scripts/smoke-test.mjs has 153 check() call sites (154 matches including the function definition itself).

A hardcoded count drifts every time a check is added. Consider having the script print the total and dropping the number from the README, or asserting the expected count inside the script so a mismatch fails the run.
