import json
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterator, Optional
from urllib.parse import urlparse

import grpc
import requests
from google.protobuf import json_format, message_factory
from mubit.proto.mubit.v1 import control_pb2, core_pb2

OPERATIONS = json.loads(
    """{
  "auth": {
    "create_user": {
      "grpc": {
        "method": "CreateUser",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/auth/users"
      },
      "key": "auth.create_user",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Create user and issue one-time API key"
    },
    "delete_user": {
      "grpc": {
        "method": "DeleteUser",
        "service": "CoreService"
      },
      "http": {
        "method": "DELETE",
        "path": "/v2/core/auth/users/:username"
      },
      "key": "auth.delete_user",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Delete user (admin only)"
    },
    "get_user": {
      "grpc": {
        "method": "GetUser",
        "service": "CoreService"
      },
      "http": {
        "method": "GET",
        "path": "/v2/core/auth/users/:username"
      },
      "key": "auth.get_user",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Get user details (admin or self)"
    },
    "health": {
      "grpc": {
        "method": "Health",
        "service": "CoreService"
      },
      "http": {
        "method": "GET",
        "path": "/v2/core/health"
      },
      "key": "auth.health",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Runtime health check"
    },
    "list_users": {
      "grpc": {
        "method": "ListUsers",
        "service": "CoreService"
      },
      "http": {
        "method": "GET",
        "path": "/v2/core/auth/users"
      },
      "key": "auth.list_users",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "List all users (admin only)"
    },
    "revoke_user_api_key": {
      "grpc": {
        "method": "RevokeUserApiKey",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/auth/users/:username/revoke_key"
      },
      "key": "auth.revoke_user_api_key",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Revoke user's active API key"
    },
    "rotate_user_api_key": {
      "grpc": {
        "method": "RotateUserApiKey",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/auth/users/:username/rotate_key"
      },
      "key": "auth.rotate_user_api_key",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Rotate user's API key and return one-time replacement"
    }
  },
  "control": {
    "activate_prompt_version": {
      "grpc": {
        "method": "ActivatePromptVersion",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/prompt/activate"
      },
      "key": "control.activate_prompt_version",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Activate a specific prompt version for an agent"
    },
    "activate_skill_version": {
      "grpc": {
        "method": "ActivateSkillVersion",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/skills/activate"
      },
      "key": "control.activate_skill_version",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Activate a skill version"
    },
    "agent_heartbeat": {
      "grpc": {
        "method": "AgentHeartbeat",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/agents/heartbeat"
      },
      "key": "control.agent_heartbeat",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Send agent heartbeat"
    },
    "archive_block": {
      "grpc": {
        "method": "ArchiveBlock",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/archive"
      },
      "key": "control.archive_block",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Store an exact reusable archive artifact and return a stable reference ID"
    },
    "batch_insert": {
      "grpc": {
        "method": "BatchInsert",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/batch_insert"
      },
      "key": "control.batch_insert",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Synchronously batch insert semantic memory into knowledge lane"
    },
    "checkpoint": {
      "grpc": {
        "method": "Checkpoint",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/checkpoint"
      },
      "key": "control.checkpoint",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Store a durable pre-compaction checkpoint for the current run"
    },
    "circuit_break": {
      "grpc": {
        "method": "CircuitBreak",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/circuit_break"
      },
      "key": "control.circuit_break",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Atomic anti-loop reset: snapshot working memory, clear state, emit CIRCUIT_BROKEN"
    },
    "close_session": {
      "grpc": {
        "method": "CloseControlSession",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/sessions/close"
      },
      "key": "control.close_session",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Close a control session, optionally triggering final reflection"
    },
    "context": {
      "grpc": {
        "method": "GetContext",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/context"
      },
      "key": "control.context",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Get pre-assembled memory context block for LLM prompt injection"
    },
    "context_snapshot": {
      "grpc": {
        "method": "GetRunSnapshot",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/context/snapshot"
      },
      "key": "control.context_snapshot",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Fetch run context snapshot"
    },
    "create_agent_definition": {
      "grpc": {
        "method": "CreateAgentDefinition",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/projects/agents"
      },
      "key": "control.create_agent_definition",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Create an agent definition"
    },
    "create_handoff": {
      "grpc": {
        "method": "CreateHandoff",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/handoff"
      },
      "key": "control.create_handoff",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Create agent-to-agent task handoff"
    },
    "create_project": {
      "grpc": {
        "method": "CreateProject",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/projects"
      },
      "key": "control.create_project",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Create a project"
    },
    "create_session": {
      "grpc": {
        "method": "CreateControlSession",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/sessions/create"
      },
      "key": "control.create_session",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Create a server-managed control session with auto-generated IDs"
    },
    "create_skill": {
      "grpc": {
        "method": "CreateSkill",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/skills"
      },
      "key": "control.create_skill",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Create a skill"
    },
    "delete_agent_definition": {
      "grpc": {
        "method": "DeleteAgentDefinition",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/projects/agents/delete"
      },
      "key": "control.delete_agent_definition",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Delete an agent definition"
    },
    "delete_lesson": {
      "grpc": {
        "method": "DeleteLesson",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/lessons/delete"
      },
      "key": "control.delete_lesson",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Delete lesson from long-term memory"
    },
    "delete_project": {
      "grpc": {
        "method": "DeleteProject",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/projects/delete"
      },
      "key": "control.delete_project",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Delete a project"
    },
    "delete_run": {
      "grpc": {
        "method": "DeleteRun",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/delete_run"
      },
      "key": "control.delete_run",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Delete control run"
    },
    "delete_skill": {
      "grpc": {
        "method": "DeleteSkill",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/skills/delete"
      },
      "key": "control.delete_skill",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Delete a skill"
    },
    "dereference": {
      "grpc": {
        "method": "Dereference",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/dereference"
      },
      "key": "control.dereference",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Fetch exact archived content by stable reference ID"
    },
    "diagnose": {
      "grpc": {
        "method": "Diagnose",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/diagnose"
      },
      "key": "control.diagnose",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Surface failure lessons relevant to an error context"
    },
    "get_agent_definition": {
      "grpc": {
        "method": "GetAgentDefinition",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/projects/agents/get"
      },
      "key": "control.get_agent_definition",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Get agent definition"
    },
    "get_ingest_job": {
      "grpc": {
        "method": "GetIngestJob",
        "service": "ControlService"
      },
      "http": {
        "method": "GET",
        "path": "/v2/control/ingest/jobs/:job_id"
      },
      "key": "control.get_ingest_job",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Fetch ingestion job status and decision traces"
    },
    "get_project": {
      "grpc": {
        "method": "GetProject",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/projects/get"
      },
      "key": "control.get_project",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Get project details"
    },
    "get_prompt": {
      "grpc": {
        "method": "GetPrompt",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/prompt/get"
      },
      "key": "control.get_prompt",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Get the active (or specific version) system prompt for an agent"
    },
    "get_prompt_diff": {
      "grpc": {
        "method": "GetPromptDiff",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/prompt/diff"
      },
      "key": "control.get_prompt_diff",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Get a diff between two prompt versions"
    },
    "get_run_history": {
      "grpc": {
        "method": "GetRunHistory",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/projects/runs/get"
      },
      "key": "control.get_run_history",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Get run history details"
    },
    "get_run_ingest_stats": {
      "grpc": {
        "method": "GetRunIngestStats",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/ingest/stats"
      },
      "key": "control.get_run_ingest_stats",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Fetch aggregate ingestion job stats for a run"
    },
    "get_run_signal": {
      "grpc": {
        "method": "GetRunSignal",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/run-monitor/signal"
      },
      "key": "control.get_run_signal",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Return the latest Phase B Run Monitor signal for a run (re-inspects on demand)"
    },
    "get_session": {
      "grpc": {
        "method": "GetControlSession",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/sessions/get"
      },
      "key": "control.get_session",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Get details of a control session by session ID"
    },
    "get_skill": {
      "grpc": {
        "method": "GetSkill",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/skills/get"
      },
      "key": "control.get_skill",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Get skill details"
    },
    "get_skill_diff": {
      "grpc": {
        "method": "GetSkillDiff",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/skills/diff"
      },
      "key": "control.get_skill_diff",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Get skill diff"
    },
    "ingest": {
      "grpc": {
        "method": "Ingest",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/ingest"
      },
      "key": "control.ingest",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Submit async ingestion job to control ingestion agent"
    },
    "lessons": {
      "grpc": {
        "method": "ListLessons",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/lessons"
      },
      "key": "control.lessons",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "List lessons from long-term memory"
    },
    "link_run": {
      "grpc": {
        "method": "LinkRun",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/runs/link"
      },
      "key": "control.link_run",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Link run"
    },
    "list_agent_definitions": {
      "grpc": {
        "method": "ListAgentDefinitions",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/projects/agents/list"
      },
      "key": "control.list_agent_definitions",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "List agent definitions for a project"
    },
    "list_agents": {
      "grpc": {
        "method": "ListAgents",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/agents"
      },
      "key": "control.list_agents",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "List registered agents for a run"
    },
    "list_projects": {
      "grpc": {
        "method": "ListProjects",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/projects/list"
      },
      "key": "control.list_projects",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "List all projects"
    },
    "list_prompt_versions": {
      "grpc": {
        "method": "ListPromptVersions",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/prompt/versions"
      },
      "key": "control.list_prompt_versions",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "List prompt versions for an agent"
    },
    "list_run_history": {
      "grpc": {
        "method": "ListRunHistory",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/projects/runs"
      },
      "key": "control.list_run_history",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "List run history for a project"
    },
    "list_skill_versions": {
      "grpc": {
        "method": "ListSkillVersions",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/skills/versions"
      },
      "key": "control.list_skill_versions",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "List skill versions"
    },
    "list_skills": {
      "grpc": {
        "method": "ListSkills",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/skills/list"
      },
      "key": "control.list_skills",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "List skills"
    },
    "memory_health": {
      "grpc": {
        "method": "GetMemoryHealth",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/memory_health"
      },
      "key": "control.memory_health",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Inspect memory quality, staleness, and contradiction signals"
    },
    "optimize_prompt": {
      "grpc": {
        "method": "OptimizePrompt",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/prompt/optimize"
      },
      "key": "control.optimize_prompt",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Optimize an agent's system prompt using accumulated lessons and outcomes"
    },
    "optimize_skill": {
      "grpc": {
        "method": "OptimizeSkill",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/skills/optimize"
      },
      "key": "control.optimize_skill",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Optimize a skill"
    },
    "query": {
      "grpc": {
        "method": "Query",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/query"
      },
      "key": "control.query",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Execute control-plane query pipeline with optional direct bypass"
    },
    "record_outcome": {
      "grpc": {
        "method": "RecordOutcome",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/outcome"
      },
      "key": "control.record_outcome",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Record reinforcement outcome feedback for a lesson or action"
    },
    "record_step_outcome": {
      "grpc": {
        "method": "RecordStepOutcome",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/step_outcome"
      },
      "key": "control.record_step_outcome",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Record step-level process reward outcome during a run"
    },
    "reflect": {
      "grpc": {
        "method": "Reflect",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/reflect"
      },
      "key": "control.reflect",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Extract lessons from run evidence via reflection pipeline"
    },
    "register_agent": {
      "grpc": {
        "method": "RegisterAgent",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/agents/register"
      },
      "key": "control.register_agent",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Register agent"
    },
    "set_prompt": {
      "grpc": {
        "method": "SetPrompt",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/prompt/set"
      },
      "key": "control.set_prompt",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Set or update the system prompt for an agent (creates new version)"
    },
    "submit_feedback": {
      "grpc": {
        "method": "SubmitFeedback",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/feedback"
      },
      "key": "control.submit_feedback",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Submit feedback verdict for an existing handoff"
    },
    "subscribe": {
      "grpc": {
        "method": "Subscribe",
        "service": "ControlService"
      },
      "http": {
        "method": "GET",
        "path": "/v2/control/events/subscribe"
      },
      "key": "control.subscribe",
      "run_id_field": "run_id",
      "server_streaming": true,
      "summary": "Subscribe to control events"
    },
    "surface_strategies": {
      "grpc": {
        "method": "SurfaceStrategies",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/strategies"
      },
      "key": "control.surface_strategies",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Surface emergent strategies from reinforced lessons"
    },
    "unlink_run": {
      "grpc": {
        "method": "UnlinkRun",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/runs/unlink"
      },
      "key": "control.unlink_run",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Unlink run"
    },
    "update_agent_definition": {
      "grpc": {
        "method": "UpdateAgentDefinition",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/projects/agents/update"
      },
      "key": "control.update_agent_definition",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Update an agent definition"
    },
    "update_project": {
      "grpc": {
        "method": "UpdateProject",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/projects/update"
      },
      "key": "control.update_project",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Update a project"
    },
    "update_skill": {
      "grpc": {
        "method": "UpdateSkill",
        "service": "ControlService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/control/skills/update"
      },
      "key": "control.update_skill",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Update a skill"
    }
  },
  "core": {
    "add_memory": {
      "grpc": {
        "method": "AddMemory",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/memory/:session_id"
      },
      "key": "core.add_memory",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Add scratchpad memory"
    },
    "batch_insert": {
      "grpc": {
        "method": "BatchInsert",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/batch_insert"
      },
      "key": "core.batch_insert",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Batch insert nodes"
    },
    "check_permission": {
      "grpc": {
        "method": "",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/acl/check"
      },
      "key": "core.check_permission",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Check ACL permission"
    },
    "clear_memory": {
      "grpc": {
        "method": "ClearMemory",
        "service": "CoreService"
      },
      "http": {
        "method": "DELETE",
        "path": "/v2/core/memory/:session_id"
      },
      "key": "core.clear_memory",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Clear scratchpad memory"
    },
    "commit_session": {
      "grpc": {
        "method": "CommitSession",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/session/:id/commit"
      },
      "key": "core.commit_session",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Commit session"
    },
    "create_session": {
      "grpc": {
        "method": "CreateSession",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/session/create"
      },
      "key": "core.create_session",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Create control session"
    },
    "delete_node": {
      "grpc": {
        "method": "DeleteNode",
        "service": "CoreService"
      },
      "http": {
        "method": "DELETE",
        "path": "/v2/core/node/:id"
      },
      "key": "core.delete_node",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Delete one node"
    },
    "delete_run": {
      "grpc": {
        "method": "DeleteRun",
        "service": "CoreService"
      },
      "http": {
        "method": "DELETE",
        "path": "/v2/core/runs/:run_id"
      },
      "key": "core.delete_run",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Delete all data by run_id"
    },
    "drop_session": {
      "grpc": {
        "method": "DropSession",
        "service": "CoreService"
      },
      "http": {
        "method": "DELETE",
        "path": "/v2/core/session/:id/drop"
      },
      "key": "core.drop_session",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Drop session"
    },
    "get_memory": {
      "grpc": {
        "method": "GetMemory",
        "service": "CoreService"
      },
      "http": {
        "method": "GET",
        "path": "/v2/core/memory/:session_id"
      },
      "key": "core.get_memory",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Read scratchpad memory"
    },
    "grant_permission": {
      "grpc": {
        "method": "GrantPermission",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/acl/grant"
      },
      "key": "core.grant_permission",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Grant ACL permission"
    },
    "insert": {
      "grpc": {
        "method": "Insert",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/insert"
      },
      "key": "core.insert",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Insert one memory/document node"
    },
    "list_subscriptions": {
      "grpc": {
        "method": "",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/pubsub/list"
      },
      "key": "core.list_subscriptions",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "List pubsub subscriptions"
    },
    "load_session": {
      "grpc": {
        "method": "LoadSession",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/session/load"
      },
      "key": "core.load_session",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Load session"
    },
    "read_memory": {
      "grpc": {
        "method": "ReadMemory",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/sdm/read"
      },
      "key": "core.read_memory",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "SDM read"
    },
    "revoke_permission": {
      "grpc": {
        "method": "RevokePermission",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/acl/revoke"
      },
      "key": "core.revoke_permission",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Revoke ACL permission"
    },
    "search": {
      "grpc": {
        "method": "Search",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/search"
      },
      "key": "core.search",
      "run_id_field": "run_id",
      "server_streaming": false,
      "summary": "Semantic search"
    },
    "snapshot_session": {
      "grpc": {
        "method": "SnapshotSession",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/session/:id/snapshot"
      },
      "key": "core.snapshot_session",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Snapshot session"
    },
    "storage_stats": {
      "grpc": {
        "method": "",
        "service": "CoreService"
      },
      "http": {
        "method": "GET",
        "path": "/v2/core/storage/stats"
      },
      "key": "core.storage_stats",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Storage statistics"
    },
    "subscribe_events": {
      "grpc": {
        "method": "Subscribe",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/pubsub/subscribe"
      },
      "key": "core.subscribe_events",
      "run_id_field": null,
      "server_streaming": true,
      "summary": "Subscribe to pubsub events"
    },
    "trigger_compaction": {
      "grpc": {
        "method": "",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/storage/compact"
      },
      "key": "core.trigger_compaction",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Trigger storage compaction"
    },
    "unsubscribe_events": {
      "grpc": {
        "method": "",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/pubsub/unsubscribe"
      },
      "key": "core.unsubscribe_events",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "Unsubscribe from pubsub events"
    },
    "watch_memory": {
      "grpc": {
        "method": "WatchMemory",
        "service": "CoreService"
      },
      "http": {
        "method": "GET",
        "path": "/v2/core/memory/watch"
      },
      "key": "core.watch_memory",
      "run_id_field": null,
      "server_streaming": true,
      "summary": "Watch memory events for a session"
    },
    "write_memory": {
      "grpc": {
        "method": "WriteMemory",
        "service": "CoreService"
      },
      "http": {
        "method": "POST",
        "path": "/v2/core/sdm/write"
      },
      "key": "core.write_memory",
      "run_id_field": null,
      "server_streaming": false,
      "summary": "SDM write"
    }
  }
}"""
)

