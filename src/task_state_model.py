"""Pydantic mirror of OpenSwarm canonical task state."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


TaskExecutionStatus = Literal[
    "backlog",
    "todo",
    "ready",
    "blocked",
    "in_progress",
    "in_review",
    "decomposed",
    "done",
    "failed",
    "halted",
]


class WorktreeState(BaseModel):
    branch_name: str | None = None
    worktree_path: str | None = None
    owner_agent: str | None = None
    lease_expires_at: datetime | None = None


class ExecutionState(BaseModel):
    status: TaskExecutionStatus = "backlog"
    blocked_reason: str | None = None
    retry_count: int = 0
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    last_session_id: str | None = None


class OpenSwarmTaskState(BaseModel):
    version: Literal[1] = 1
    issue_id: str
    issue_identifier: str | None = None
    title: str | None = None
    project_id: str | None = None
    project_name: str | None = None
    parent_issue_id: str | None = None
    child_issue_ids: list[str] = Field(default_factory=list)
    dependency_issue_ids: list[str] = Field(default_factory=list)
    dependency_titles: list[str] = Field(default_factory=list)
    topo_rank: int | None = None
    linear_state: str | None = None
    execution: ExecutionState = Field(default_factory=ExecutionState)
    worktree: WorktreeState = Field(default_factory=WorktreeState)
    updated_at: datetime
