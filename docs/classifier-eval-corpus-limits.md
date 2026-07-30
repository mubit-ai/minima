# The classifier-evaluation corpus: what it is, and what it is not allowed to mean

Evidence base for MUB-219. Every figure here was re-measured against the ledger at
`~/.minima-harness/minima.db` on 2026-07-31 and carries the command that reproduces it. Nothing in
this document cost anything: every label the arc uses is cached at corpus revision
`r2-observer-steer`, so all four readouts re-run for free.

**The standing rule of this arc: before you quote any rate, state its denominator and what is in
it.** Five settled figures in MUB-214..226 turned out to measure a population they did not name —
the fifth being the catch-all pair corrected in ADR 0003. This pass adds two more: the corpus's day
count (§3.1) and the corroboration rate's denominator (§5.2). Its spine is the denominator table in
§1; everything else hangs off it.

This document contains **no prompt text**. The corpus is one developer's own private development
traffic; only counts, denominators, timestamps, task-type labels and column names appear here.

## How to reproduce anything below

All commands run from `packages/tui`. None of them spends money — the caches are complete
(714/714 panel votes, 476/476 replay labels), so every call is a cache read.

| tag | command |
| -- | -- |
| `[dry]` | `bun run scripts/classifier_eval.ts` |
| `[corr]` | `bun run scripts/classifier_eval.ts --correlate` |
| `[score]` | `bun run scripts/classifier_eval.ts --score --target-correctness=0.85` |
| `[adj]` | `bun run scripts/classifier_eval.ts --adjudicate` |
| `[sql]` | `sqlite3 "file:$HOME/.minima-harness/minima.db?mode=ro" "<statement>"` |

`sqlite3`'s CLI runs each statement in its own scope, so a CTE must stay inside the single
statement that uses it.