_SERVICE_DESCRIPTORS = {
    "CoreService": core_pb2.DESCRIPTOR.services_by_name.get("CoreService"),
    "ControlService": control_pb2.DESCRIPTOR.services_by_name.get("ControlService"),
}


class AuthError(Exception):
    pass


class ValidationError(Exception):
    pass


class AlreadyExistsError(ValidationError):
    """Raised when the server returns HTTP 409 / gRPC ALREADY_EXISTS.

    Subclasses ``ValidationError`` for backward compatibility — existing
    ``except ValidationError`` handlers still catch it. Callers who want to
    distinguish "already exists" from other validation failures (e.g. to
    fall back to a get-by-name lookup) can catch this specifically.
    """
    pass


class ServerError(Exception):
    pass


class UnsupportedFeatureError(Exception):
    pass


class TransportError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _normalize_transport(raw: Any) -> str:
    value = str(raw or "auto").strip().lower()
    if value in ("auto", "grpc", "http"):
        return value
    return "auto"


_DEFAULT_SHARED_HTTP_ENDPOINT = "https://api.mubit.ai"
_DEFAULT_SHARED_GRPC_ENDPOINT = "grpc.api.mubit.ai:443"


def _env_str(name: str) -> Optional[str]:
    value = os.getenv(name)
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


