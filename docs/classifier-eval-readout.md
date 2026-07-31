# Phase-1 readout: is routing limited by classifier accuracy or by calibration?

Deliverable of MUB-219, and the synthesis the whole confidence arc exists to produce. It answers one
question — *is routing quality limited by how often the harness classifier is wrong, or by how badly
its label self-report is calibrated?* — and it answers the two rival candidates the ticket raises
beside it: the task-type taxonomy, and the override channel itself.

**The answer is none of the first three.** Accuracy is not the constraint. The label self-report is
uninformative but is not the constraint either. The taxonomy is not shown to be the defect and this
instrument cannot show it. The binding constraint is the fourth candidate: **the override channel
has never run in production, so a classifier that is right on 110 of 124 adjudicated rows — where
the label it would replace is right on 28 — has corrected exactly nothing.**

Every figure below was re-measured on 2026-07-31 against the ledger at `~/.minima-harness/minima.db`
and carries the free command that reproduces it. Nothing in this document cost anything. Where a
measurement disagreed with the brief that commissioned it, the measurement is what is printed and
the disagreement is named in §0.5.

This document contains **no prompt text**. The corpus is one developer's own private development
traffic; only counts, denominators, hash prefixes, timestamps, task-type labels and column names
appear here.

Vocabulary is `CONTEXT.md`'s and is used strictly. **Label self-report** is the harness classifier
model's asserted certainty about its own task-type and difficulty labels jointly.
**Classification confidence** is the *service's* certainty in the task type it settled on.
**Label token probability** is the quantity MUB-220–223 propose to introduce and which nothing emits
today. The bare word is never used for any of them.

---

## §0 — How to reproduce

### 0.1 The commands

All run from `packages/tui`. **None of them spends anything**: the panel votes, replay labels and
self-consistency draws are all cached at corpus revision `r2-observer-steer`, so every call is a
cache read. `FORCE_COLOR` is set in this environment and leaks into subprocesses; `env -u
FORCE_COLOR` is the clean invocation.

| tag | command |
| -- | -- |
| `[dry]` | `bun run scripts/classifier_eval.ts` |
| `[corr]` | `bun run scripts/classifier_eval.ts --correlate` |
| `[score]` | `bun run scripts/classifier_eval.ts --score --target-correctness=0.85` |
| `[adj]` | `bun run scripts/classifier_eval.ts --adjudicate` |
| `[self]` | `bun run scripts/classifier_eval.ts --self-consistency` |
| `[sql]` | `sqlite3 "file:$HOME/.minima-harness/minima.db?mode=ro" "<statement>"` |

`[dry]` prints both the corpus cascade and the reference-panel report. `[adj]` requires `df33e11`
(ADR [0010](adr/0010-adjudication-reads-the-shipped-classifier.md)); before that commit it scored
**0** of 177 rows while 476 paid labels sat in the ledger.

### 0.2 The corpus and the ledger

- Corpus revision `r2-observer-steer`; ledger `~/.minima-harness/minima.db`, opened read-only.
- 238 corpus entries — distinct exact prompt texts — from 424 lead-agent occurrences, from 546 raw
  user-role events. 76 set aside as sub-agent, 46 as harness steer text.
- Caches, all complete: **714/714** panel votes (`[sql] SELECT model_id, COUNT(*) FROM
  consensus_labels WHERE corpus_rev='r2-observer-steer' GROUP BY 1;` → three panelists at 238 each),
  **476/476** replay labels, **2330/2380** self-consistency draws.

### 0.3 Total arc spend, and the part of it that is not recoverable

The eval lanes do **not** book their spend into the ledger. `budget_events` is session-scoped agent
spend — the harness's own turns — and no `classifier_eval*` module writes to it
(`[sql] SELECT scope_key, kind, COUNT(*) FROM budget_events GROUP BY 1,2;` returns two session
scopes and nothing else). ADR [0006](adr/0006-spend-ceiling-binds-outstanding-work.md) already
records why: *"no row stores a price."* So realized spend survives only in commit bodies.

| lane | realized | where recorded | complete? |
| -- | -- | -- | -- |
| panel (MUB-216) | **$2.6693** | `23fc234` body — *"681 calls, 680 labelled, 1 unusable, 0 failed. $2.6693 realized against a $2.7911 projection (96%)"* | covers 681 of the 714 cached votes |
| replay (MUB-218) | **$0.1841** | `2c215d5` body — *"Arc spend: $0.1841 over two runs. 476/476 labels cached"* | yes, 476/476 |
| self-consistency (MUB-217) | **not recoverable** | nowhere — no commit body and no ledger row | — |

**Recorded arc spend: $2.8534.** Two gaps travel with it and neither is closable from here.

- The panel's 714 cached votes exceed that run's 681 calls by **33 votes = 11 prompts × 3
  panelists**, bought by an earlier partial run whose price is recorded nowhere.
- The self-consistency leg has **no realized figure anywhere I can find**. The brief for this ticket
  quotes ~$1.72; I could not verify it and I am not quoting it as measured. What *is* free to
  re-derive is the projection `[dry]` prints for that lane: **$2.0587** for the full 2380 draws,
  minus **$0.0435** still outstanding on 50 draws, leaves **$2.0152 projected for the 2330 draws in
  hand**. On both other lanes realized came in *below* projection (panel 96%, replay 80%), so
  $2.0152 reads as an upper bound rather than an estimate.

So the honest total is **$2.8534 measured plus a self-consistency leg of at most ~$2.02** — an arc
of roughly **$4.87 or less, of which $2.85 is a measurement and the rest is a projection.**

Reproducing this document costs **$0.0000**. `[dry]` confirms: panel outstanding 0 calls, replay
outstanding 0 calls, self-consistency outstanding 50 calls · $0.0435 — and nothing here runs that
lane's outstanding work.

### 0.4 The denominator authority

**[`docs/classifier-eval-corpus-limits.md`](classifier-eval-corpus-limits.md) is the denominator
authority for this arc**, and §5 of this document imports from it by reference rather than
re-deriving it. Its §1 denominator table is the spine; when a number here and a number there
disagree about what a population contains, that document wins.

Its standing rule governs every rate below: **before you quote a rate, state its denominator and
what is in it.** That rule has now caught **seven** settled figures in MUB-214..226 that measured a
population they did not name — five recorded in ADR
[0003](adr/0003-regime-boundary.md), plus the corpus's day count (limits §3.1) and the corroboration
rate's denominator (limits §5.2). The brief for this ticket said six; the count in the tree is
seven, and limits §5.2 names itself the seventh in as many words.

