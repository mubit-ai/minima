# Context

The project glossary: canonical names for terms this codebase would otherwise overload.

Each entry names the quantity, who produces it, and what it ranges over. Definitions here carry
no paths, code or configuration on purpose — they say what a term *means*, not where it lives, so
they stay true as the code moves. Architectural orientation lives elsewhere; this file fixes what
the words mean.

One section per overloaded term. Add a section when a term turns out to be doing more than one
job.

## "Effort"

Six distinct things have been called effort, or named with the word in them. They differ by
producer, by range, and — the part that keeps biting — by whether they describe an *intention* or
an *outcome*. Each has a canonical name below. Use it; never the bare word.

### Produced by the user

**Thinking level** — how hard the user has asked the model to think; ordinal, six values, from off
through to the highest setting the harness offers. It is the only one of these a person sets
directly, and it is expressed in the harness's own vocabulary rather than any provider's.

### Produced by the harness

**Requested effort** — the thinking level as it stands before any model or protocol has had a say.
Numerically the same thing the user set; named separately because it is what a status indicator
shows when it has not consulted anything else, and therefore what it lies with.

**Effective effort** — what will actually reach the model for this request, after the model's
declared capabilities and the protocol's constraints have applied; ordinal, or **nothing at all**.
This is the only one of the six that describes the request that was really made.

> Sending nothing is not the same as sending off. Nothing means *the model applies its own
> server-side default*, which for a reasoning model is usually some reasoning. Off means *do not
> reason*. A reader who collapses the two will report a model as not thinking when it is, and the
> indicator that does it is wrong in the opposite direction from the one it was built to fix.

### Carried on the wire

Wire **shape** is a property of the protocol, and the three in use do not agree. The differences
are not cosmetic — one of them can express something the others cannot.

**Anthropic effort** — a single field carrying the level, absent when none applies.

**OpenAI-compatible effort** — a single field carrying the level, whose range additionally
includes an explicit *none*. That extra value is the expressible difference: it says *reason not
at all*, which omitting the field cannot say.

**OpenRouter reasoning switch** — two parts rather than one: a boolean that enables or disables
reasoning, and a level alongside it. Disabling is expressible here too, by a different mechanism
again.

### The claim that is not an effort at all

**Reasoning capability** — whether a model can reason at all; a claim *about the model*, not about
a request, and registry data rather than anything computed per call.

> It has been made to do a second job: set the claim false and the harness stops sending effort,
> so the capability flag doubles as an off-switch. Two jobs, one field — *what this model is*
> versus *what to send it*. That conflation is what produced two incompatible fixes for one
> defect, and [ADR 0021](docs/adr/0021-reasoning-capability-is-registry-data.md) separates them.

### The ordering that matters

**Requested** and **effective** are the pair to keep straight, because everything user-visible
depends on which one is being shown. Requested is an intention and may be unachievable. Effective
is what happened. Anything reporting to the user — a status indicator above all — must render the
effective one, and must say so when the two diverge rather than quietly showing either alone.

### The naming rule

A new quantity does not get called "effort". It gets a name saying whose effort it is and at what
stage — asked for, decided, or sent — and an entry above in the same shape: producer, range, one
line. A capability claim never gets an effort name at all.

## "Project config"

Three configuration surfaces are described as belonging to the project or the user, and the word
"project" covers two of them. Scope is not the interesting axis: **two surfaces share a scope and
have opposite trust.**

**Project env** — the uncommitted configuration a developer keeps beside the code they are working
on. Project-scoped, and trusted precisely because the user wrote it themselves. It is deliberately
never committed.

**Committed project config** — configuration that travels with the repository, authored by
whoever wrote the repo. Project-scoped exactly like the above, and untrusted for exactly the same
reason reversed: it arrives with a clone, from someone who is not the user.

**User config** — the per-user store that lives outside any repository and applies to every
project. Global-scoped, and the user's own.

### The trust ordering

The two project-scoped surfaces sit at opposite ends of it:

- **Project env** and **user config** are both the user's own words about their own machine. They
  are trusted, and the only question between them is precedence.
- **Committed project config** is a stranger's words, obtained by cloning. It is the one surface
  where narrowness of scope must not confer authority.

This inverts the convention every general-purpose tool has trained readers to expect, where the
more specific scope simply wins; here the committed surface may only move a value toward the safer
side. That is [ADR 0020](docs/adr/0020-project-config-safer-side-clamp.md), and it exists because
the expectation it contradicts is so well established that the inconsistency reads like a bug.

### The naming rule

Never say "project config" unqualified — it names two surfaces with opposite trust. Say which, and
if the sentence is about trust rather than location, say **committed** or **the user's own**, which
are the words that actually carry the distinction.

## "Commit"

Two unlike objects are both commits in the git sense, and only one of them is a commit in the
sense a user means.

**Authored commit** — a commit on the user's own branch, made because someone asked for one. It is
theirs: it appears in their history, their diffs and their reviews, and it travels when they push.

**Checkpoint commit** — a snapshot the harness writes so that a run can be rewound. It is
parentless, parked outside the branch namespace, on no branch, and invisible to every ordinary
command the user runs against their own history. It never travels on a push.

### Why the distinction is load-bearing

The harness writes checkpoint commits constantly and without asking, and that is only acceptable
because they are unobservable in the user's history. Authoring a commit is the opposite kind of
act: it is a change to something the user owns and shows other people. A design that reasons about
"commits the harness makes" without separating the two will conclude that one of them needs no
permission — and it will be right about exactly one of them.

### The naming rule

An unqualified "commit" in this codebase means the **authored** kind, because that is what it means
to everyone outside it. The harness's own snapshots are always named as checkpoints.
