"""speech-to-speech Agent Gateway。

一个独立的 Python 服务，通过子进程协议驱动 coding agent（pi / Codex）
执行任务，供语音引擎与桌面端调用。
"""
from __future__ import annotations

from .app import GatewayApp, create_app
from .config import GatewayConfig
from .task_queue import Task, TaskQueue

__version__ = "0.1.0"

__all__ = [
    "GatewayApp",
    "GatewayConfig",
    "Task",
    "TaskQueue",
    "create_app",
    "__version__",
]
