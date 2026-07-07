import intervals


def test_module_exposes_merge_intervals():
    assert callable(intervals.merge_intervals)
