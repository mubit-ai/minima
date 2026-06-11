"""Thin Python client for the Minima API."""

from minima.schemas.common import Constraints, OutcomeLabel, TaskInput
from minima.schemas.workflow import WorkflowRequest, WorkflowStep
from minima_client import autocapture
from minima_client.client import AsyncMinimaClient, MinimaClient
from minima_client.errors import MinimaError

__all__ = [
    "AsyncMinimaClient",
    "Constraints",
    "MinimaClient",
    "MinimaError",
    "OutcomeLabel",
    "TaskInput",
    "WorkflowRequest",
    "WorkflowStep",
    "autocapture",
]
