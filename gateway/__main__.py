"""``python -m gateway`` 启动入口。"""
from __future__ import annotations

import logging
import os

import uvicorn

from .config import GatewayConfig


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("GATEWAY_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    config = GatewayConfig.from_env()
    uvicorn.run(
        "gateway.app:create_app",
        factory=True,
        host=config.host,
        port=config.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