**`[adj]` requires `df33e11`** (*fix(classifier-eval): the adjudication reads the shipped
classifier's replay*, ADR [0010](adr/0010-adjudication-reads-the-shipped-classifier.md)). Before that
commit the readout ignored the cached replay labels and scored **0** rows of 177. Every adjudication
figure below was measured at `88de5b3`; on an older tree they all read `0/0 (n/a)`.

---

## 1. The denominator table

Every rate this arc can quote, with the population its denominator actually contains. **A rate is
only comparable to another rate in the same row.**

| n | name | what is in it | what it excludes | where it comes from |
| -- | -- | -- | -- | -- |
| **546** | raw user-role events | every `events.type='user'` row — lead prompts, sub-agent briefs, and harness-authored steer text alike | nothing | `[dry]` · `[sql] SELECT COUNT(*) FROM events WHERE type='user';` |
| **470** | lead-agent user events | user-role rows with `agent_id IS NULL` — the only turns the client classifier ever labels | 76 sub-agent briefs | `[sql] SELECT COUNT(*) FROM events WHERE type='user' AND agent_id IS NULL;` |
| **424** | corpus *occurrences* | lead rows that are not harness steer text and carry text | 76 sub-agent + 46 steer | `[dry]` "distinct prompts in corpus 238 (from 424 messages)" |
| **238** | **corpus entries** | distinct exact prompt texts over those 424 occurrences | repeats collapse; one prompt asked 91 times is one entry | `[dry]` |
| **277** | distinct lead texts | distinct texts before the steer filter | 39 distinct steer texts | `[dry]` "39/277" |
| **714** | panel votes | 238 entries × 3 panelists, at `r2-observer-steer` | — | `[sql] SELECT COUNT(*) FROM consensus_labels WHERE corpus_rev='r2-observer-steer';` |
| **237** | **complete panels** | entries where all three panelists produced a usable label | 1 entry where `gemini-2.5-pro` produced none | `[dry]` |
| **181** | **reference labels** | complete panels that were *unanimous* | 56 split + 1 incomplete | `[dry]`, `[score]` |
| **476** | replay labels | 238 entries × 2 classifier models | — | `[sql] SELECT COUNT(*) FROM classifier_replay_labels WHERE corpus_rev='r2-observer-steer';` |
| **167** | **scored entries, `claude-haiku-4-5`** | entries the shipped model answered **and** the panel resolved | 57 with no reference label, 14 abstentions | `[score]` |
| **181** | **scored entries, `gpt-4o-mini`** | same rule, different model — it abstained 0 times | 57 with no reference label | `[score]` |
| **167** | head-to-head paired set | entries **both** models scored | 14 haiku abstentions, 57 unlabelled | `[score]` head-to-head block |
| **494** | **all routing decisions** | every `routing_decisions` row, however routed | nothing | `[corr]` · `[sql] SELECT COUNT(*) FROM routing_decisions;` |
| **426** | **server-routed decisions** | `routed='server'` — the only rows with a recommendation behind them | 61 pinned + 7 offline | `[corr]` |
| **425** | server-routed **and** labelled | server-routed rows carrying a `task_type` | the single server row with a null task type | `[sql] SELECT COUNT(*) FROM routing_decisions WHERE routed='server' AND task_type IS NOT NULL;` |
| **326** | corpus-bucket pairings | server-routed decisions whose correlated prompt is a corpus entry | 24 landing on steer text, 76 on sub-agent briefs | `[corr]` |
| **177** | override candidates | distinct corpus entries that drove ≥1 server-routed decision | 61 of the 238 entries drove none | `[corr]`, `[adj]` |
| **124** | **adjudicated rows** | candidates surviving the full exclusion cascade — 64 before the boundary, 60 after | 42 panel-split, 8 no replay label, 2 spanning, 1 panel-incomplete | `[adj]` (needs `df33e11`) |
| **10** | `MIN_REPORTABLE_SUPPORT` | the bar below which a percentage is withheld, not printed | — | `classifier_eval_score.ts:412`, `classifier_eval_adjudicate.ts:541` |

Three pairs in that table are the ones most likely to be confused, and they are the subject of §7:

- **238 / 221 / 167** — corpus entries, entries the shipped model gave a label to, entries that were
  actually scored. A numerator that lives in all three answers a different question in each.
- **494 / 426 / 425 / 252** — all decisions, those that asked the service, those the service
  labelled, and the pre-boundary subset of those. §7.3 is a correction resting on this.
- **181 / 167** — `gpt-4o-mini` scored 181 entries alone and 167 alongside the shipped model. Its
  accuracy is 79.0% on the first and 80.8% on the second. §7.4.

---

## 2. Population and denominators

### 2.1 From raw events to the corpus

`[dry]` reports the cascade, and every step is a filter with a stated reason:

```
user-role messages read      546
set aside as sub-agent       76/546 (13.9%)
excluded as harness steer    46/546 (8.4%) raw · 39/277 (14.1%) distinct
unusable (no prompt text)    0/546 (0.0%)
distinct prompts in corpus   238 (from 424 messages)
```

Two notes the line above does not carry:

- **The two steer shares have different populations.** `46/546` is denominated in *all* user events,
  but steer text is only ever found among lead rows — the partition runs on the 470 lead rows only
  (`partitionSteerText(partitionLeadPrompts(rows).lead)`, `classifier_eval.ts:corpusPrompts`). Like
  for like the raw steer share is **46/470 (9.8%)**. `39/277` is already like-for-like: 277 is the
  count of distinct *lead* texts. `[sql] SELECT COUNT(*) FROM (SELECT json_extract(payload,'$.text')
  t FROM events WHERE type='user' AND agent_id IS NULL GROUP BY t);` → 277.
- **Sub-agent exclusion is structural, not a sampling choice.** The runtime gates the client
  classifier on `agentId === null`, so the 76 sub-agent briefs are traffic it never sees.

Length, over the 238 entries (`[dry]`): 150 under 60 chars (63.0%), 80 at 60–199 (33.6%), 8 at
200–999 (3.4%), **zero at 1000+**. `[dry]` also confirms **0 entries over 8000 chars**, so the
shipped `classify()` truncation never bit on this corpus and no conclusion here is about long
prompts.

### 2.2 Labels

| | `claude-haiku-4-5` (shipped) | `gpt-4o-mini` |
| -- | -- | -- |
| replay rows at `r2-observer-steer` | 238 | 238 |
| of which a null (non-)answer | 17 | 1 |
| scored (answered **and** panel resolved) | **167** | **181** |
| counted as `abstained` | 14 | 0 |
| counted as `unassessable` | 3 (of its 17 nulls) | 1 (of its 1) |

`[sql] SELECT model_id, COUNT(*), SUM(task_type IS NULL) FROM classifier_replay_labels WHERE
corpus_rev='r2-observer-steer' GROUP BY 1;` → `claude-haiku-4-5|238|17`, `gpt-4o-mini|238|1`.
`[score]` reports the abstention and no-reference-label splits. §7.2 is about why those two rows
are not the same number.

`claude-haiku-4-5` is the shipped default — `cli/main.ts:751` builds the production classifier from
`config.classifyModel ?? CHEAP_FALLBACK_MODELS[0]`, `classifyModel` defaults to null, and
`classifier_replay.ts:REPLAY_MODELS[0]` is pinned to that by test. Every "shipped model" figure
below is that model.

### 2.3 Decisions

`[corr]` and `[sql] SELECT routed, COUNT(*) FROM routing_decisions GROUP BY routed;`:

| routed | n | share of 494 |
| -- | -- | -- |
| `server` | 426 | 86.2% |
| `pinned` | 61 | 12.3% |
| `offline` | 7 | 1.4% |

Only the 426 asked the service. **All 68 pinned/offline rows fall before the regime boundary**
(`[sql] SELECT routed, ts>=1784738496 AS after, COUNT(*) FROM routing_decisions GROUP BY 1,2;`),
which is the asymmetry §7.3 turns on.

### 2.4 The corpus and the decisions overlap only partly

Of the 238 corpus entries, **177 drove at least one server-routed decision**. Of the remaining 61,
38 drove only pinned/offline decisions and **23 drove no decision at all**. Four entries drove both
kinds. Conversely the 68 pinned/offline decisions correlate to 42 corpus entries.

So "the corpus" (238) and "what the service was asked to route" (177) are different populations
with a 74.4% overlap, and no figure from one transfers to the other.

---

## 3. Dev-traffic skew: this is not a sample of anything

### 3.1 Time

| population | first | last | distinct active days |
| -- | -- | -- | -- |
| all user events | 2026-07-03 | 2026-07-29 | **16** |
| lead user events | 2026-07-03 | 2026-07-29 | **15** |
| **corpus occurrences** | 2026-07-03 | 2026-07-29 | **15** |
| routing decisions | 2026-07-03 | 2026-07-29 | **16** |

`[sql] SELECT date(ts,'unixepoch') d, COUNT(*) FROM events WHERE type='user' GROUP BY d ORDER BY d;`
and the same with `AND agent_id IS NULL`, and over `routing_decisions`.

**The commonly-quoted "16 distinct days" is the day count of the raw event ledger, not of the
corpus.** 2026-07-10 carries 3 user events and 3 routing decisions, all sub-agent, and contributes
**zero** corpus entries. The corpus spans 15 days. This is a small instance of the standing rule and
it is in the table above so nobody has to rediscover it.

27 calendar days elapsed; 15 of them produced corpus traffic. The daily corpus-occurrence counts are
`07-03:42 07-06:82 07-07:2 07-09:3 07-14:9 07-15:11 07-16:4 07-17:12 07-20:23 07-21:27 07-22:62
07-23:106 07-25:36 07-28:4 07-29:1` — two days (07-23 and 07-06) carry 44.3% of all occurrences.

### 3.2 Repetition

Occurrence histogram over the 238 entries (`occurrences : entries`):

```
1x:181   2x:39   3x:10   4x:2   5x:2   6x:1   7x:1   13x:1   91x:1
```

- **181 of 238 entries (76.1%) occur exactly once.** They are single observations, and a per-entry
  claim about any of them is a claim about one keystroke.
- **The top entry is 91 of 424 occurrences (21.5%).** The top five are 28.8% and the top ten 33.3%.
- That top entry drove **80 of the 326** corpus-bucket server-routed decisions, across 79 distinct
  askings.

Collapsing to distinct text is what stops that entry from dominating: the scored set counts it once.
But it means the *decision*-denominated figures (426, 326) and the *entry*-denominated figures (238,
177, 167, 124) are weighted completely differently, and a rate computed over one cannot be quoted
against the other.

### 3.3 Projects and runs

The 424 corpus occurrences come from **164 runs across 13 project keys**. Occurrence shares by
project: 27.4%, 24.3%, 12.7%, 8.7%, 8.5%, 8.5%, 4.0%, 3.8%, 1.2%, then four projects with one
occurrence each. Distinct entries per project: 72, 64, 30, 25, 24, 16, 5, 5, 4, 1, 1, 1, 1. Five
entries appear in more than one project.

### 3.4 What that adds up to

One developer, one machine, 27 calendar days, 15 active, 238 distinct things typed, three quarters
of them typed once. **This is a census of one person's July, not a sample of a population.** There
is no sampling frame, no independence between observations (the same work recurs across runs on the
same day), and no second developer to contrast against. Nothing measured here has a confidence
interval that means what a confidence interval usually means, and no figure here generalizes past
this one developer — not to other users, not to other repositories, not to next month's traffic
from the same developer.

---

## 4. Which cells fall under `MIN_REPORTABLE_SUPPORT` (10)

`MIN_REPORTABLE_SUPPORT = 10` — "the first two-digit denominator"
(`classifier_eval_score.ts:412`). `formatSupported` prints `n/d (n<10, not reportable)`, and the
segmented renderers mark those cells `†`. An em dash means there was nothing to measure at all,
which is not the same as measuring zero.

### 4.1 Reliability bins — and the floor in force

The single most consequential fact in this document. From `[score]`, `claude-haiku-4-5`:

| bin | before | after | whole | reportable (whole)? |
| -- | -- | -- | -- | -- |
| `<0.60` | 9/10 (90.0%) | 1/1† | 10/11 (90.9%) | yes |
| `0.60–<0.70` | 1/1† | 4/4† | 5/5† | no |
| `0.70–<0.75` | 2/4† | — | 2/4† | no |
| **`0.75–<0.80`** | **0/1†** | **—** | **0/1†** | **no** |
| `0.80–<0.90` | 11/16 (68.8%) | 7/7† | 18/23 (78.3%) | yes |
| `>=0.90` | 66/72 (91.7%) | 46/50 (92.0%) | 113/123 (91.9%) | yes |

**Only 3 of 6 bins are reportable for the shipped model over the whole corpus. After the boundary,
only 1 of 6 is.**

`CLASSIFY_CONFIDENCE_FLOOR = 0.75` (`classify.ts:23`, raised from 0.6 in classifier-program PR-7).
`DEFAULT_CONFIDENCE_BOUNDARIES` makes it a bin edge on purpose, so that the bin above it contains
only overrides production accepts. **That bin — `0.75–<0.80` — has n=1 over the whole corpus, n=1
before the boundary, and n=0 after it.** The shipped floor sits at the edge of the emptiest bin in
the instrument, and its immediate neighbourhood is a single observation which the classifier got
wrong.

For `gpt-4o-mini` the same bin is **empty in every segment**, along with `0.60–<0.70`; 2 of its 6
bins are reportable (`0.80–<0.90` n=48, `>=0.90` n=125).

The consequence is precise and worth stating in MUB-219's own words: **this corpus cannot say
whether 0.75 is the right floor.** It has one observation adjacent to it. What it can say is what
each candidate floor *would have admitted*, which `[score]`'s tail-based sweep reports — and there
the entire difference between the floor in force and the derived floor (0.6) is **9 corpus entries**
(`vs the floor in force  whole  lower +7R/+2W`; coverage 156/167 vs 147/167). Seven of those nine
would have been right. A floor change argued from this corpus is a floor change argued from nine
observations, two of which point the other way.

### 4.2 Per-task-type recall and precision

`[score]`, `claude-haiku-4-5`, 10 task types × {recall, precision} = 20 cells per segment:

| segment | reportable (d≥10) | `†` (1–9) | `—` (nothing) |
| -- | -- | -- | -- |
| whole (167 scored) | **10** | 8 | 2 |
| before (104 scored) | **10** | 4 | 6 |
| after (62 scored) | **2** | 14 | 4 |

Whole-corpus reportable cells: `code` recall (15) and precision (20), `qa` recall/precision (12/12),
`creative` recall/precision (15/15), `tool_use` recall/precision (86/75), `other` recall/precision
(35/31). Everything else is single-digit or empty in every segment: `summarization` (1/1 both ways),
`extraction` (recall — , precision 0/3), `reasoning` (2/2 and 2/3), `translation` (1/1 both ways),
`rag` (recall — , precision 0/6).

**After the boundary, the only reportable per-type cells for the shipped model are `tool_use` recall
(46/50) and `tool_use` precision (46/46).** Any per-type claim about the later regime is a claim
about `tool_use` and nothing else.

### 4.3 The panel's per-type unanimity — where the renderer does *not* mark

`[dry]`'s panel report prints per-task-type unanimity with **no support gate at all**:
`MIN_REPORTABLE_SUPPORT` is defined in `classifier_eval_score.ts` and `classifier_eval_adjudicate.ts`
and is not imported by `consensus_panel.ts`. So that block prints, unmarked:

```
reasoning        2/11 (18.2%)      rag              0/9 (0.0%)
extraction       0/3 (0.0%)        summarization    1/3 (33.3%)
classification   0/1 (0.0%)        translation      1/1 (100.0%)
```

Reportable at n≥10: `tool_use` (114), `other` (72), `code` (38), `creative` (28), `qa` (25),
`reasoning` (11) — **6 of 11**. The other five carry percentages the rest of the instrument would
suppress. In particular `translation 1/1 (100.0%)` and `rag 0/9 (0.0%)` are not findings.

Two further properties of that block: its denominators are *"complete panels where at least one
panelist named this type"*, so they **sum to 305 over a corpus of 238** — a split prompt lands in
the denominator of every type named on it. And they are entry counts, not vote counts.

### 4.4 The by-service-label breakdown

This is the grouping a routing rule could actually condition on — at routing time the reference
label is unknown and the service's label is in hand. Measured, `[adj]`:

| segment | reportable buckets (n≥10) | withheld (`support < 10`) |
| -- | -- | -- |
| before (n=64) | `other`=29, `qa`=27 | `code`=6, `reasoning`=2 |
| after (n=60) | `other`=35, `code`=12 | `qa`=4, `tool_use`=4, `reasoning`=2, `summarization`=1, `translation`=1, `creative`=1 |
| aggregate (n=124) | `other`=64, `qa`=31, `code`=18 | `reasoning`=4, `tool_use`=4, `summarization`=1, `translation`=1, `creative`=1 |

**Three of eight buckets are reportable in the aggregate, two of four before the boundary, two of
eight after.** `breakdownByServiceLabel` sets `correctionShare` and `harmShare` to `null` below 10
and the renderer prints `unreportable (support N is single-digit)` — the share is **withheld, not
zero**. So `creative n=1 +1/-0` is not "overriding `creative` always works"; it is one row. And the
aggregate column blends two label authors, so per the readout's own caveat it may only be quoted
beside both segments.

The reportable buckets are the actionable finding, and they are in §6.3.

---

## 5. The correlation basis (MUB-225)

### 5.1 There is no join

`routing_decisions` has no key to the prompt that caused it: `task_label` is a 40-character display
truncation and the decision's `event_id` resolves to a `routing` event whose payload carries no task
text. The link is inferred — *the most recent user prompt in the same run at or before the
decision's timestamp* (`correlateDecisions`, `classifier_eval_correlate.ts`). **Everything
downstream of it inherits that inference.**

`[corr]`, over the 426 server-routed decisions:

```
correlated                   426/426 (100.0%)
corroborated                 356/426 (83.6%)
uncorroborated               70
nothing to compare           0
corpus 326 (76.5%) · steer 24 (5.6%) · subagent 76 (17.8%) · unusable 0
```

`corroborate` (`classifier_eval_correlate.ts`) strips the truncation ellipsis, collapses whitespace
on both sides, and asks whether the display label is a **leading substring** of the paired prompt.
It is a signal derived from the label, never prompt text.

### 5.2 The 83.6% is over a population the measurement never uses

Cross-tabulating bucket against corroboration over the same 426 pairings:

| prompt bucket | corroborated | uncorroborated |
| -- | -- | -- |
| **corpus** | **325** | **1** |
| steer | 0 | 24 |
| subagent | 31 | 45 |

**69 of the 70 uncorroborated pairings are outside the corpus bucket** — and `groupByCorpusEntry`
drops every non-corpus pairing before anything is measured. So the headline 83.6% is denominated in
426 pairings, 100 of which are structurally excluded from every downstream figure. Over the
pairings that actually feed the measurement it is **325/326 (99.7%)**, and at entry level
**176 of 177 candidates are corroborated, 1 is not, 0 are unassessable**.

That is a seventh instance of the standing rule, and it runs the *favourable* way for once: quoting
83.6% as the reliability of the pairings behind the classifier's scores understates them badly. The
100% steer failure rate is expected and is the check working — a decision paired to harness steer
text has a display label drawn from the real task, which cannot be a prefix of the steer text.

Reproduce: `[corr]` for the marginals; the cross-tab is `correlateDecisions(partitionServiceRouted(
db.listRoutingDecisions()).serviceRouted, db.listUserPrompts())` grouped on
`(promptBucket, corroboration)`.

**`[adj]` now confirms this directly on the rows that matter.** Its "what the result rests on" block
reports **corroborated pairings 124/124 (100.0%) · uncorroborated 0 · nothing to compare 0**, and
the `corroborated rows only` line reproduces the all-rows outcome exactly (aggregate `124 · +82`,
before `64 · +40`, after `60 · +42`). The single uncorroborated corpus entry did not survive into
the scored set.

**What that licenses, and what it does not.** The adjudication's sensitivity line exists to show how
much of the result depends on the weaker pairings; here the answer is **none of it** — dropping
every uncorroborated pairing changes no cell. So the outcome cells in §6.3 carry their full nominal
weight *with respect to the correlation heuristic*: the "it's only a heuristic, not a join" caveat,
which is the loudest caveat on the whole instrument, does not eat into these numbers on this ledger.

That is a narrow licence and it should not be over-read in three ways. It says the display label was
a clean prefix of the paired prompt on all 124 rows; it does **not** independently verify the
pairing (a corroborated prefix match is strong evidence, but §5.3(1) still holds). It is a property
of *this* traffic, where prompts are rarely rewritten before dispatch — on traffic with more
rewriting the corroborated share would fall and this line would start to bite. And it removes only
the correlation caveat: every other limit in this document — 124 rows from one developer, three of
eight service-label buckets reportable, regime confounded with working day — is untouched by it.

### 5.3 What an uncorroborated pairing *does* to a downstream rate

ADR [0004](adr/0004-unassessable-is-not-uncorroborated.md) governs the distinction: `unassessable`
is a **non-observation** and leaves both the numerator and the denominator; `uncorroborated` is an
**outcome** and stays in the denominator. Folding the third value into either side is wrong in
opposite directions (understating the rate and charging the system with failures it never had, or
overstating it and vouching for nothing). On this ledger `unassessable` reads 0 for corroboration —
the decision was structural, not numeric.

The direction of the error, which "the pairing might be wrong" does not by itself tell you:

1. **`corroborate` can only fail informatively.** A 40-character prefix match is not something a
   wrong pairing produces by accident, so *corroborated ⇒ almost certainly correctly paired*. The
   converse does not hold: a prompt rewritten before dispatch (a replan prefix prepended) fails the
   check while being the prompt that caused the decision. **Uncorroborated means "unknown", not
   "wrong"** — which is why the readout reports them rather than discarding them.
2. **The mirroring drifts pessimistically.** `collapseWhitespace` mirrors `runtime.ts:shortLabel`
   rather than importing it; the module documents that if `shortLabel` ever transforms *more*, the
   comparison stops matching and the corroboration rate **falls**. Drift can make this check
   understate, never make it vouch for a pairing it should not.
3. **`entryCorroboration` is pessimistic by construction.** *Any* assessable pairing that failed
   makes the whole entry uncorroborated (`classifier_eval_adjudicate.ts:280`). The entry-level
   corroborated count can understate agreement; it can never overstate it.
4. **A mis-pairing corrupts exactly one field, and it biases toward the override.** In
   `buildOverrideCandidates` the reference label and the replayed harness label are both keyed on
   the entry's exact text — those are correct regardless. Only `serviceLabel` arrives through the
   heuristic. `outcomeOf` is `serviceRight = serviceLabel === referenceLabel`, `harnessRight =
   harnessLabel === referenceLabel`, and the four cells are `no-op` / `harm` (service right) and
   `correction` / `both-wrong` (service wrong). A mis-paired service label is drawn from the
   service's marginal distribution rather than from the truth, so it agrees with the reference less
   often than a correct pairing would. **Mis-pairings therefore move rows out of `{no-op, harm}` and
   into `{correction, both-wrong}`, inflating `net = corrections − harms`.** The bias runs toward
   recommending the override and toward a lower derived floor.

On this ledger that bias is bounded by one entry (§5.2), which is the useful thing to know: the
adjudication's dependence on the heuristic is real in principle and nearly nil in practice **here**.
It would not stay that way on traffic with more rewriting before dispatch.

### 5.4 One gap the readout does not flag

`[corr]` prints `⚠ sub-agent dec → corpus 0` — no sub-agent decision was paired to a lead prompt.
The reverse is not counted: **2 lead-agent decisions were paired to a sub-agent prompt** (decision
agent × prompt bucket: lead→corpus 326, lead→steer 24, **lead→subagent 2**, sub→subagent 74). Both
land in the `subagent` bucket and are therefore excluded from every corpus figure, so nothing
downstream is affected — but the tripwire is one-sided, and a reader should not read the `0` as
covering both directions.

---

## 6. The regime split

`REGIME_BOUNDARY_TS = 1784738496` (2026-07-22T16:41:36Z), the instant GitHub published v0.14.0.
ADR [0003](adr/0003-regime-boundary.md) settles why it stays there rather than moving to the v0.14.2
label-author change, and is not re-litigated here. Read it before quoting any segmented figure. Its
three load-bearing conclusions:

- The ledger **cannot identify this instant** — no decision falls in the 19-hour gap it sits in, so
  every instant in that gap yields the same split. The release record pins it; the data is silent.
- **Regime is perfectly confounded with working day** (12 days / 1 day / 3 days by release; the two
  segments used here are disjoint blocks of calendar days). Segmenting is an honest **refusal to
  blend**, not evidence about the classifier.
- The catch-all rate **stepped 45.7 points under a byte-identical labeller** before the boundary —
  larger than the 30.9-point step across it. A rate that moves without a release is a finding about
  the traffic.

### 6.1 Support on each side

| population | before | after | spanning | total |
| -- | -- | -- | -- | -- |
| **corpus entries** | 159 | 77 | 2 | 238 |
| **all decisions** | 321 | 173 | — | 494 |
| server-routed decisions | 253 | 173 | — | 426 |
| server-routed **and** labelled | 252 | 173 | — | 425 |
| pinned/offline decisions | 68 | **0** | — | 68 |
| scored entries, shipped model | 104 | 62 | 1 | 167 |
| scored entries, `gpt-4o-mini` | 114 | 65 | 2 | 181 |
| **adjudicated rows** | 64 | 60 | — | 124 |
| of those, override *harms* | **3** | **0** | — | 3 |

`[score]` for the corpus and scored rows; `[sql] SELECT CASE WHEN ts>=1784738496 THEN 'after' ELSE
'before' END seg, COUNT(*), SUM(task_type='other'), SUM(task_type IS NULL) FROM routing_decisions
GROUP BY 1;` for the decisions.

An entry `spanning` is one exact prompt text asked in **both** regimes. It is in neither segment's
figure, because attributing it to one would credit that regime with the other's traffic.

### 6.2 Report zeros as bounds, never as absences

Several cells read zero. **A zero over n is not a demonstrated absence.** With 0 events in n
independent trials the exact one-sided 95% upper bound on the underlying rate is
`1 − 0.05^(1/n)` (the "rule of three", ≈ 3/n):

| the zero | n | one-sided 95% upper bound |
| -- | -- | -- |
| **override harms after the boundary** | **60** | **≤ 4.9%** |
| override harms, service label `other`, after | 35 | ≤ 8.2% |
| override harms, service label `code`, after | 12 | ≤ 22.1% |
| pinned/offline decisions after the boundary | 173 | ≤ 1.7% |
| `tool_use` precision errors, shipped model, after | 46 | ≤ 6.3% |
| `tool_use` precision errors, shipped model, whole | 75 | ≤ 3.9% |
| `gpt-4o-mini` abstentions | 238 | ≤ 1.3% |
| uncorrelated decisions | 426 | ≤ 0.7% |
| entries over 8000 chars (truncation) | 238 | ≤ 1.3% |

So the sentence "the override never harms after the boundary" must be written **"harms after the
boundary are bounded above by 4.9% at 95% confidence, on n=60"** — and even that borrows an
independence assumption §3.4 says this corpus does not have. The before segment is the reason this
matters rather than being pedantry: **it has 3 harms in 64 rows (4.7%)**, which sits comfortably
inside the after segment's 4.9% bound. **The two segments' harm rates are not distinguishable on
this evidence.** Reading the after segment's 0 as "the override became safe" is exactly the
inference the bound forbids.

### 6.3 The adjudication, measured

`[adj]` at `88de5b3` scores 124 of 177 candidates. The exclusion cascade is fixed
(`service-label-overridden → no-service-label → spans-regime-boundary → no-replayed-label →
no-cached-label → panel-split → panel-incomplete`) and resolves:

```
corpus entries offered       177
scored                       124        before 64 · after 60
set aside                     53
    panel labelled it and disagreed         42
    replay gave no usable label              8   (shipped-model abstentions among candidates)
    decisions span the regime boundary       2
    panel incomplete                         1
    label was the client's, not the service's 0  (client_task_type is null on all 494 rows — §8)
    no service label on the initial route     0
    no cached label at this corpus rev        0
```

That matches ADR 0003's independently-derived `103/72 (2 spanning)` at the pre-panel stage, narrowed
to 64/60 once the panel exclusions apply. **The largest single exclusion is the panel disagreeing
with itself on 42 of 177 candidates** — a fact about how hard this corpus is, not about the
classifier, and the same 23.6% split rate §2 reports over the whole corpus.

#### The four-way outcome

| cell | aggregate | before | after |
| -- | -- | -- | -- |
| override **corrects** | 85/124 (68.5%) | 43/64 (67.2%) | 42/60 (70.0%) |
| override **harms** | 3/124 (2.4%) | 3/64 (4.7%) | 0/60 (**bound: ≤4.9%**, §6.2) |
| override is a **no-op** | 25/124 (20.2%) | 11/64 (17.2%) | 14/60 (23.3%) |
| **both wrong** | 11/124 (8.9%) | 7/64 (10.9%) | 4/60 (6.7%) |
| net (corrections − harms) | **+82** | **+40** | **+42** |

All three columns clear `MIN_REPORTABLE_SUPPORT`. Per the readout's own caveat the aggregate blends
two label authors and may only be quoted beside both segments.

#### The derived floor, and where the instrument declines to give one

| population | derived floor | at the shipped 0.75 |
| -- | -- | -- |
| aggregate | **0.20** | 109 overridden · 76 corrects · 2 harms · net +74 |
| before the boundary | **0.20** | 54 overridden · 37 corrects · 2 harms · net +35 |
| after the boundary | **NONE** | 55 overridden · 39 corrects · 0 harms · net +39 |

**Record the `NONE` accurately: it is the instrument refusing to overclaim, not a missing number.**
The rule for a derived floor is that corrections must exceed harms at that threshold *and at every
stricter one*. In the after segment harms are 0 at every threshold, so the rule never fails on
harms — it fails at the top: at 0.99 the segment has **0 rows overridden**, so corrections are 0,
net is 0, and 0 does not exceed 0. The renderer says so in as many words: *"the net first crosses
positive at 0.20 and then falls back, so read the sweep rather than quoting a floor."*

So the correct sentence is **not** "no floor could be derived after the boundary because the
evidence is bad". It is: *over 60 rows the override nets positive at every threshold that admits any
rows at all, and the derivation rule declines to name one because the strictest candidate threshold
admits none.* The sweep is the artifact; the floor is a convenience the rule withholds here.

Two further things the readout reports about what the result rests on:

- **corroborated pairings 124/124 (100.0%)**, and the corroborated-only outcome equals the all-rows
  outcome in every segment. §5.2 covers what that licenses.
- **1 row was scored on the initial route because the ladder's rungs disagreed.** One prompt's
  recovery-ladder rungs are one observation, scored on the label an override would have replaced;
  the disagreement is counted rather than averaged away.

#### What this does and does not settle

It settles the direction on this corpus: **overriding the service's label with the shipped
classifier's corrects far more than it harms — 85 against 3.** That is not a marginal result and it
does not depend on the correlation heuristic (§5.2).

It does not settle the floor. The sweep's `net` is not monotonic in the threshold, the derived floor
of 0.20 is far below the 0.75 in force, and the gap between them is **15 rows** (109 overridden at
0.75 vs 124 at 0.20) carrying **9 corrections and 1 harm**. A floor recommendation resting on 15
rows of one developer's traffic is a recommendation resting on 15 rows — and §4.1's separate finding
stands beside it: the reliability curve has n=1 in the bin at 0.75, so this corpus cannot say
whether the floor in force is well placed either. **The adjudication says overriding is worth doing;
neither readout says where to put the threshold.**

---

## 7. The standing rule, worked

### 7.1 Same numerator, three questions — the self-report mode

113 replay rows from the shipped model carry a self-reported confidence of exactly 0.95, and all
113 carry a label. Three rates use that numerator:

| rate | denominator | what it answers |
| -- | -- | -- |
| **103/167 = 61.7%** | scored entries | *of the entries this evaluation actually measured, how many did the classifier claim 0.95 on* |
| 113/221 = 51.1% | entries with a stored non-null label | *of everything the classifier answered, …* |
| 113/238 = 47.5% | corpus entries | *of everything it was asked, …* |

Only the first is the mode of the reliability curve, because the reliability curve is denominated in
scored entries. The other two are correct answers to questions nobody asked.

```
[sql] SELECT confidence, COUNT(*) FROM classifier_replay_labels
      WHERE model_id='claude-haiku-4-5' AND corpus_rev='r2-observer-steer' GROUP BY 1 ORDER BY 1;
[sql] WITH u AS (SELECT prompt_hash FROM consensus_labels WHERE corpus_rev='r2-observer-steer'
        GROUP BY prompt_hash HAVING COUNT(*)=3 AND COUNT(DISTINCT task_type)=1 AND SUM(task_type IS NULL)=0)
      SELECT r.confidence, COUNT(*) FROM classifier_replay_labels r JOIN u ON u.prompt_hash=r.prompt_hash
      WHERE r.model_id='claude-haiku-4-5' AND r.corpus_rev='r2-observer-steer' AND r.task_type IS NOT NULL
      GROUP BY 1 ORDER BY 1;
```

### 7.2 A stored null is not an abstention

The shipped model stored 17 null labels. `[score]` reports **14 abstentions**, not 17.

`scoreReplay` (`classifier_eval_score.ts`) assigns outcomes in a fixed precedence:
`unreplayed → unassessable → abstained → correct/incorrect`. A null label on an entry the panel
*could not resolve* is `unassessable` — the `unassessable` test comes first and absorbs it. Three of
the 17 nulls landed on entries with no reference label and are absorbed that way; 14 remain
abstentions.

Per ADR 0004 that precedence is right: a corpus entry with no reference verdict is a
non-observation, and counting the classifier's silence there as an abstention would credit it with
declining a question that was never scoreable. But it means **the raw null count is not the
abstention count, and quoting 17 as "abstentions" overstates by 21%.**

Arithmetic check: 238 entries − 57 with no reference label = 181; 181 − 14 abstentions = **167
scored**, which is the number `[score]` reports.

### 7.3 The correction: "34.3% → 74.6%"

**Outcome: the pair is reproducible, exactly. It is not retired. It is mis-denominated, and the
correction is already in the tree.**

The prior read-only pass that briefed this document believed neither figure could be reproduced from
the current ledger. **That is wrong, and this run overrides it.** Both reproduce to the decimal:

```
[sql] SELECT CASE WHEN ts>=1784738496 THEN 'after' ELSE 'before' END seg,
             COUNT(*) n, SUM(task_type='other') other_n
      FROM routing_decisions GROUP BY 1;
   after|173|129      ->  129/173 = 74.566% -> 74.6%
   before|321|110     ->  110/321 = 34.267% -> 34.3%
```

**Where it came from.** `63619ae feat(tui): pin the regime boundary as a constant, with its
provenance (MUB-224)` — the commit that first wrote `REGIME_BOUNDARY_TS` into the tree. Its body:
*"Catch-all 110/321 (34.3%) then 129/173 (74.6%) — the ticket's exact figures."* MUB-224 had quoted
the pair in prose with nothing in the tree behind it; that commit reproduced it and pinned the
constant.

**What is wrong with it.** The two denominators are not the same kind of population. The before
segment's 321 decomposes — **within that segment, by a segment-scoped query** — like this:

```
[sql] SELECT CASE WHEN ts>=1784738496 THEN 'after' ELSE 'before' END seg,
             routed, (task_type IS NULL) tt_null, COUNT(*)
      FROM routing_decisions GROUP BY 1,2,3 ORDER BY 1,2,3;
   before|offline|1|7        before|pinned|1|61
   before|server |1|1        before|server |0|252
   after |server |0|173
```

| | before | after |
| -- | -- | -- |
| all decisions | **321** | **173** |
| pinned/offline (never asked the service; all carry a null `task_type`) | 68 | **0** |
| server-routed but carrying no `task_type` | 1 | 0 |
| **like-for-like** (`routed='server' AND task_type IS NOT NULL`) | **252** | **173** |
| catch-all | 110 | 129 |

The "before" 321 contains 68 rows that never asked the service and cannot have been given a
catch-all label by it; the "after" 173 contains none. So 34.3% is a catch-all rate over a population
that is partly rows the service never labelled, and part of the gap it opens against 74.6% is that
asymmetry rather than the classifier. **Like for like it is 110/252 (43.7%) → 129/173 (74.6%): a
30.9-point step, not a 40.3-point one.**

**Derive 252 by selection, never by subtraction** — one query, no arithmetic:

```
[sql] SELECT CASE WHEN ts>=1784738496 THEN 'after' ELSE 'before' END seg,
             COUNT(*) n, SUM(task_type='other') other_n
      FROM routing_decisions WHERE routed='server' AND task_type IS NOT NULL GROUP BY 1;
   before|252|110      after|173|129
```

This matters more than it looks, and it is the standing rule applied to the correction itself. The
usual retelling of this catch reaches 252 as *"321 minus the 68 pinned/offline and the 69 with no
task type — except those overlap by 68, so subtract 69, not 137."* **The overlap arithmetic is
right and the framing is not:** 321 is a *segment* count while 68 and 69 are usually quoted as
*whole-ledger* counts, and mixing the two is the same category error the section exists to correct.
It only comes out right because every pinned/offline row happens to fall before the boundary — a
coincidence of this ledger, not a property of the decomposition. Had one pinned row landed after the
boundary, `321 − 69` would still be correct but the whole-ledger 69 would not be the number to
subtract, and nothing in the retelling would flag it.

Within the before segment the overlap statement is exactly this: all 68 pinned/offline rows carry a
null `task_type` and **exactly one server-routed row does**, so that segment's 69 null-task-type
rows are 68 + 1, not two disjoint sets of 68 and 69. Stated segment-scoped, it needs no correction
and no caveat.

**The correction is already recorded** — twice, independently of this document. `be9a22b fix(tui):
close the review's findings on the wiring seam` amended the `REGIME_BOUNDARY_TS` docstring, which
now carries the full denominator note (`classifier_eval.ts:56-62`), and ADR 0003 §"Every rate in
this arc must keep naming its denominator" states it as the arc's fifth such catch.

**How to quote it in MUB-219.** *"Like for like — routed to the service and carrying a label — the
service's catch-all rate steps 110/252 (43.7%) before the v0.14.0 boundary to 129/173 (74.6%)
after."* Never the bare pair. And per ADR 0003, that step is not attributable to the classifier:
regime is confounded with working day, and a 45.7-point step occurs earlier under a byte-identical
labeller.

### 7.4 One model, two accuracies — the head-to-head trap

`[score]` reports `gpt-4o-mini` twice, correctly, and a reader who lifts the wrong one gets the
model-switch decision wrong:

| figure | denominator | value |
| -- | -- | -- |
| its own accuracy block | 181 entries it scored | **143/181 = 79.0%** |
| the head-to-head block | 167 entries **both** models scored | **135/167 = 80.8%** |

The 14-entry difference is precisely the shipped model's abstentions, which `gpt-4o-mini` answered
and got 8 of 14 right. Against the shipped model's 148/167 (88.6%), the honest gap is **7.8 points**
(the head-to-head block's figure), not the 9.6 points that 88.6 − 79.0 produces. And the readout's
own caveat is the one that actually matters: `only A / only B right = 18 / 5` over 167 — the two
models are not merely 7.8 points apart, they are right on different prompts, and the switch's real
cost is those 23 entries.

---

## 8. What this corpus does not support

Stated so that a reader six months from now can check a proposed claim against the list.

**Per-task-type claims.** Out of reach for every type except `tool_use`, `other`, `code`, `qa` and
`creative`, and after the boundary out of reach for everything except `tool_use` (§4.2).
`summarization`, `translation`, `classification`, `extraction` and `rag` have single-digit or zero
support in every cut of the instrument — panel unanimity, replay recall/precision, and the
by-service-label breakdown alike. `rag 0/9 (0.0%)` and `translation 1/1 (100.0%)` are not results.

**Calibration claims, and any recommended floor.** The reliability curve has 3 reportable bins of 6
for the shipped model, 1 of 6 after the boundary, and **n=1 in the bin the shipped floor sits at**
(§4.1). This corpus cannot say whether 0.75 is well placed, and cannot say whether the classifier is
over- or under-confident in the 0.6–0.8 region.

**Two different readouts derive a "floor" and they are not the same quantity — do not quote them
against each other.** `[score]`'s floor is the self-report threshold at which the *replayed
classifier's own accuracy* clears a caller-stated target, denominated in 167 scored entries; its
whole-corpus derivation moves 9 entries against the floor in force (+7R/+2W). `[adj]`'s floor is the
threshold at which *overriding the service's label* nets positive, denominated in 124 adjudicated
rows; its aggregate derivation of 0.20 moves 15 rows against the floor in force (9 corrections, 1
harm). Different question, different denominator, different rule. Neither supports a floor change on
its own: 9 entries and 15 rows of one developer's traffic, and §6.3's after-segment `NONE` is the
derivation rule declining to name a floor at all.

What the adjudication *does* support is the direction — 85 corrections against 3 harms over 124
rows, robust to dropping every weakly-corroborated pairing (§5.2). "Overriding is worth doing on
this traffic" is supported. "Set the floor to X" is not.

**Anything about the taxonomy in the abstract.** ADR
[0005](adr/0005-panel-answers-shipped-classify-instruction.md) is explicit. Panelists receive
`CLASSIFY_SYSTEM` verbatim and are parsed by `parseClassification`, so the panel is a
stronger-models replay of the exact call under test. That makes **181/237 (76.4%) unanimity a
statement about agreement *under the shipped instruction*, not about the taxonomy.** "The taxonomy
is bad" and "the instruction is thin" are not distinguishable from these labels — separating them
needs a second panel run at a different instruction over the same corpus, and per ADR 0005 that is a
new key, not a `corpus_rev` bump. Nor is unanimity truth: three models trained on overlapping public
text can be wrong together, and the readout calls its own labels pseudo-gold.

**Anything about production's self-report.** The replay omits the session-context size hint
(`[session context: ~N tokens already in play …]`) that production appends after truncation. The
ledger cannot supply N — a user event's payload is `{role, text}` and no column anywhere is a token
count — and a corpus entry could not carry one anyway, since its unit is distinct *text* and each of
one entry's askings had a different context behind it. **Direction:** `CLASSIFY_SYSTEM` defines
confidence as sureness of *both* labels, and a hint introducing scope the prompt text does not show
adds difficulty uncertainty, so omitting it should read **higher** confidence here than production
sees at the same prompt — which makes any floor transplanted from this curve slightly
**permissive**. That is an argument from the instruction's wording, not a measurement, and it is
unfalsifiable on this ledger. It does **not** bias the classifier-versus-panel comparison, because
ADR 0005 has the panel omit the same hint; the bias is against production.

**Anything requiring the client-side classifier's recorded output.** `client_task_type`,
`client_difficulty`, `client_confidence` and `classify_disagreement` are **null on all 494
decisions** (`[sql] SELECT COUNT(*), SUM(client_task_type IS NULL), SUM(client_confidence IS NULL),
SUM(classify_disagreement IS NULL), SUM(client_difficulty IS NULL) FROM routing_decisions;` →
`494|494|494|494|494`). Consequences: (a) the whole replay exists because the ledger has no recorded
client label to mine; (b) `serviceLabelOverridden` excludes 0 candidates, so the adjudication cannot
demonstrate that no caller override occurred — `runtime.ts` skips the client classifier entirely
when a caller supplies a task type and no column records that, which is why `be9a22b` re-documented
it as a tripwire rather than a proof; (c) no agreement/disagreement rate between the client and the
service can be computed from this ledger at all. Only `heuristic_task_type` and `cluster_key_version`
carry data, on 39 of 494 rows.

**Anything about the two regimes as a treatment.** ADR 0003: regime is perfectly confounded with
working day, no version's traffic interleaves with another's, and the catch-all rate steps 45.7
points *under a byte-identical labeller* inside the earlier regime. Segmenting is a refusal to
blend. It is not evidence about the classifier, and no reader should promote it to one.

**Any absence.** §6.2. Every zero cell gets a one-sided bound or it does not get quoted.

**Any generalization past one developer.** §3.4. 238 distinct prompts, 181 of them typed once, 15
active days, one machine, one person, one July. There is no sampling frame. Aggregate figures
describe *this traffic*; they are not estimates of a rate in any population, and no interval
computed from them means what an interval usually means.

## What would move these limits

Falsifiable, in rough order of cost:

1. ~~Land the adjudication wiring.~~ **Done** — `df33e11` / ADR 0010. `[adj]` went from 0 scored to
   124 at zero spend, and §6.3 is the result. The next increment on this axis is not free: the
   largest exclusion is now the **42 candidates the panel split on**, and resolving those needs a
   tie-break rule or a larger panel, not more wiring.
2. **A second panel run at a fuller instruction over the same corpus** (ADR 0005's future work),
   which is the only thing that separates "the taxonomy is ambiguous" from "the instruction is
   thin". Needs its own cache key; ~$3 of panel spend.
3. **A replay at a synthetic session-context N**, which converts the directional argument in §8 into
   a measurement.
4. **A second developer's ledger.** Nothing else in this list touches the limit in §3.4, and no
   amount of analysis of this ledger can.
