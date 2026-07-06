"""Make the kata modules under py/ importable as top-level modules."""

import sys
from pathlib import Path

_KATA_DIR = Path(__file__).resolve().parents[2] / "py"
if str(_KATA_DIR) not in sys.path:
    sys.path.insert(0, str(_KATA_DIR))
