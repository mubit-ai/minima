import checksum


def test_module_exposes_is_valid_code():
    assert callable(checksum.is_valid_code)
