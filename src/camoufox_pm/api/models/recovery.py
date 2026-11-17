"""Public recovery response shapes for OpenAPI clients."""

from datetime import datetime

from pydantic import BaseModel, Field

from camoufox_pm.core.operation_diagnostics import OperationDiagnostic

from .profiles import ProfileResponse


class BackupInfo(BaseModel):
    id: str
    profile_id: str
    profile_name: str
    created_at: datetime
    reason: str
    size_bytes: int = Field(ge=0)
    uses: dict[str, str] = Field(default_factory=dict)


class BackupSkip(BaseModel):
    profile_id: str
    reason: str
    diagnostic: OperationDiagnostic | None = None


class BackupListData(BaseModel):
    backups: list[BackupInfo]
    retention: int = 2
    interval_hours: int = 24


class BackupRunData(BackupListData):
    skipped: list[BackupSkip]
    reused: list[BackupInfo] = Field(default_factory=list)


class TrashListData(BaseModel):
    profiles: list[ProfileResponse]
