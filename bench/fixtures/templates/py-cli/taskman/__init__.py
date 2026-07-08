"""taskman — a small, file-backed task/todo manager.

The package is organised as a set of narrowly-scoped modules:

    dates      date parsing and the injectable "today" used by all
               time-dependent logic (tests freeze it via env or argument)
    models     the Task dataclass, validation and (de)serialisation
    migrations schema upgrades for older on-disk file formats
    storage    JSON file persistence with atomic writes
    query      pure filtering / searching / sorting over task lists
    report     table rendering and summary statistics
    cli        argparse wiring for the ``taskman`` command

Nothing in this package performs network I/O and the only filesystem
access happens inside :mod:`taskman.storage`.
"""

__version__ = "1.4.2"

__all__ = ["__version__"]
