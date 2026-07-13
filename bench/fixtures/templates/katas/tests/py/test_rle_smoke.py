import rle


def test_module_exposes_rle_encode():
    assert callable(rle.rle_encode)