### 0.5 Where my measurement disagreed with the brief

The brief that commissioned this document supplied predictions to check. Six did not survive
contact. **The run wins; these are what the instrument printed today.**

1. **The derived floor is not 0.60 on both models.** The brief said *"derived floor lands at 0.60 on
   both models and both segments because every threshold already clears the target."* It does for
   the shipped `claude-haiku-4-5` — 0.6 before, after and whole. For `gpt-4o-mini` `[score]` prints
   `underdetermined — target-unreachable` before the boundary and whole, and **0.9** after. That
   model never clears the 85% target on the whole corpus at any threshold, so no floor is derivable
   for it at all. The claim holds for the shipped model only.
2. **The self-consistency direction mix is 79 / 67 / 83 over 229 compared prompts**, i.e.
   overconfident 34.5%, underconfident **29.3%**, indistinguishable **36.2%**. The brief said 34.5 /
   28.8 / 36.7, which is 79 / 66 / 84. One prompt sits in a different arm.
3. **The direction mix is denominated in 229 prompts, not 235 entries and not 238.** The brief
   introduced the lane as *"measured over 235/238 corpus entries, 2330 draws"* and then quoted the
   mix, which is a different population: `[self]` prints `corpus entries sampled 235/238`, `draws
   present 2330/2380` and `prompts compared 229` as three separate lines, and 6 entries answered
   every draw but declined every one, so they have no modal label and contribute no gap. The
   renderer names all three; the brief blended two of them.
4. **Mean absolute gap is +0.2014**, not +0.2015. Bin means are **+0.1054** at `0.80–<0.90` (brief:
   +0.1038) and **+0.0962** at `>=0.90` (brief: +0.0953).
5. **Not every prompt has 10 draws, and `[self]` says so with a warning the brief did not carry**:
   *"⚠ the ledger's depth does not match the stated n=10 … draws per sampled entry 4-10."* By
   `[sql]` the depth histogram over 235 sampled prompts is `10:230, 9:1, 7:1, 6:1, 4:2`. Per ADR
   [0009](adr/0009-self-consistency-samples.md) each prompt is bucketed at the band **its own draws**
   can resolve, ±1/(2·draws), not at the band the `--samples` flag implies. Five prompts therefore
   sit in a wider band than ±0.05.
6. **The panel's realized spend recorded in the tree is $2.6693, not $2.80** (§0.3).

One prediction I want to record as *confirmed*, because it is load-bearing and easy to get wrong:
the service's own label is wrong on **96 of 124** adjudicated rows. Verified two ways — from
`[adj]`'s cells (85 corrections + 11 both-wrong = 96) and from the module's own definition,
`serviceRight = row.serviceLabel === row.referenceLabel` at
`packages/tui/src/minima/classifier_eval_adjudicate.ts:293`.

---

## §1 — Accuracy or calibration? (AC 1)

### The answer

**Neither.** Routing quality is not limited by how often the harness classifier is wrong, and it is
not limited by how badly its label self-report is calibrated. Both were measured; both were
reported; both are dominated by §3.

The label self-report *is* broken — it carries no usable information about either correctness or the
model's own repeatability. That is a real defect and §6 keeps it on the list. It is not the
**binding** constraint, for a reason that is measured rather than argued: there is almost nothing
for a floor to select on, and the entire decision the floor controls is nine corpus entries.

### 1.1 Accuracy is 88.6%, and it is four times the label it would replace

`[score]`, shipped classifier `claude-haiku-4-5`:

```
correct   before 89/104 (85.6%)   after 58/62 (93.5%)   spanning 1/1†   whole 148/167 (88.6%)
```

**Denominator: 167 scored corpus entries** — entries the shipped classifier answered *and* the panel
resolved unanimously. It excludes 57 entries with no reference label (panel split or incomplete) and
14 abstentions, from a corpus of 238. Cross-checked independently:

```
[sql] WITH u AS (SELECT prompt_hash, MIN(task_type) ref FROM consensus_labels
        WHERE corpus_rev='r2-observer-steer' GROUP BY prompt_hash
        HAVING COUNT(*)=3 AND SUM(task_type IS NULL)=0 AND COUNT(DISTINCT task_type)=1)
      SELECT COUNT(*), SUM(r.task_type=u.ref) FROM classifier_replay_labels r
      JOIN u ON u.prompt_hash=r.prompt_hash
      WHERE r.model_id='claude-haiku-4-5' AND r.corpus_rev='r2-observer-steer'
        AND r.task_type IS NOT NULL;                              -> 167 | 148
```

The comparison that decides whether accuracy is the constraint is not this one, though — it is the
like-for-like one on the rows where an override would actually have fired. From `[adj]`,
**denominator: the same 124 adjudicated rows for both sides**:

| on the 124 adjudicated rows | right | wrong |
| -- | -- | -- |
| the **harness classifier** (corrections + no-ops · harms + both-wrong) | **110/124 (88.7%)** | 14 |
| the **service's own label** (no-ops + harms · corrections + both-wrong) | **28/124 (22.6%)** | **96** |

88.7% against 22.6%, same rows, same reference. **Accuracy cannot be the binding constraint on a
channel whose whole job is to replace a label that is right a quarter as often.** Raising 88.7% by a
few points is worth strictly less than the 82-row margin already sitting unused.

### 1.2 The label self-report carries no information — twice over, the second time with no reference

**Against correctness (MUB-218, `[score]`).** The reliability curve is non-monotone. Denominator:
167 scored entries, binned on the raw pre-floor label self-report.

| bin | before | after | whole | reportable (n≥10)? |
| -- | -- | -- | -- | -- |
| `<0.60` | 9/10 (90.0%) | 1/1† | **10/11 (90.9%)** | yes |
| `0.60–<0.70` | 1/1† | 4/4† | 5/5† | no |
| `0.70–<0.75` | 2/4† | — | 2/4† | no |
| **`0.75–<0.80`** | **0/1†** | **—** | **0/1†** | **no** |
| `0.80–<0.90` | 11/16 (68.8%) | 7/7† | **18/23 (78.3%)** | yes |
| `>=0.90` | 66/72 (91.7%) | 46/50 (92.0%) | **113/123 (91.9%)** | yes |

Three of six bins are reportable whole-corpus; one of six after the boundary. Among the three, **the
lowest bin (90.9%) beats the middle bin (78.3%) by 12.6 points and sits 1.0 point under the top.**
A signal on which the least-sure answers are as good as the surest is not ranking anything.