def _to_object(payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if payload is None:
        return {}
    if not isinstance(payload, dict):
        raise ValidationError("payload must be a dictionary")
    return dict(payload)


def _compact(payload: Dict[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in payload.items() if value is not None}


def _string_array(value: Any, field_name: str):
    if value is None:
        return None
    if not isinstance(value, list):
        raise ValidationError(f"{field_name} must be a list")
    return [str(item) for item in value if item is not None]


def _json_field(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value)


def _require_string(value: Any, field_name: str) -> str:
    if value is None or not str(value).strip():
        raise ValidationError(f"{field_name} is required")
    return str(value)


def _normalize_http_endpoint(endpoint: Optional[str]) -> str:
    raw = endpoint or "http://127.0.0.1:3000"
    if "://" not in raw:
        raw = f"http://{raw}"
    parsed = urlparse(raw)
    if not parsed.hostname:
        raise ValidationError(f"invalid endpoint: {endpoint}")

    port = parsed.port
    default_port = 443 if parsed.scheme == "https" else 80
    if port and port != default_port:
        return f"{parsed.scheme}://{parsed.hostname}:{port}"
    return f"{parsed.scheme}://{parsed.hostname}"


def _normalize_grpc_endpoint(endpoint: Optional[str]) -> tuple[str, bool]:
    raw = endpoint
    if not raw:
        return ("127.0.0.1:50051", False)

    if "://" in raw:
        parsed = urlparse(raw)
        if not parsed.hostname:
            raise ValidationError(f"invalid grpc endpoint: {endpoint}")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        use_tls = parsed.scheme in ("https", "grpcs")
        return (f"{parsed.hostname}:{port}", use_tls)

    if ":" in raw:
        host, port_value = raw.rsplit(":", 1)
        if not host:
            raise ValidationError(f"invalid grpc endpoint: {endpoint}")
        try:
            port = int(port_value)
        except ValueError:
            return (raw, False)
        return (f"{host}:{port}", port == 443)

    return (f"{raw}:50051", False)


def _infer_http_seed_from_grpc(endpoint: str) -> str:
    raw = endpoint.strip()
    if "://" in raw:
        parsed = urlparse(raw)
        if not parsed.hostname:
            raise ValidationError(f"invalid grpc endpoint: {endpoint}")
        host = parsed.hostname
        if host.startswith("grpc."):
            host = host[len("grpc.") :]
        scheme = "https" if parsed.scheme in ("https", "grpcs") else "http"
        port = parsed.port or (443 if scheme == "https" else 80)
        return f"{scheme}://{host}:{port}"

    host_port = raw
    host = host_port
    port: Optional[int] = None
    if ":" in host_port:
        host, port_value = host_port.rsplit(":", 1)
        try:
            port = int(port_value)
        except ValueError:
            port = None
    if host.startswith("grpc."):
        host = host[len("grpc.") :]
    scheme = "https" if port == 443 else "http"
    if port is None:
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


def _map_http_error(status: int, body: str) -> Exception:
    if status in (401, 403):
        return AuthError(body)
    if status == 409:
        return AlreadyExistsError(body)
    if status in (400, 404, 422):
        return ValidationError(body)
    if status == 501:
        return UnsupportedFeatureError(body)
    return ServerError(body)


def _map_grpc_error(error: grpc.RpcError) -> Exception:
    code = error.code()
    details = error.details() or str(error)

    if code in (grpc.StatusCode.UNAUTHENTICATED, grpc.StatusCode.PERMISSION_DENIED):
        return AuthError(details)
    if code == grpc.StatusCode.ALREADY_EXISTS:
        return AlreadyExistsError(details)
    if code in (
        grpc.StatusCode.INVALID_ARGUMENT,
        grpc.StatusCode.NOT_FOUND,
        grpc.StatusCode.FAILED_PRECONDITION,
        grpc.StatusCode.OUT_OF_RANGE,
    ):
        return ValidationError(details)
    if code == grpc.StatusCode.UNIMPLEMENTED:
        return TransportError("UNIMPLEMENTED", details)
    if code == grpc.StatusCode.UNAVAILABLE:
        return TransportError("UNAVAILABLE", details)
    if code == grpc.StatusCode.DEADLINE_EXCEEDED:
        return TransportError("DEADLINE_EXCEEDED", details)
    if code == grpc.StatusCode.CANCELLED:
        return TransportError("IO", details)
    if code in (grpc.StatusCode.UNKNOWN, grpc.StatusCode.INTERNAL):
        lower = details.lower()
        if "connection reset" in lower:
            return TransportError("CONNECTION_RESET", details)
        if "transport is closing" in lower or "failed to connect" in lower:
            return TransportError("UNAVAILABLE", details)
        return ServerError(details)
    return ServerError(details)


def _fallback_eligible(error: Exception) -> bool:
    if not isinstance(error, TransportError):
        return False
    return error.code in {
        "UNAVAILABLE",
        "DEADLINE_EXCEEDED",
        "CONNECTION_RESET",
        "IO",
        "UNIMPLEMENTED",
    }


def _service_and_method_descriptor(service: str, method: str):
    service_descriptor = _SERVICE_DESCRIPTORS.get(service)
    if service_descriptor is None:
        raise TransportError("UNAVAILABLE", f"unknown gRPC service: {service}")

    method_descriptor = service_descriptor.methods_by_name.get(method)
    if method_descriptor is None:
        raise TransportError("UNIMPLEMENTED", f"unknown gRPC method: {service}.{method}")

    return service_descriptor, method_descriptor


def _message_class(descriptor):
    return message_factory.GetMessageClass(descriptor)


def _dict_to_message(op_key: str, payload: Dict[str, Any], message_cls):
    message = message_cls()
    try:
        json_format.ParseDict(payload, message, ignore_unknown_fields=False)
    except Exception as exc:  # noqa: BLE001
        raise ValidationError(f"invalid gRPC payload for {op_key}: {exc}") from exc
    return message


def _message_to_python(message) -> Dict[str, Any]:
    return json_format.MessageToDict(message, preserving_proto_field_name=True)


@dataclass
class _State:
    api_key: Optional[str]
    run_id: Optional[str]
    transport: str


class _Transport:
    def __init__(self, config: Dict[str, Any]):
        transport = _normalize_transport(config.get("transport") or _env_str("MUBIT_TRANSPORT"))
        endpoint = config.get("endpoint") or _env_str("MUBIT_ENDPOINT")
        http_override = config.get("http_endpoint") or _env_str("MUBIT_HTTP_ENDPOINT")
        grpc_override = config.get("grpc_endpoint") or _env_str("MUBIT_GRPC_ENDPOINT")

        if endpoint:
            http_seed = endpoint
            grpc_seed = endpoint
        elif transport == "grpc":
            grpc_seed = grpc_override or _DEFAULT_SHARED_GRPC_ENDPOINT
            http_seed = http_override or _infer_http_seed_from_grpc(grpc_seed)
        else:
            http_seed = http_override or _DEFAULT_SHARED_HTTP_ENDPOINT
            grpc_seed = grpc_override or http_seed

        self.http_endpoint = _normalize_http_endpoint(http_override or http_seed)
        self.grpc_endpoint, self.grpc_use_tls = _normalize_grpc_endpoint(grpc_override or grpc_seed)
        self.timeout_sec = float(config.get("timeout_ms", 30000)) / 1000.0
        self.state = _State(
            api_key=config.get("api_key") or config.get("token") or _env_str("MUBIT_API_KEY"),
            run_id=config.get("run_id") or _env_str("MUBIT_RUN_ID"),
            transport=transport,
        )
        self._grpc_channel = None

    def set_api_key(self, api_key: Optional[str]) -> None:
        self.state.api_key = api_key

    def set_token(self, token: Optional[str]) -> None:
        self.set_api_key(token)

    def set_run_id(self, run_id: Optional[str]) -> None:
        self.state.run_id = run_id

    def set_transport(self, transport: str) -> None:
        self.state.transport = _normalize_transport(transport)

    def _grpc_channel_or_init(self):
        if self._grpc_channel is not None:
            return self._grpc_channel

        if self.grpc_use_tls:
            credentials = grpc.ssl_channel_credentials()
            channel = grpc.secure_channel(self.grpc_endpoint, credentials)
        else:
            channel = grpc.insecure_channel(self.grpc_endpoint)

        try:
            grpc.channel_ready_future(channel).result(timeout=self.timeout_sec)
        except grpc.FutureTimeoutError as exc:
            raise TransportError(
                "UNAVAILABLE", f"gRPC endpoint unavailable: {self.grpc_endpoint}"
            ) from exc

        self._grpc_channel = channel
        return self._grpc_channel

    def invoke(
        self,
        op: Dict[str, Any],
        payload: Optional[Dict[str, Any]] = None,
        *,
        transport: Optional[str] = None,
    ):
        request = _to_object(payload)
        run_id_field = op.get("run_id_field")
        if run_id_field and run_id_field not in request and self.state.run_id:
            request[run_id_field] = self.state.run_id

        mode = _normalize_transport(transport or self.state.transport)
        if mode == "http":
            return self._invoke_http(op, request)
        if mode == "grpc":
            return self._invoke_grpc(op, request)

        try:
            return self._invoke_grpc(op, request)
        except Exception as exc:  # noqa: BLE001
            if not _fallback_eligible(exc):
                raise
            return self._invoke_http(op, request)

    def _metadata(self):
        if not self.state.api_key:
            return None
        return (("authorization", f"Bearer {self.state.api_key}"),)

    def _client_stream_messages(self, op_key: str, payload: Dict[str, Any], request_cls):
        stream_items = None
        for key in ("items", "requests", "nodes"):
            if key in payload:
                stream_items = payload[key]
                break
        if stream_items is None:
            stream_items = [payload]

        if not isinstance(stream_items, list):
            raise ValidationError(
                f"{op_key} gRPC stream payload must provide list under items/requests/nodes"
            )

        if not stream_items:
            raise ValidationError(f"{op_key} gRPC stream payload cannot be empty")

        for item in stream_items:
            if not isinstance(item, dict):
                raise ValidationError(f"{op_key} gRPC stream item must be a dictionary")
            yield _dict_to_message(op_key, item, request_cls)

    def _invoke_grpc(self, op: Dict[str, Any], payload: Dict[str, Any]):
        grpc_info = op.get("grpc", {})
        grpc_method = grpc_info.get("method")
        grpc_service = grpc_info.get("service")
        if not grpc_method:
            raise TransportError("UNIMPLEMENTED", f"gRPC mapping unavailable for {op.get('key')}")

        service_descriptor, method_descriptor = _service_and_method_descriptor(
            str(grpc_service), str(grpc_method)
        )
        request_cls = _message_class(method_descriptor.input_type)
        response_cls = _message_class(method_descriptor.output_type)

        method_path = f"/{service_descriptor.full_name}/{method_descriptor.name}"
        metadata = self._metadata()
        channel = self._grpc_channel_or_init()

        try:
            if method_descriptor.client_streaming and not method_descriptor.server_streaming:
                rpc = channel.stream_unary(
                    method_path,
                    request_serializer=lambda message: message.SerializeToString(),
                    response_deserializer=response_cls.FromString,
                )
                response = rpc(
                    self._client_stream_messages(op.get("key", "grpc.op"), payload, request_cls),
                    metadata=metadata,
                    timeout=self.timeout_sec,
                )
                return _message_to_python(response)

            request_message = _dict_to_message(op.get("key", "grpc.op"), payload, request_cls)

            if method_descriptor.server_streaming and not method_descriptor.client_streaming:
                rpc = channel.unary_stream(
                    method_path,
                    request_serializer=lambda message: message.SerializeToString(),
                    response_deserializer=response_cls.FromString,
                )
                responses = rpc(request_message, metadata=metadata, timeout=self.timeout_sec)
                return (_message_to_python(message) for message in responses)

            if method_descriptor.client_streaming or method_descriptor.server_streaming:
                raise UnsupportedFeatureError(
                    f"unsupported bidi streaming for {grpc_service}.{grpc_method}"
                )

            rpc = channel.unary_unary(
                method_path,
                request_serializer=lambda message: message.SerializeToString(),
                response_deserializer=response_cls.FromString,
            )
            response = rpc(request_message, metadata=metadata, timeout=self.timeout_sec)
            return _message_to_python(response)
        except grpc.RpcError as exc:
            raise _map_grpc_error(exc) from exc

    def _invoke_http(self, op: Dict[str, Any], payload: Dict[str, Any]):
        http = op["http"]
        method = str(http["method"]).upper()
        route = str(http["path"])
        used_keys = set()

        for key, value in list(payload.items()):
            marker = f":{key}"
            if marker in route and value is not None:
                route = route.replace(marker, requests.utils.quote(str(value), safe=""))
                used_keys.add(key)

        if ":" in route:
            raise ValidationError(f"missing path parameter for {op.get('key')}")

        url = f"{self.http_endpoint.rstrip('/')}{route}"

        headers: Dict[str, str] = {}
        if self.state.api_key:
            headers["Authorization"] = f"Bearer {self.state.api_key}"

        params = None
        json_payload = None

        if method == "GET":
            query: Dict[str, Any] = {}
            for key, value in payload.items():
                if key in used_keys or value is None:
                    continue
                if isinstance(value, list):
                    if value:
                        query[key] = ",".join(str(item) for item in value)
                elif isinstance(value, (str, int, float, bool)):
                    query[key] = str(value)
            params = query or None
        else:
            # Always send a JSON body for non-GET methods so `Content-Type:
            # application/json` is set even when the payload is empty — the
            # server rejects POST requests without it.
            json_payload = payload if payload is not None else {}

        try:
            response = requests.request(
                method=method,
                url=url,
                headers=headers,
                params=params,
                json=json_payload,
                timeout=self.timeout_sec,
            )
        except requests.exceptions.Timeout as exc:
            raise TransportError("DEADLINE_EXCEEDED", str(exc)) from exc
        except requests.exceptions.ConnectionError as exc:
            raise TransportError("UNAVAILABLE", str(exc)) from exc
        except requests.exceptions.RequestException as exc:
            raise TransportError("IO", str(exc)) from exc

        if response.status_code >= 400:
            body = response.text.strip() or f"HTTP {response.status_code}"
            raise _map_http_error(response.status_code, body)

        if "/events/subscribe" in route:
            return response.iter_lines(decode_unicode=True)

        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            return response.json()

        return response.text


class _AuthDomain:
    def __init__(self, transport: _Transport):
        self._transport = transport

    def health(self):
        return self._transport.invoke(OPERATIONS["auth"]["health"], {})

    def set_api_key(self, api_key: Optional[str]):
        self._transport.set_api_key(api_key)

    def set_token(self, token: Optional[str]):
        self.set_api_key(token)

    def set_run_id(self, run_id: Optional[str]):
        self._transport.set_run_id(run_id)

    # convenience aliases
    def setApiKey(self, api_key: Optional[str]):  # noqa: N802
        self.set_api_key(api_key)

    def setToken(self, token: Optional[str]):  # noqa: N802
        self.set_token(token)

    def setRunId(self, run_id: Optional[str]):  # noqa: N802
        self.set_run_id(run_id)


class _CoreDomain:
    def __init__(self, transport: _Transport):
        self._transport = transport


class _ControlDomain:
    def __init__(self, transport: _Transport):
        self._transport = transport


class _AdvancedDomain:
    """Phase 2.2: namespace for the long tail of low-level control operations
    that aren't part of the canonical "agents get better over time" surface.
    Accessed as ``client.advanced.<method>`` so IDE autocomplete on the
    top-level ``client`` stays uncluttered. The operations remain fully
    supported — this is purely an ergonomic split.
    """

    def __init__(self, transport: _Transport):
        self._transport = transport


# Phase 2.2: names that live on top-level Client. Everything else in the
# control op set goes on client.advanced.*. Keep in sync with
# mubit_sdk::contract::HIGH_LEVEL_METHODS.
_HIGH_LEVEL_NAMES = frozenset({
    "health",
    "remember",
    "recall",
    "get_context",
    "forget",
    "reflect",
    "diagnose",
    "memory_health",
    "checkpoint",
    "archive",
    "dereference",
    "record_outcome",
    "record_step_outcome",
    "surface_strategies",
    "feedback",
    "handoff",
    "register_agent",
    "list_agents",
    "circuit_break",
    "optimize_prompt",
    "optimize_skill",
    # Common lesson-surface helpers — part of the canonical recall/remember
    # flow. Keep on top-level Client so existing examples don't emit
    # deprecation noise.
    "lessons",
    "delete_lesson",
    "delete_run",
})


def _bind_methods(domain_cls, op_map: Dict[str, Dict[str, Any]]):
    for name, op in op_map.items():
        if name in ("health",):
            continue

        def _method(self, payload: Optional[Dict[str, Any]] = None, _op=op, **kwargs):
            body = dict(payload or {})
            if kwargs:
                body.update(kwargs)
            return self._transport.invoke(_op, body)

        setattr(domain_cls, name, _method)


def _bind_client_control_methods(client_cls, op_map: Dict[str, Dict[str, Any]]):
    """Phase 2.2: only bind the high-level canonical methods directly onto
    Client. Low-level ops live on client.advanced.* via _bind_advanced_ops.
    Names that already exist as typed helpers (e.g. remember, recall) are
    preserved — the generated pass-through only fills gaps.
    """
    for name, op in op_map.items():
        if name == "health":
            continue
        if name not in _HIGH_LEVEL_NAMES:
            continue
        if hasattr(client_cls, name):
            continue

        def _method(self, payload: Optional[Dict[str, Any]] = None, _op=op, **kwargs):
            body = dict(payload or {})
            if kwargs:
                body.update(kwargs)
            return self._transport.invoke(_op, body)

        setattr(client_cls, name, _method)


def _bind_advanced_ops(client_cls, op_map: Dict[str, Dict[str, Any]]):
    """Phase 2.2: bind low-level ops onto _AdvancedDomain, and add a
    deprecation shim on Client so existing code calling
    ``client.create_project(...)`` continues to work for two minor versions.
    """
    import warnings

    for name, op in op_map.items():
        if name == "health":
            continue
        if name in _HIGH_LEVEL_NAMES:
            continue

        def _advanced_method(self, payload: Optional[Dict[str, Any]] = None, _op=op, **kwargs):
            body = dict(payload or {})
            if kwargs:
                body.update(kwargs)
            return self._transport.invoke(_op, body)

        setattr(_AdvancedDomain, name, _advanced_method)

        if hasattr(client_cls, name):
            continue

        def _shim(self, payload: Optional[Dict[str, Any]] = None, _op=op, _name=name, **kwargs):
            warnings.warn(
                f"client.{_name}() is moving to client.advanced.{_name}() — "
                "update callers before the next minor release",
                DeprecationWarning,
                stacklevel=2,
            )
            body = dict(payload or {})
            if kwargs:
                body.update(kwargs)
            return self._transport.invoke(_op, body)

        setattr(client_cls, name, _shim)


_bind_methods(_AuthDomain, OPERATIONS["auth"])
_bind_methods(_CoreDomain, OPERATIONS["core"])
_bind_methods(_ControlDomain, OPERATIONS["control"])


class Client:
    def __init__(self, endpoint: Optional[str] = None, **kwargs):
        config = dict(kwargs)
        if endpoint is not None:
            config["endpoint"] = endpoint

        self._transport = _Transport(config)
        self.auth = _AuthDomain(self._transport)
        self.core = _CoreDomain(self._transport)
        self._control = _ControlDomain(self._transport)
        # Phase 2.2: long-tail operations live here to keep top-level
        # client surface focused on the canonical learning API.
        self.advanced = _AdvancedDomain(self._transport)

    def set_token(self, token: Optional[str]):
        self.set_api_key(token)

    def set_api_key(self, api_key: Optional[str]):
        self._transport.set_api_key(api_key)

    def set_run_id(self, run_id: Optional[str]):
        self._transport.set_run_id(run_id)

    def set_transport(self, transport: str):
        self._transport.set_transport(transport)

    def _resolve_session_id(self, session_id: Optional[str], helper_name: str) -> str:
        resolved = session_id or self._transport.state.run_id
        if resolved is None or not str(resolved).strip():
            raise ValidationError(f"{helper_name} requires session_id or a client run_id")
        return str(resolved)

    def _wait_for_ingest_job(
        self,
        session_id: str,
        job_id: str,
        *,
        timeout_ms: Optional[int] = None,
        poll_interval_ms: int = 300,
    ):
        timeout_sec = float(timeout_ms or (self._transport.timeout_sec * 1000.0)) / 1000.0
        deadline = time.monotonic() + timeout_sec

        while True:
            job = self._control.get_ingest_job({"run_id": session_id, "job_id": job_id})
            if job.get("done") is True:
                return job
            if time.monotonic() >= deadline:
                raise TransportError("DEADLINE_EXCEEDED", f"Timed out waiting for ingest job {job_id}")
            time.sleep(max(float(poll_interval_ms) / 1000.0, 0.0))

    def remember(
        self,
        *,
        content: str,
        session_id: Optional[str] = None,
        agent_id: str = "sdk-client",
        item_id: Optional[str] = None,
        content_type: str = "text/plain",
        metadata: Any = None,
        hints: Any = None,
        payload: Any = None,
        intent: Optional[str] = None,
        lesson_type: Optional[str] = None,
        lesson_scope: Optional[str] = None,
        lesson_importance: Optional[str] = None,
        lesson_conditions: Optional[list[str]] = None,
        user_id: Optional[str] = None,
        upsert_key: Optional[str] = None,
        importance: Optional[str] = None,
        source: str = "agent",
        lane: Optional[str] = None,
        parallel: bool = False,
        idempotency_key: Optional[str] = None,
        wait: bool = True,
        timeout_ms: Optional[int] = None,
        poll_interval_ms: int = 300,
        env_tags: Optional[list[str]] = None,
    ):
        resolved_session_id = self._resolve_session_id(session_id, "remember")
        memory_item_id = item_id or f"remember-{int(time.time() * 1000)}"
        accepted = self._control.ingest(
            {
                "run_id": resolved_session_id,
                "agent_id": agent_id,
                "idempotency_key": idempotency_key or memory_item_id,
                "parallel": bool(parallel),
                "items": [
                    _compact(
                        {
                            "item_id": memory_item_id,
                            "content_type": content_type,
                            "text": _require_string(content, "content"),
                            "payload_json": _json_field(payload),
                            "hints_json": _json_field(hints),
                            "metadata_json": _json_field(metadata),
                            "intent": intent,
                            "lesson_type": lesson_type,
                            "lesson_scope": lesson_scope,
                            "lesson_importance": lesson_importance,
                            "lesson_conditions_json": _json_field(lesson_conditions),
                            "user_id": user_id,
                            "upsert_key": upsert_key,
                            "importance": importance,
                            "source": source,
                            "lane": lane,
                            "env_tags": env_tags or None,
                        }
                    )
                ],
            }
        )
        if not wait or not accepted.get("job_id"):
            return accepted
        return self._wait_for_ingest_job(
            resolved_session_id,
            str(accepted["job_id"]),
            timeout_ms=timeout_ms,
            poll_interval_ms=poll_interval_ms,
        )

    def recall(
        self,
        *,
        query: str,
        session_id: Optional[str] = None,
        schema: Optional[str] = None,
        mode: str = "agent_routed",
        direct_lane: str = "semantic_search",
        include_linked_runs: bool = False,
        limit: int = 5,
        embedding: Optional[list[float]] = None,
        entry_types: Optional[list[str]] = None,
        include_working_memory: bool = True,
        user_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        lane: Optional[str] = None,
        prefer_current_run: bool = False,
        env_tags: Optional[list[str]] = None,
    ):
        resolved_session_id = self._resolve_session_id(session_id, "recall")
        return self._control.query(
            _compact(
                {
                    "run_id": resolved_session_id,
                    "query": _require_string(query, "query"),
                    "schema": schema,
                    "mode": mode,
                    "direct_lane": direct_lane,
                    "include_linked_runs": include_linked_runs,
                    "limit": limit,
                    "embedding": embedding or [],
                    "entry_types": _string_array(entry_types, "entry_types"),
                    "include_working_memory": include_working_memory,
                    "user_id": user_id,
                    "agent_id": agent_id,
                    "lane_filter": lane,
                    "prefer_current_run": prefer_current_run or None,
                    "env_tags": env_tags or None,
                }
            )
        )

    def get_context(
        self,
        *,
        session_id: Optional[str] = None,
        query: str,
        user_id: Optional[str] = None,
        entry_types: Optional[list[str]] = None,
        include_working_memory: bool = True,
        format: str = "structured",
        limit: int = 5,
        max_token_budget: int = 0,
        agent_id: Optional[str] = None,
        mode: str = "full",
        sections: Optional[list[str]] = None,
    ):
        resolved_session_id = self._resolve_session_id(session_id, "get_context")
        return self._control.context(
            _compact(
                {
                    "run_id": resolved_session_id,
                    "query": _require_string(query, "query"),
                    "user_id": user_id,
                    "entry_types": _string_array(entry_types, "entry_types"),
                    "include_working_memory": include_working_memory,
                    "format": format,
                    "limit": limit,
                    "max_token_budget": max_token_budget,
                    "agent_id": agent_id,
                    "mode": mode,
                    "sections": _string_array(sections, "sections"),
                }
            )
        )

    def archive(
        self,
        *,
        content: str,
        artifact_kind: str,
        session_id: Optional[str] = None,
        metadata: Any = None,
        user_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        origin_agent_id: Optional[str] = None,
        source_attempt_id: Optional[str] = None,
        source_tool: Optional[str] = None,
        labels: Optional[list[str]] = None,
        family: Optional[str] = None,
        importance: Optional[str] = None,
    ):
        resolved_session_id = self._resolve_session_id(session_id, "archive")
        return self._control.archive_block(
            _compact(
                {
                    "run_id": resolved_session_id,
                    "content": _require_string(content, "content"),
                    "artifact_kind": _require_string(artifact_kind, "artifact_kind"),
                    "metadata_json": _json_field(metadata),
                    "user_id": user_id,
                    "agent_id": agent_id,
                    "origin_agent_id": origin_agent_id or agent_id,
                    "source_attempt_id": source_attempt_id,
                    "source_tool": source_tool,
                    "labels": _string_array(labels, "labels"),
                    "family": family,
                    "importance": importance,
                }
            )
        )

    def archive_block(self, **kwargs):
        return self.archive(**kwargs)

    def dereference(
        self,
        *,
        reference_id: str,
        session_id: Optional[str] = None,
        user_id: Optional[str] = None,
        agent_id: Optional[str] = None,
    ):
        resolved_session_id = self._resolve_session_id(session_id, "dereference")
        return self._control.dereference(
            _compact(
                {
                    "run_id": resolved_session_id,
                    "reference_id": _require_string(reference_id, "reference_id"),
                    "user_id": user_id,
                    "agent_id": agent_id,
                }
            )
        )

    def memory_health(
        self,
        *,
        session_id: Optional[str] = None,
        user_id: Optional[str] = None,
        stale_threshold_days: int = 30,
        limit: int = 500,
    ):
        resolved_session_id = self._resolve_session_id(session_id, "memory_health")
        return self._control.memory_health(
            _compact(
                {
                    "run_id": resolved_session_id,
                    "user_id": user_id,
                    "stale_threshold_days": stale_threshold_days,
                    "limit": limit,
                }
            )
        )

    def diagnose(
        self,
        *,
        error_text: str,
        session_id: Optional[str] = None,
        error_type: Optional[str] = None,
        limit: int = 10,
        user_id: Optional[str] = None,
    ):
        resolved_session_id = self._resolve_session_id(session_id, "diagnose")
        return self._control.diagnose(
            _compact(
                {
                    "run_id": resolved_session_id,
                    "error_text": _require_string(error_text, "error_text"),
                    "error_type": error_type,
                    "limit": limit,
                    "user_id": user_id,
                }
            )
        )

    def reflect(
        self,
        *,
        session_id: Optional[str] = None,
        include_linked_runs: bool = False,
        user_id: Optional[str] = None,
        last_n_items: int = 0,
    ):
        resolved_session_id = self._resolve_session_id(session_id, "reflect")
        return self._control.reflect(
            _compact(
                {
                    "run_id": resolved_session_id,
                    "include_linked_runs": include_linked_runs,
                    "user_id": user_id,
                    "last_n_items": last_n_items if last_n_items > 0 else None,
                }
            )
        )

    def forget(self, *, lesson_id: Optional[str] = None, session_id: Optional[str] = None):
        delete_lesson = lesson_id is not None and str(lesson_id).strip() != ""
        delete_session = session_id is not None and str(session_id).strip() != ""
        if not delete_lesson and not delete_session and self._transport.state.run_id:
            delete_session = True
            session_id = self._transport.state.run_id

        if (1 if delete_lesson else 0) + (1 if delete_session else 0) != 1:
            raise ValidationError("forget requires either lesson_id or session_id, but not both")

        if delete_lesson:
            return self._control.delete_lesson({"lesson_id": str(lesson_id)})
        return self._control.delete_run({"run_id": str(session_id)})

    def checkpoint(
        self,
        *,
        context_snapshot: str,
        session_id: Optional[str] = None,
        label: Optional[str] = None,
        metadata: Any = None,
        user_id: Optional[str] = None,
        agent_id: Optional[str] = None,
    ):
        resolved_session_id = self._resolve_session_id(session_id, "checkpoint")
        return self._control.checkpoint(
            _compact(
                {
                    "run_id": resolved_session_id,
                    "label": label,
                    "context_snapshot": _require_string(context_snapshot, "context_snapshot"),
                    "metadata_json": _json_field(metadata),
                    "user_id": user_id,
                    "agent_id": agent_id,
                }
            )
        )

    def register_agent(
        self,
        *,
        agent_id: str,
        session_id: Optional[str] = None,
        role: str = "",
        capabilities: Optional[list[str]] = None,
        status: str = "active",
        read_scopes: Optional[list[str]] = None,
        write_scopes: Optional[list[str]] = None,
        shared_memory_lanes: Optional[list[str]] = None,
    ):
        resolved_session_id = self._resolve_session_id(session_id, "register_agent")
        return self._control.register_agent(
            _compact(
                {
                    "run_id": resolved_session_id,
                    "agent_id": _require_string(agent_id, "agent_id"),
                    "role": role,
                    "capabilities": _string_array(capabilities, "capabilities"),
                    "status": status,
                    "read_scopes": _string_array(read_scopes, "read_scopes"),
                    "write_scopes": _string_array(write_scopes, "write_scopes"),
                    "shared_memory_lanes": _string_array(
                        shared_memory_lanes, "shared_memory_lanes"
                    ),
                }
            )
        )

    def list_agents(self, *, session_id: Optional[str] = None):
        resolved_session_id = self._resolve_session_id(session_id, "list_agents")
        return self._control.list_agents({"run_id": resolved_session_id})

    def record_outcome(
        self,
        *,
        reference_id: str,
        outcome: str,
        session_id: Optional[str] = None,
        signal: float = 0.0,
        rationale: str = "",
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        verified_in_production: bool = False,
        entry_ids: Optional[list] = None,
    ):
        resolved_session_id = self._resolve_session_id(session_id, "record_outcome")
        return self._control.record_outcome(
            _compact(
                {
                    "run_id": resolved_session_id,
                    "reference_id": _require_string(reference_id, "reference_id"),
                    "outcome": _require_string(outcome, "outcome"),
                    "signal": signal,
                    "rationale": rationale,
                    "agent_id": agent_id,
                    "user_id": user_id,
                    "verified_in_production": verified_in_production or None,
                    "entry_ids": entry_ids or None,
                }
            )
        )

    def learned(
        self,
        content: str,
        *,
        importance: str = "medium",
        session_id: Optional[str] = None,
        verified_in_production: bool = False,
        env_tags: Optional[list[str]] = None,
        agent_id: str = "sdk-client",
        user_id: Optional[str] = None,
    ):
        meta: dict = {}
        if verified_in_production:
            meta["verified_in_production"] = True
        return self.remember(
            content=content,
            intent="lesson",
            lesson_type="success",
            lesson_scope="session",
            lesson_importance=importance,
            metadata=meta if meta else None,
            env_tags=env_tags,
            agent_id=agent_id,
            user_id=user_id,
            session_id=session_id,
        )

    def surface_strategies(
        self,
        *,
        session_id: Optional[str] = None,
        lesson_types: Optional[list[str]] = None,
        max_strategies: int = 5,
        user_id: Optional[str] = None,
    ):
        resolved_session_id = self._resolve_session_id(session_id, "surface_strategies")
        return self._control.surface_strategies(
            _compact(
                {
                    "run_id": resolved_session_id,
                    "lesson_types": _string_array(lesson_types, "lesson_types"),
                    "max_strategies": max_strategies,
                    "user_id": user_id,
                }
            )
        )

    def handoff(
        self,
        *,
        task_id: str,
        from_agent_id: str,
        to_agent_id: str,
        content: str,
        session_id: Optional[str] = None,
        requested_action: str = "continue",
        metadata: Any = None,
        user_id: Optional[str] = None,
    ):
        resolved_session_id = self._resolve_session_id(session_id, "handoff")
        return self._control.create_handoff(
            _compact(
                {
                    "run_id": resolved_session_id,
                    "task_id": _require_string(task_id, "task_id"),
                    "from_agent_id": _require_string(from_agent_id, "from_agent_id"),
                    "to_agent_id": _require_string(to_agent_id, "to_agent_id"),
                    "content": _require_string(content, "content"),
                    "requested_action": requested_action,
                    "metadata_json": _json_field(metadata),
                    "user_id": user_id,
                }
            )
        )

    def feedback(
        self,
        *,
        handoff_id: str,
        verdict: str,
        session_id: Optional[str] = None,
        comments: str = "",
        from_agent_id: Optional[str] = None,
        metadata: Any = None,
        user_id: Optional[str] = None,
    ):
        resolved_session_id = self._resolve_session_id(session_id, "feedback")
        return self._control.submit_feedback(
            _compact(
                {
                    "run_id": resolved_session_id,
                    "handoff_id": _require_string(handoff_id, "handoff_id"),
                    "verdict": _require_string(verdict, "verdict"),
                    "comments": comments,
                    "from_agent_id": from_agent_id,
                    "metadata_json": _json_field(metadata),
                    "user_id": user_id,
                }
            )
        )

    # convenience aliases
    def setApiKey(self, api_key: Optional[str]):  # noqa: N802
        self.set_api_key(api_key)

    def setToken(self, token: Optional[str]):  # noqa: N802
        self.set_token(token)

    def setRunId(self, run_id: Optional[str]):  # noqa: N802
        self.set_run_id(run_id)


# Phase 2.2: split the control surface.
# - High-level canonical methods (remember/recall/outcome/...) live directly
#   on Client, with typed helpers taking precedence over auto-bound names.
# - Low-level ops (create_project, register_agent-internals, etc.) live on
#   client.advanced.*. Deprecation shims are installed on Client so existing
#   callers keep working for two minor releases with a DeprecationWarning.
_bind_client_control_methods(Client, OPERATIONS["control"])
_bind_advanced_ops(Client, OPERATIONS["control"])
