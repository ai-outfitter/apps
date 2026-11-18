# The daily brief is written for accounts with no saved goals

When an account had no personal goals saved, the model call for the daily brief could be refused before it started, because the answer format for the goal field took a form that strict JSON output does not accept. The brief then failed with "could not be written by the model". The format now asks for an empty goal in that case. A new eval, `evals/daily-brief`, found this and measures how well each model writes the brief.