On the priced-not-shipped `gpt-4o-mini` the two reportable bins are outright **inverted**:
`0.80–<0.90` 39/48 (81.3%) sits *above* `>=0.90` 99/125 (79.2%). Higher self-report, lower
correctness.

**Against its own repeatability (MUB-217, `[self]`).** This is the result MUB-218 alone cannot
reach, because it reads **no reference labels at all** — 10 draws of the shipped classifier per
prompt at the provider's default temperature, the actual production distribution, with the modal
(task_type, difficulty) **pair** frequency as the comparand because `CLASSIFY_SYSTEM` defines the
self-report as sureness of both labels jointly.

```
modal-label frequency (PAIR)  1847/2330 (79.3%)      <- denominator: 2330 draws
mean self-report              0.8193                  <- denominator: 229 compared prompts
mean gap (self - empirical)  +0.0064
mean ABSOLUTE gap            +0.2014
direction mix (band ±1/(2·draws), one denominator, sums to it)
  overconfident        79/229 (34.5%)
  underconfident       67/229 (29.3%)
  indistinguishable    83/229 (36.2%)
```

> **The mean gap of +0.0064 is a cancellation artifact and must never be quoted alone.** Read naively
> it says the classifier is perfectly calibrated. It is not: the mean **absolute** gap is +0.2014 and
> the direction mix is near-even in both directions. The classifier is wrong by a lot in both
> directions and the errors cancel. This is precisely the sign flip ADR 0009 built three guards to
> expose — `meanGap`, `meanAbsGap` and the direction mix are one indivisible value for exactly this
> reason. **A reader who lifts the headline mean out of this block draws the opposite conclusion from
> the evidence.**

The sign flips almost exactly at the shipped floor. **Denominator on each row: compared prompts whose
*mean* label self-report over their own labelled draws fell in that bin, summing to 229.**

> **These bins are not the bins in the reliability table above, and the two must never be read
> against each other.** `[score]`'s bins are 167 **scored entries** binned on the **single stored
> replay row's** self-report. `[self]`'s bins are 229 **compared prompts** binned on the **mean of
> that prompt's labelled draws** (`classifier_self_consistency_report.ts:250` averages
> `confidences`). Different population, different quantity, same bin edges. It shows up immediately
> at the floor: `0.75–<0.80` holds **n=1** in `[score]` and **n=5** in `[self]`, and neither number
> is wrong. This is the arc's standing rule applied to two instruments that happen to share an axis.

| bin | prompts | mean gap | mean abs | overconfident | underconfident |
| -- | -- | -- | -- | -- | -- |
| `<0.60` | 33 | **−0.4150** | +0.4268 | 2/33 (6.1%) | **29/33 (87.9%)** |
| `0.60–<0.70` | 11 | −0.1328 | +0.2237 | 2/11 (18.2%) | 7/11 (63.6%) |
| `0.70–<0.75` | 10 | −0.0359 | +0.2153 | 3/10 (30.0%) | 6/10 (60.0%) |
| **`0.75–<0.80`** | **5** | +0.0434 | +0.2146 | 3/5† | 2/5† |
| `0.80–<0.90` | 45 | +0.1054 | +0.1823 | **23/45 (51.1%)** | 10/45 (22.2%) |
| `>=0.90` | 125 | +0.0962 | +0.1451 | 46/125 (36.8%) | 13/125 (10.4%) |

By regime, overconfidence rises from 45/152 (29.6%) before the boundary to 33/75 (44.0%) after. The
worst individual prompts self-report 0.950 and see their own modal pair recur **1/10** and **2/10** —
gaps of +0.85 and +0.75 (hash prefixes `0664dfaf5a15`, `f0c30c074d55`).

**Why the second measurement matters for AC 1 in a way the first cannot.** `[score]` shows the label
self-report does not predict *correctness*, and a reader can always answer that the panel is wrong,
or the taxonomy is ambiguous, or the reference is pseudo-gold. `[self]` shows the same number does
not predict **the model's own repeatability**, using no reference labels, no panel, and no taxonomy
judgment — only whether the model says the same thing twice. **That failure cannot be blamed on the
panel, the taxonomy or the reference.** The number is uninformative about the model's own behaviour,
full stop.

The `[self]` caveat travels with it: this measures self-consistency, **not** correctness. Ten
identical wrong answers score 1.0. The two readouts are complementary, not substitutes — which is
why AC 1 needs both.

### 1.3 …and yet calibration is not the constraint either, because the floor has nothing to select on

Three measurements, all from `[score]`, denominator 167 scored entries:

1. **The classifier essentially never reports below the floor.** 20 of 167 (12.0%) sit under
   `CLASSIFY_CONFIDENCE_FLOOR = 0.75`; 147/167 (88.0%) sit at or above it. The floor rejects one
   entry in eight.
2. **The bin the floor sits at is the emptiest in the instrument.** `0.75–<0.80` has **n=1** over the
   whole corpus, n=1 before the boundary and **n=0** after (limits §4.1) — *in `[score]`, over 167
   scored entries; the identically-edged `[self]` bin is a different population and reads n=5, see
   the note in §1.2*.
   `DEFAULT_CONFIDENCE_BOUNDARIES` makes 0.75 a bin edge on purpose so the bin above it holds only
   overrides production accepts — and that bin holds one observation, which the classifier got
   wrong. The mode of the whole distribution is 0.95: `[sql] SELECT confidence, COUNT(*) FROM
   classifier_replay_labels WHERE model_id='claude-haiku-4-5' AND corpus_rev='r2-observer-steer'
   GROUP BY 1;` → 113 rows at exactly 0.95 of 221 labelled rows, 103 of them in the scored 167.
3. **Every candidate floor already clears the target.** At the stated 85% target the whole-corpus
   tail correctness runs 88.5% (≥0.60), 88.1% (≥0.70), 89.1% (≥0.75, in force), 89.7% (≥0.80), 91.9%
   (≥0.90). The derivation returns the **lowest** candidate threshold that clears the target and
   keeps clearing it at every stricter one; since the lowest candidate on the list already clears, it
   returns 0.60. **That is the rule finding nothing to choose between, not a finding that 0.60 is
   good.**

**The entire difference between the floor in force and the derived floor is nine corpus entries.**
`[score]` prints it as `vs the floor in force  whole  lower +7R/+2W` — coverage 156/167 at 0.60
against 147/167 at 0.75, seven of the nine right and two wrong. A label token probability that
perfectly reordered the self-report would be reordering nine entries.

### 1.4 The verdict, and its own limit

Accuracy: 88.6% against the panel; 88.7% against the service's 22.6% on identical rows. Not the
constraint.

