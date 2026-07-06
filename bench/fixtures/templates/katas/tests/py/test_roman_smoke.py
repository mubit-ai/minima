import roman


def test_module_exposes_to_roman():
    assert callable(roman.to_roman)
