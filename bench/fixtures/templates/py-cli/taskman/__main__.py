"""Allow running the CLI as ``python3 -m taskman``."""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
