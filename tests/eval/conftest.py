"""Make a disarmed gate suite visible in the run summary.

The G1 classifier gates skip themselves when MINIMA_CLASSIFIER_ARTIFACT is unset, which
keeps `make eval` runnable without a trained artifact — the intended behaviour. The
problem is that a skip and a pass look the same once the run scrolls past: `make eval`
could go green for weeks while the gates that are supposed to hold the classifier to
macro-F1 >= 0.80 never executed once.

So the skip now announces itself at the end of the run, in the same spirit as the TUI
suite's ripgrep banner, and MINIMA_CLASSIFIER_GATES_REQUIRED=1 turns it into a hard
failure for CI and release checks.
"""

from __future__ import annotations

import os

# Set by the gate suite's fixture when it actually takes the skip path. Deliberately not
# derived from collection: a plain `make test` deselects the eval marker, and a banner
# about gates nobody asked to run is just noise.
_disarmed = False


def classifier_gates_required() -> bool:
    return os.environ.get("MINIMA_CLASSIFIER_GATES_REQUIRED", "") not in ("", "0")


def mark_gates_disarmed() -> None:
    global _disarmed
    _disarmed = True


def pytest_terminal_summary(terminalreporter, exitstatus, config) -> None:
    if not _disarmed:
        return
    terminalreporter.write_sep("=", "classifier gates NOT run", red=True)
    terminalreporter.write_line(
        "MINIMA_CLASSIFIER_ARTIFACT is unset, so the G1 gates (macro-F1, sink-leakage,\n"
        "misroute pins, OOS recall, false-abstain, latency, regex baseline) were SKIPPED,\n"
        "not passed. Train an artifact with scripts/classifier/train.py and point the\n"
        "variable at it before trusting a green eval run that touches the classifier.\n"
        "Set MINIMA_CLASSIFIER_GATES_REQUIRED=1 to make this a hard failure instead."
    )
