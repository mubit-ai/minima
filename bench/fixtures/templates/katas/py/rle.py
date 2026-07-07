"""Kata: run-length encoding with an escape rule.

Plain run-length encoding is ambiguous the moment the input itself may
contain digits. This variant fixes that with a backslash escape.
"""


def rle_encode(text):
    """Run-length encode ``text``.

    Scan ``text`` left to right into maximal runs of the same character.
    For each run of character ``c`` with length ``n``:

      * ``n == 1``  -> emit just the character.
      * ``n >= 2``  -> emit the decimal count, then the character
        (counts may span several digits: 12 copies of ``"a"`` -> ``"12a"``).

    Escape rule: whenever the run's character is itself a decimal digit
    (``0``-``9``) or a backslash, prefix that character with one
    backslash so decoding stays unambiguous. Example:
    ``"1222"`` -> ``"\\13\\2"`` (escaped lone ``1``, then count 3 and
    escaped ``2``).

    The empty string encodes to the empty string. ``text`` must be a
    ``str``; anything else raises ``TypeError``.
    """
    raise NotImplementedError("kata: implement rle_encode")
