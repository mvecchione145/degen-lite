
9. Avatar validation rejects nothing like "a single emoji"

Labels: bug, api

routes/auth.js:48 — z.string().trim().max(24) counts UTF-16 code units, and the regex is +-quantified over emoji code points. A typical pictograph is two units, so the schema accepts roughly a dozen emoji while the error message reads "Pick a single emoji", and the schema comment and the column comment both say one.

VARCHAR(24) allows the same. So a member can set a 12-emoji avatar that stretches every leaderboard row they appear in — a mild version of the write-into-someone-else's-row problem the validation was written to prevent.

Suggested fix

Count graphemes rather than code units:

js
const graphemes = (s) =>
  [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length;

then .refine((v) => !v || graphemes(v) === 1, 'Pick a single emoji'). Keeps the 24-byte column headroom for one long ZWJ sequence while enforcing what the message actually promises.
