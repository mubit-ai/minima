"""Kata: Roman numerals with a zero.

Convert non-negative integers to Roman numerals using standard
subtractive notation, with one medieval twist: zero encodes as ``"N"``
(for *nulla*), a convention attested in Bede's Easter tables c. 725 AD.
"""


def to_roman(value):
    """Return the Roman-numeral spelling of ``value``.

    Contract:
      * ``value`` must be an ``int`` with ``0 <= value <= 3999``;
        anything else (floats, out-of-range ints, ...) raises
        ``ValueError``.
      * ``0`` returns ``"N"`` (nulla).
      * Every other value uses uppercase standard subtractive notation:
        4 -> ``"IV"``, 9 -> ``"IX"``, 40 -> ``"XL"``, 90 -> ``"XC"``,
        400 -> ``"CD"``, 900 -> ``"CM"``; e.g. 1994 -> ``"MCMXCIV"``.
    """
    raise NotImplementedError("kata: implement to_roman")