Calibration: no relationship to correctness, no relationship to repeatability, mean gap a
cancellation artifact, ±0.20 absolute error in both directions. Genuinely broken — and still not the
constraint, because it gates a decision worth nine entries on a channel that is switched off.

The limit on this verdict, stated so it cannot be over-read: **this corpus cannot say whether 0.75 is
the right floor** (limits §4.1, §8). It has one observation adjacent to it. What §1 claims is
narrower and is what the evidence supports — that *wherever* the floor is put, between 0.20 and 0.95,
it changes at most nine entries of 167 and at most fifteen rows of 124, and that is small against the
82-row margin §3 leaves on the table.

---

## §2 — Is the taxonomy the defect? (AC 2)

### The answer

**Not established, and this instrument cannot establish it.** The ticket's third candidate — *"if
three strong models rarely agree on a task type, the task-type taxonomy itself is incoherent"* — is
not what the consensus panel shows. Three strong models from three different training lineages agree
unanimously **three quarters of the time**.

### 2.1 What the panel measured

From `[dry]`'s panel report, and independently re-derived by `[sql]`:

```
[sql] WITH p AS (SELECT prompt_hash, COUNT(*) votes, SUM(task_type IS NULL) nulls,
                        COUNT(DISTINCT task_type) types
                 FROM consensus_labels WHERE corpus_rev='r2-observer-steer' GROUP BY 1)
      SELECT COUNT(*), SUM(votes=3 AND nulls=0), SUM(votes=3 AND nulls=0 AND types=1),
             SUM(votes=3 AND nulls=0 AND types>1), SUM(NOT(votes=3 AND nulls=0)) FROM p;
      -> 238 | 237 | 181 | 56 | 1
```

**Unanimity is 181/237 (76.4%). Denominator: complete panels — entries on which all three panelists
produced a usable label.** Over the 238-entry corpus it is 181/238 (**76.1%**), and the one-entry
difference is the single prompt `gemini-2.5-pro` produced no label for. The two are different
questions: 76.4% is *"when the panel could answer, how often did it agree"*; 76.1% is *"of everything
we asked, how often did we get a reference label."* Both are printed above so neither can be quoted
without the other.

Pairwise agreement, **denominators differing by one for the same reason** — a fact the summary rate
hides:

| pair | agree | denominator |
| -- | -- | -- |
| `gemini-2.5-pro` vs `gpt-5.6-sol` | 202 | 237 (**85.2%**) |
| `claude-opus-4-8` vs `gpt-5.6-sol` | 200 | 238 (**84.0%**) |
| `claude-opus-4-8` vs `gemini-2.5-pro` | 185 | 237 (**78.1%**) |

Three quarters unanimous and 78–85% pairwise is not *"three strong models rarely agree."* On the
face of it the taxonomy is not the defect.

### 2.2 What ADR 0005 forbids concluding from that

ADR [0005](adr/0005-panel-answers-shipped-classify-instruction.md) is explicit and binding here.
Panelists receive `CLASSIFY_SYSTEM` **verbatim** and are parsed by `parseClassification`, both
imported from `classify.ts` rather than restated. The panel is a strictly-stronger-models replay of
the exact call under test.

**So 76.4% is unanimity *under the shipped instruction*, and is not evidence about the taxonomy in
the abstract.** ADR 0005 rejected a bespoke reference instruction precisely because a stronger model
answering a better question is not a measurement of the model — and the price of that choice is that
*"the taxonomy is incoherent"* and *"the instruction is thin"* are **not separable from these
labels**. A fuller instruction with per-type definitions and tie-break guidance would likely have
raised unanimity; this run cannot tell whether it would.

This cuts both ways and I am stating both. A high number does not exonerate the taxonomy, because
the instruction may be doing the work. But a **low** number would have been decisive regardless of
the instruction, because it would have destroyed the reference outright — which is why §7 keeps
unanimity as a named falsifier despite this ADR.

### 2.3 Where the taxonomy *does* look thin, under that instruction

The splits are not spread evenly. Of the **56 split prompts**:

- **48 of 56 (85.7%) name at least one of `code`, `tool_use`, `other`**;
- **23 of 56 (41.1%) are splits among those three alone.**

```
[sql] WITH s AS (SELECT prompt_hash FROM consensus_labels WHERE corpus_rev='r2-observer-steer'
                 GROUP BY prompt_hash HAVING COUNT(*)=3 AND SUM(task_type IS NULL)=0
                                          AND COUNT(DISTINCT task_type)>1),
           lab AS (SELECT c.prompt_hash, GROUP_CONCAT(DISTINCT c.task_type) types
                   FROM consensus_labels c JOIN s ON s.prompt_hash=c.prompt_hash
                   WHERE c.corpus_rev='r2-observer-steer' GROUP BY 1)
      SELECT COUNT(*),
             SUM(types LIKE '%code%' OR types LIKE '%tool_use%' OR types LIKE '%other%'),
             SUM(types NOT LIKE '%qa%' AND types NOT LIKE '%rag%' AND types NOT LIKE '%creative%'
                 AND types NOT LIKE '%reasoning%' AND types NOT LIKE '%summarization%'
                 AND types NOT LIKE '%extraction%' AND types NOT LIKE '%classification%'
                 AND types NOT LIKE '%translation%')
      FROM lab;                                               -> 56 | 48 | 23
```

`[dry]`'s top confusion pairs agree: `code` vs `tool_use` 12, `code` vs `other` 10, `other` vs
`tool_use` 10. **Denominator warning that block does not print:** those are *pair* counts, not a
partition of the 56 — a three-way split contributes three pairs
(`consensus_panel.ts:936`), the full list runs to 25 pairs summing to **80** over 56 prompts, and
the renderer truncates the display to the top `TOP_DISAGREEMENTS = 8`.

Per-type unanimity, **reportable cells only** (n≥10 — limits §4.3 records that this block carries no
support gate at all, so its sub-reportable cells print unmarked and must not be quoted):

| type | unanimous |
| -- | -- |
| `tool_use` | 90/114 (78.9%) |
| `other` | 42/72 (58.3%) |
| `creative` | 17/28 (60.7%) |
| `qa` | 13/25 (52.0%) |
| **`code`** | **15/38 (39.5%)** |
| **`reasoning`** | **2/11 (18.2%)** |

`rag 0/9`, `extraction 0/3`, `summarization 1/3`, `classification 0/1` and `translation 1/1` are
below the support bar and **are not findings** (limits §4.3). A further denominator note the block
does not carry: its denominators are *"complete panels where at least one panelist named this
type"*, so they sum to **305 over a corpus of 238** — a split prompt lands in the denominator of
every type named on it.

