"""Run with `python -m kora_quant`."""

from __future__ import annotations

import uvicorn

from .config import load_settings


def main() -> None:
    settings = load_settings()
    uvicorn.run("kora_quant.app:app", host="127.0.0.1", port=settings.port, log_level="info")


if __name__ == "__main__":  # pragma: no cover
    main()
