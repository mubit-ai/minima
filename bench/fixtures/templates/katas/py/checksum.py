"""Kata: Luhn-style checksum over a base-36 alphabet.

The classic Luhn algorithm validates decimal card numbers. This variant
validates alphanumeric reference codes drawn from ``0-9A-Z``.
"""


def is_valid_code(code):
    """Return True when ``code`` passes the base-36 Luhn-like check.

    Normalisation: ``code`` is case-insensitive; space and hyphen
    characters are separators and are stripped before validation.

    After stripping, the code must consist of at least two characters,
    each in ``0-9`` or ``A-Z`` — otherwise raise ``ValueError`` (this
    includes codes that are empty or one character after stripping).

    Character values: ``"0"``-``"9"`` map to 0-9 and ``"A"``-``"Z"``
    map to 10-35.

    Check: walk the code from the RIGHTMOST character. Double the value
    of every second character (the 2nd, 4th, ... counting from the
    right); whenever a doubled value is 36 or more, subtract 35. Sum
    all resulting values; the code is valid iff the total is divisible
    by 36.
    """
    raise NotImplementedError("kata: implement is_valid_code")