### 2.4 The verdict

**The taxonomy is not shown to be the defect.** What *is* shown, under the shipped instruction and
only under it, is a **localised boundary problem at `code` / `tool_use` / `other`**, where 85.7% of
all splits live, where `code` unanimity is 39.5% on n=38, and where the classifier's own `code`
precision is 15/20 (75.0%) against `code` recall of 15/15 (100.0%) — it over-emits the label.

Separating *"the taxonomy is ambiguous"* from *"the instruction is thin"* takes a second panel run at
a different instruction over the same corpus, needing its own cache key rather than a `corpus_rev`
bump (ADR 0005 future work, ~$3 of panel spend). It is §6's third item — priced, not done here.

---

## §3 — Is the dormant override channel the constraint? (AC 3)

### The answer

**Yes.** This is the binding constraint.

### 3.1 The channel has never run

Four columns exist to record what the client-side classifier decided. All four are **NULL on all 494
recorded decisions**:

```
[sql] SELECT COUNT(*), SUM(client_task_type IS NOT NULL), SUM(client_difficulty IS NOT NULL),
             SUM(client_confidence IS NOT NULL), SUM(classify_disagreement IS NOT NULL),
             SUM(heuristic_task_type IS NOT NULL) FROM routing_decisions;
      -> 494 | 0 | 0 | 0 | 0 | 39
```

**Denominator: every row of `routing_decisions`, however routed** — 426 server-routed, 61 pinned, 7
offline. Not a filtered subset; the whole ledger. Only `heuristic_task_type` carries data, on 39 of
494 rows, and that is the *service's* legacy second opinion, not the client's.

Why it is empty is not a bug and is not a gap in the recording — it is the shipped default:

- `packages/tui/src/minima/config.ts:287` — `classify: false`. Client-side classification is off by
  default; `MINIMA_TUI_CLASSIFY` is an opt-in flag gated behind `cfg.experimental`
  (`config.ts:404`).
- `packages/tui/src/minima/runtime.ts:456` — the call is guarded on
  `this.config.classify && this.classifier && this.agentId === null && !effectiveTaskType`. Lead
  agent only; sub-agents, the scribe and the judge never reach it.
- `packages/tui/src/minima/runtime.ts:465` — and only then does the label become an override, gated
  on `cls.confidence >= CLASSIFY_CONFIDENCE_FLOOR` (`classify.ts:23`, 0.75).

