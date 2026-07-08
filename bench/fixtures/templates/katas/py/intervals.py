"""Kata: interval merging with a touching-interval policy knob.

Classic interval coalescing, except the caller decides whether
intervals that merely touch (share exactly one endpoint) collapse.
"""


def merge_intervals(intervals, merge_touching=True):
    """Merge a list of closed numeric intervals.

    ``intervals`` is a list of ``(start, end)`` tuples (ints or floats)
    in any order. Return a NEW list of ``(start, end)`` tuples sorted
    ascending by start, where every group of overlapping intervals has
    been collapsed into one spanning interval.

    Policy knob: when ``merge_touching`` is True (the default),
    intervals that merely touch — one ends exactly where the next
    starts, e.g. ``(1, 2)`` and ``(2, 3)`` — also merge. When False,
    touching intervals stay separate; only genuine overlaps merge.

    Raise ``ValueError`` if any interval has ``start > end``. The input
    list must not be modified. Empty input returns ``[]``.
    """
    raise NotImplementedError("kata: implement merge_intervals")
