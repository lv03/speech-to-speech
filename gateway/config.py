"""Gateway 配置（环境变量驱动）。"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class GatewayConfig:
    host: str = "127.0.0.1"
    port: int = 3101
    #: 默认 agent 后端（POST /tasks 未指定 kind 时使用）
    default_kind: str = "pi"
    #: 任务持久化文件（None = 不持久化）
    persistence_path: Path | None = None

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "GatewayConfig":
        env = env or os.environ
        persistence = env.get("GATEWAY_PERSISTENCE") or None
        return cls(
            host=env.get("GATEWAY_HOST", "127.0.0.1"),
            port=int(env.get("GATEWAY_PORT", "3101")),
            default_kind=env.get("GATEWAY_DEFAULT_KIND", "pi"),
            persistence_path=Path(persistence) if persistence else None,
        )
