"""Deprecated: use ``minima_harness.tasks`` instead.

Kept as a thin re-export so any external references to the old scaffold keep working.
"""

from minima_harness.tasks.task_set import TASKS, Task

__all__ = ["TASKS", "Task"]