ADR [0007](adr/0007-task-type-is-the-services-decision.md) settles the reading: `task_type` is the
service's own decision **while `client_task_type` is null** — true on all 494 rows — and the
`serviceLabelOverridden` tripwire correspondingly excludes **0** candidates. That is a tripwire, not
a proof; a *caller*-supplied task type would be invisible in this schema (ADR 0007's structural gap).
What it does prove is the narrower thing this section needs: **no harness-classifier override has
ever been recorded, because that classifier has never run in real traffic.**

### 3.2 What the channel would have been worth: MUB-226's four-way outcome

Readable for the first time as of ADR [0010](adr/0010-adjudication-reads-the-shipped-classifier.md),
which joined the cached replay in and pinned it to the *shipped* model only. `[adj]`:

**Population.** 177 corpus entries offered — the entries that drove at least one server-routed
decision — of which **124 scored** and 53 set aside: 42 the panel split on, 8 with no usable replay
label, 2 spanning the regime boundary, 1 panel-incomplete, and **0 each** for
`service-label-overridden`, `no-service-label` and `no-cached-label`. 124 + 53 = 177.

**The four-way outcome. Denominator: 124 adjudicated rows (64 before the boundary, 60 after).**

| cell | aggregate | before | after |
| -- | -- | -- | -- |
| override **corrects** | 85/124 (68.5%) | 43/64 (67.2%) | 42/60 (70.0%) |
| override **harms** | 3/124 (2.4%) | 3/64 (4.7%) | 0/60 (bound ≤4.9%, §3.4) |
| override is a **no-op** | 25/124 (20.2%) | 11/64 (17.2%) | 14/60 (23.3%) |
| **both wrong** | 11/124 (8.9%) | 7/64 (10.9%) | 4/60 (6.7%) |
| **net (corrections − harms)** | **+82** | **+40** | **+42** |

Per ADR 0003 the aggregate blends two label authors and is quoted here only beside both segments.

**At the floor actually in force**, from the aggregate sweep: `0.75 → 109 overridden · 76 corrects ·
2 harms · net +74`. Aggregate derived floor **0.20**; before the boundary **0.20**; after the
boundary **NONE** — read §3.4(a) before quoting that word.

**What the result rests on.** `corroborated pairings 124/124 (100.0%)`, and the `corroborated rows
only` line reproduces the all-rows outcome in every segment. The loudest caveat on the whole
instrument — that the prompt↔decision link is a heuristic and not a join — **does not eat into these
numbers on this ledger** (limits §5.2). One row was scored on the initial route because the recovery
ladder's rungs disagreed; that is counted, not averaged away.

### 3.3 The service's label is wrong on 96 of 124 rows, and nothing corrected it

By the module's own definition (`classifier_eval_adjudicate.ts:293-296`) the service is wrong on
every `correction` and every `both-wrong` row: **85 + 11 = 96 of 124 (77.4%)**.

On those same 124 rows the harness classifier is right on `correction` + `no-op` = **110 (88.7%)**.

**85 of the 96 wrong service labels would have been corrected by a classifier that has never once
run.** Three would have been broken. That is the whole finding of this section, and it is why the
answer to AC 3 is yes: the constraint is not the quality of the signal, it is that **the channel the
signal gates is switched off.**

### 3.4 Two nuances that must not be flattened

**(a) The after segment derives NO floor, and that is the rule declining — not evidence missing.**
`[adj]` prints, for the after segment: *"derived floor: NONE — no threshold keeps corrections above
harms at every stricter one; the net first crosses positive at 0.20 and then falls back, so read the
sweep rather than quoting a floor."*

The mechanism is worth spelling out because the wording invites a pessimistic misreading. The rule is
that corrections must exceed harms at the threshold **and at every stricter one**. In the after
segment harms are **0 at every threshold**, so the rule never fails on harms. It fails at the *top*:
at 0.99 the segment admits **zero rows**, so corrections are 0, and 0 does not exceed 0. The correct
sentence is: *over 60 rows the override nets positive at every threshold that admits any rows at all
— +42 from 0.20 through 0.60, +39 through the shipped 0.75, +30 at 0.95 — and the derivation rule
declines to name a floor because the strictest candidate admits none.* The sweep is the artifact.
Limits §6.3 records this; it is not papered into a number here.

**(b) Zero harms after the boundary does NOT mean the override became safe.** 3 harms in 64 rows
before is **4.7%**, which sits **inside** the after segment's one-sided 95% upper bound of **4.9%**
on n=60 (rule of three, limits §6.2). **The two segments' harm rates are not distinguishable on this
evidence** — and even that bound borrows an independence assumption limits §3.4 says this corpus does
not have. Reading the after segment's 0 as "the override became safe" is exactly the inference the
bound forbids. Any live rollout carries the 4.9% bound with it, which is why §6's first item is
gated and measured rather than simply switched on.

---

## §4 — Recommendation on MUB-220–223 (AC 4)

*Written after §7. The falsification conditions below were fixed before this call was made.*

### **DO NOT BUILD. Close MUB-220, MUB-221, MUB-222 and MUB-223 unstarted.**

Unhedged, and the ticket is right that this is a successful outcome rather than a failure: the phase
was commissioned to find out whether that work was worth doing, and it found out.

### 4.1 The four reasons, each with the measurement behind it

**1. Label token probability refines a signal that gates a channel which is off.** `client_task_type`
is NULL on 494/494 decisions (§3.1). A better number on a dormant channel produces exactly the effect
the current number produces: none. Ship order matters — the switch is worth +74 net rows at the
shipped floor **with the signal exactly as it is today**.

**2. The total headroom available to *any* improvement in the signal is 11 net rows against 74
already banked.** This is the decisive figure and it is a hard ceiling, not an estimate. Over the 124
adjudicated rows a *perfect* gate — one that fired on all 85 corrections and none of the 3 harms —
nets **+85**. The shipped 0.75 floor with today's uninformative self-report already nets **+74**. So
every possible improvement to the gating signal — a better label self-report, a label token
probability, or a perfect oracle — is competing for **11 net rows
(14.9% of what the switch alone delivers)**. MUB-220–223 propose to spend four tickets chasing that.

**3. Every threshold from 0.20 to 0.95 already nets positive, on every segment.** Aggregate net at
`0.20 / 0.60 / 0.75 / 0.90 / 0.95` runs `+82 / +78 / +74 / +67 / +54`; before the boundary
`+40 / +36 / +35 / +33 / +24`; after `+42 / +42 / +39 / +34 / +30`. The
floor's exact placement is close to irrelevant on this corpus, and `[score]`'s independent
derivation agrees: 9 entries of 167 separate the floor in force from the derived one (§1.3). **A
signal is worth improving when the decision it gates is contested. This one is not.**

**4. The proposed quantity is not the weakest link, and `CONTEXT.md` already ranks it.** Label token
probability would be *measured from* a model rather than *asserted by* one — stronger than the label
self-report, weaker than evidence. But the failure §1.2 documents is not that the self-report is
noisy. It is that the classifier does not repeat itself: mean absolute gap +0.2014, modal pair
frequency 79.3% over 2330 draws, prompts self-reporting 0.950 whose own modal answer recurs 1 time in
10. **A token probability read off a single draw of a model that answers differently on the next draw
inherits that instability.** It measures the same unstable distribution more precisely.

### 4.2 What DO-NOT-BUILD does not claim

It does not claim the label self-report is fine. It is not (§1.2), and §6 keeps it on the list.

It does not claim token probabilities are worthless in general. It claims they are the wrong **next**
increment on **this** evidence — a refinement of the fourth-order term while the first-order term is
a boolean that is `false`.

It does not rest on the floor's placement. Limits §8 is explicit that neither readout supports a
floor change, and §4 makes no floor recommendation. The recommendation survives *any* floor between
0.20 and 0.95 because the sweep nets positive at all of them.

It does not settle the question for other traffic. Limits §3.4: one developer, one machine, 15 active
days, 238 distinct prompts, 181 of them typed once. **This recommendation describes this ledger.**
§7's preregistered re-test is what re-opens it on live traffic.

### 4.3 Disposition

Close MUB-220–223 unstarted, citing this section. **Redirect the effort to §6.** The replacement work
is not smaller than what is being closed — item 1 is worth a measured +74 net rows and item 2 helps
every client of the service rather than this harness alone.

`CONTEXT.md`'s entry for **label token probability** should stay exactly as it is — *"Proposed;
nothing emits it today"* — because that remains true and the glossary is not this ticket's to change.

---

## §5 — What this corpus does not support (AC 5)

**Imported by reference from [`docs/classifier-eval-corpus-limits.md`](classifier-eval-corpus-limits.md),
which is this arc's denominator authority.** Nothing in its §8 is re-derived here; this section maps
each limit to the conclusion above that it does or does not touch, so a reader can check a proposed
claim against the list without re-reading both documents.

| limit (§ of the corpus-limits document) | what it forbids | which conclusion above it constrains |
| -- | -- | -- |
| **Per-task-type claims** (§4.2, §8) | anything outside `tool_use`, `other`, `code`, `qa`, `creative`; after the boundary, anything outside `tool_use` | §2.3's per-type table is trimmed to reportable cells for this reason. `rag 0/9`, `translation 1/1`, `extraction 0/3`, `classification 0/1`, `summarization 1/3` are quoted **nowhere** as findings |
| **Calibration claims and any recommended floor** (§4.1, §8) | saying whether 0.75 is well placed; saying whether the classifier is over- or under-confident in 0.6–0.8. n=1 in the bin the floor sits at | §1.3 states this as its own limit. §4 makes **no** floor recommendation and its call is invariant across 0.20–0.95 |
| **The two "floors" are different quantities** (§8) | quoting `[score]`'s floor against `[adj]`'s | §1.3 (9 entries of 167, replay accuracy vs a target) and §3.2 (15 rows of 124, override net benefit) are kept in separate sections and never compared |
| **Anything about the taxonomy in the abstract** (§8, ADR 0005) | reading 76.4% unanimity as a property of the taxonomy | **§2 is entirely constrained by this** — it is why the answer is "not established" rather than "no" |
| **Anything about production's label self-report** (§8) | transplanting this reliability curve to production | the replay omits the session-context size hint production appends; the direction of the bias is *permissive*, argued from `CLASSIFY_SYSTEM`'s wording and **unfalsifiable on this ledger**. It does not bias classifier-vs-panel, since ADR 0005 has the panel omit it too |
| **Anything requiring the client classifier's recorded output** (§8) | any client-vs-service agreement rate | §3 reconstructs the counterfactual from a replay for exactly this reason. **No disagreement rate is quoted anywhere above**, because none is computable |
| **Anything about the two regimes as a treatment** (§6, ADR 0003) | attributing a before/after difference to the classifier | regime is perfectly confounded with working day, and the catch-all rate steps 45.7 points *under a byte-identical labeller*. Every segmented figure above is a **refusal to blend**, never evidence |
| **Any absence** (§6.2) | reading a zero as a demonstrated absence | §3.4(b) carries the ≤4.9% bound on the after segment's zero harms and states the two segments are indistinguishable |
| **Any generalization past one developer** (§3.4) | treating any figure as an estimate of a population rate | §4.2 states it. There is no sampling frame; no interval here means what an interval usually means |

Two further limits specific to this readout:

- **`[adj]` measures exactly one model, so a model switch invalidates every figure in §3** (ADR 0010).
  Setting `MINIMA_CLASSIFY_MODEL`, defaulting `config.classifyModel`, or reordering
  `CHEAP_FALLBACK_MODELS` makes §3 describe a classifier production no longer runs — and nothing in
  the readout would look wrong. Two tests hold the tie.
- **`[self]`'s draw depth is 4–10, not a uniform 10** (§0.5 item 5). Five of 235 sampled prompts are
  bucketed at a band wider than ±0.05. It does not move any aggregate above materially, and it is
  named rather than smoothed.

---

## §6 — Replacement accuracy work (AC 6)

Ranked, recommended rather than listed, each with the measurement that motivates it. **This ticket
changes no configuration and files no tickets; it recommends.**

### 1. Turn the override channel on for the lead agent, behind the shipped floor, and measure it live — **do this first**

**Motivation, measured.** The service's label is wrong on **96/124 (77.4%)** adjudicated rows; the
harness classifier is right on **110/124 (88.7%)** of the same rows; at the shipped 0.75 floor the
override would have netted **+74** (109 overridden, 76 corrections, 2 harms). The exact floor barely
matters — every threshold 0.20→0.95 nets positive in every segment. This is the single largest
measured opportunity in the arc and it needs **no new signal, no new model and no new ticket-sized
build** — `runtime.ts:456` already implements it behind `config.classify`.

**How, and the guard rails the evidence requires.** Lead agent only (the runtime already gates on
`agentId === null`). Behind `CLASSIFY_CONFIDENCE_FLOOR` unchanged at 0.75 — §1.3 says this corpus
cannot justify moving it, and §4 says the move is worth nine entries. Behind a kill switch, because
§3.4(b) is binding: **the after segment's zero harms carry a 95% upper bound of 4.9%, and the before
segment's measured 4.7% sits inside it.** "Never harms" is not what was measured and must not be
what is assumed.

**What it buys beyond the routing gain.** It populates `client_task_type`, `client_confidence` and
`classify_disagreement` — the columns that are NULL on 494/494 rows today — which converts every
counterfactual in §3 into a direct measurement and makes §7's preregistered re-test runnable at all.

### 2. Take the wrong service labels upstream — highest leverage per unit of work

**Motivation, measured.** 96 wrong labels on 124 rows is a defect in `src/minima/recommender/`, not
in the harness. Two more measurements point the same way: the service's like-for-like catch-all rate
steps from **110/252 (43.7%)** before the v0.14.0 boundary to **129/173 (74.6%)** after
(`[sql] SELECT CASE WHEN ts>=1784738496 THEN 'after' ELSE 'before' END, COUNT(*),
SUM(task_type='other') FROM routing_decisions WHERE routed='server' AND task_type IS NOT NULL GROUP
BY 1;` — denominator: server-routed rows **carrying a label**, which is the like-for-like population
ADR 0003 established); and on the 39 rows the server stamps with provenance, its embedding head and
its legacy heuristic **disagree on 24 (61.5%)** — the two label authors observed directly on the same
prompts.

**Why it outranks everything except item 1.** A fix here helps **every client of the service**, where
item 1 helps this harness only. Its target is concentrated and named: the aggregate by-service-label
breakdown shows `other` at n=64 with **+52/−1** and `qa` at n=31 with **+16/−2** — the service's
catch-all bucket is where the corrections are. Per limits §4.4, `code` n=18 (+13/−0) is reportable in
aggregate; the five single-digit buckets are **withheld, not zero**.

### 3. A second panel run at a different instruction — the only thing that answers §2

**Motivation.** §2 cannot be resolved by any readout in this arc. ADR 0005 fixed the panel to
`CLASSIFY_SYSTEM` verbatim, so 76.4% unanimity is unanimity *under that instruction*, and *"the
taxonomy is incoherent"* is not separable from *"the instruction is thin."* The signal that makes it
worth the money: `code` unanimity is **15/38 (39.5%)** and `reasoning` **2/11 (18.2%)** — both
reportable, both low.

**Cost and shape.** ~$3 of panel spend, and per ADR 0005 it needs **its own cache key**, not a
`corpus_rev` bump: the corpus is unchanged, so a second run's votes would collide with these on
`(prompt_hash, model_id)`. Read against this run, prompt by prompt.

**Rank it third, not first.** It resolves a question about *diagnosis*; items 1 and 2 change *routing
outcomes*. If budget allows only one, take item 1.

### 4. The `code` / `tool_use` / `other` boundary specifically — where both the panel and the classifier lose

**Motivation, measured.** **48 of 56 split prompts (85.7%) name at least one of the three; 23 of 56
(41.1%) are splits among those three alone.** The three largest confusion pairs are `code`↔`tool_use`
(12), `code`↔`other` (10), `other`↔`tool_use` (10). The classifier fails on the same seam from the
other side: `code` recall 15/15 (100.0%) against `code` precision **15/20 (75.0%)** — it over-emits
`code` — while `tool_use` recall is 75/86 (87.2%) at 75/75 (100.0%) precision.

**Rank it fourth because it is downstream of item 3.** Until a second panel run separates instruction
from taxonomy, "fix the boundary" cannot tell whether the fix is three sentences of definition in
`CLASSIFY_SYSTEM` or a merged type. Item 3 is what makes item 4 actionable; do them in that order.

### Explicitly not recommended

- **Any floor change.** Limits §8 and §1.3. Nine entries of 167 and fifteen rows of 124.
- **Switching the classifier model.** `[score]`'s head-to-head is the reason: `gpt-4o-mini` is 7.8
  points behind on the paired 167, and `only A / only B right = 18 / 5` — the two models are right on
  **different prompts**, so the switch's real cost is those 23 entries, not the point gap. And ADR
  0010: a switch invalidates every figure in §3 and is expected to fail two tests.
- **MUB-220–223.** §4.

---

## §7 — Falsifiability (AC 7)

*Written before §4, so the recommendation was made against conditions already fixed.*

Six named observations, each in units the instrument already prints, each with the command that
produced it, the threshold that would have inverted the DO-NOT-BUILD, and the measured value beside
it. Then a preregistered re-test with its thresholds stated now, so the recommendation stays
falsifiable after this ticket closes.

Five of the six are cells read straight off a readout. F3's `+85` is the one arithmetic step in the
table — `corrections − 0 harms` over the four-way outcome's own cells — and it is a **ceiling**, the
best any gate could do over these 124 rows, not a projection of what any signal would achieve.

### 7.1 What would have inverted the call

| # | observation | command | **would have inverted at** | **measured** |
| -- | -- | -- | -- | -- |
| **F1** | `net (corrections − harms)`, per segment, denominator 64 / 60 adjudicated rows | `[adj]` four-way outcome | **net ≤ 0 in *either* segment** — the override would not be worth opening, and the dormancy could not be the constraint | before **+40**, after **+42**, aggregate **+82** |
| **F2** | which label is right more often, **same 124 rows, same reference** | `[adj]` four-way outcome | **classifier-right ≤ service-right** — accuracy would be the binding constraint and §6 would be a different list | classifier **110/124 (88.7%)**, service **28/124 (22.6%)**; margin **82 rows** |
| **F3** | headroom of a *perfect* gate over what the shipped floor already banks | `[adj]` sweep, aggregate | **headroom > banked**, i.e. `85 − net@0.75 > net@0.75`, i.e. **net@0.75 < 42.5** — the signal would be a bigger lever than the switch, and §4 would read BUILD | perfect gate **+85**, shipped floor **+74**, headroom **11**, ratio **0.149** (inversion needs > 1.00) |
| **F4** | entries the floor decision controls, denominator 167 scored | `[score]` `vs the floor in force` | **derived floor *above* 0.75** (the floor is too permissive), **or ≥ 25 entries moved** (15% of 167) — the signal would gate a decision with real reach | derived **0.60**, *below* the floor in force, moving **9 entries (+7R/+2W)** |
| **F5** | panel unanimity, denominator 237 complete panels | `[dry]` panel report | **< 50%** — most prompts would have no reference label, neither accuracy nor calibration would be measurable, and the taxonomy would be the defect by elimination. Decisive **regardless** of ADR 0005, because it would destroy the reference rather than merely reframe it | **181/237 (76.4%)** |
| **F6** | the dormancy itself, denominator 494 decisions | `[sql] SELECT COUNT(*), SUM(client_task_type IS NOT NULL), SUM(client_confidence IS NOT NULL), SUM(classify_disagreement IS NOT NULL) FROM routing_decisions;` | **≥ 1 non-null** — the channel would have run, §3 would stop being a counterfactual, and the disagreement rate would be directly measurable instead of reconstructed | **494 \| 0 \| 0 \| 0** |

F3 is the load-bearing one and it is worth restating plainly: **the entire prize MUB-220–223 compete
for is 11 net rows; the prize sitting unclaimed because a boolean is `false` is 74.** No refinement
of a signal can invert that, because 11 is a ceiling over a perfect oracle, not an estimate of what a
token probability would achieve.

### 7.2 The preregistered re-test

**Trigger.** Once `MINIMA_TUI_CLASSIFY=1` has been in force long enough that

```
[sql] SELECT COUNT(*) FROM routing_decisions WHERE client_task_type IS NOT NULL;   -> >= 100
```

re-run `[adj]` and the query above. **Denominator for every threshold below: lead-agent decisions
carrying a non-null `client_task_type` — the rows the live channel actually produced, not the corpus
and not the 124 replayed rows.**

Three thresholds, stated now:

1. **Harms.** If the live harm share among *overridden* rows exceeds **4.9%**, the override is not
   safe behind the shipped floor and the channel closes again. That number is not chosen for
   convenience: it is the one-sided 95% upper bound this corpus places on the after segment's zero
   harms at n=60 (limits §6.2), and it is the bound §3.4(b) says any rollout carries. The replay
   predicts **2/109 (1.8%)** at the shipped floor.
2. **Corrections.** If the live correction share among overridden rows falls below **50%**, the
   classifier is not the better label in production, F2 has flipped in the field, and the
   DO-NOT-BUILD is void. The replay predicts **76/109 (69.7%)** at the shipped floor.
3. **The floor's reach.** Re-run `[adj]`'s self-report sweep over the live rows and read two cells it
   already prints: `net` at 0.20 and `net` at 0.75. **If the live sweep's `net@0.20 − net@0.75`
   reaches 20 rows or more**, the floor is discarding real value, the signal that feeds it is gating
   a decision with reach, F4 has flipped, and **MUB-220–223 re-open.** This is measurable because
   `client_confidence` is recorded **raw, pre-floor** (ADR 0007; `runtime.ts:454` keeps
   `clientClassification` as telemetry regardless of the floor), so the sub-floor rows the override
   never fired on are still in the ledger and still enter the sweep. Today's replay gives
   `+82 − +74 = 8` aggregate, `+40 − +35 = 5` before, `+42 − +39 = 3` after; 20 is set at roughly
   2.5× the aggregate, deliberately above the noise of one developer's traffic.

Any one of the three tripping re-opens §4. All three holding converts §3's counterfactual into a
measurement and closes the phase.

**One thing the re-test cannot do**, recorded so nobody expects it to: it will not tell you whether
0.75 is the right floor. That needs observations in the `0.75–<0.80` bin, which has **n=1** on this
corpus, and a live run at a fixed floor never generates them. Limits §4.1 stands.

---

## Answers, in one place

| the ticket's candidate | the answer | the number that decides it |
| -- | -- | -- |
| classifier **accuracy** | not the constraint | 110/124 (88.7%) right against the service's 28/124 (22.6%), same rows |
| label self-report **calibration** | broken, but not the constraint | mean abs gap +0.2014 over 229 prompts; and the floor controls 9 entries of 167 |
| the **taxonomy** | not established — and unestablishable by this instrument (ADR 0005) | unanimity 181/237 (76.4%) over complete panels |
| the **dormant override channel** | **yes — this is the binding constraint** | `client_task_type` NULL on 494/494 decisions, over 85 corrections against 3 harms left unclaimed |

**Recommendation: DO NOT BUILD MUB-220–223.** Close them unstarted. Redirect to §6, item 1 first.
