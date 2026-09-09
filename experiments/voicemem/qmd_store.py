"""Prototype: a QMD-backed replacement for voicemem's mem0 + Qdrant vector store.

Feasibility only — not wired into the product. It implements the subset of
`LeftBrainMemoryRepository`'s vector-store interface that the write and search
paths actually use:

    add_records_with_ids(user_id, items) -> list[str]
    search(query, *, user_id, top_k, threshold, ...) -> list[MemorySearchHit]
    list_ids(user_id=...) -> list[str]
    update_memory(memory_id, new_text, ...) -> bool
    delete_memory(memory_id) -> bool
    _path

Facts are stored as one Markdown file per memory under
``<root>/<user_id>/<memory_id>.md`` with a small frontmatter block, so the store
is human-readable and deletable by hand. Retrieval goes through the QMD daemon's
REST ``POST /query`` (same model and index the knowledge base uses).

Unimplemented methods raise NotImplementedError on purpose: the point of the
prototype is to measure the write/search path, not to claim completeness.
"""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

FRONTMATTER = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.DOTALL)


@dataclass
class MemorySearchHit:
    """Mirror of voicemem's hit shape (only the fields the prototype fills)."""

    memory_id: str
    text: str
    score: float
    attributed_to: str = "user"
    metadata: dict[str, Any] | None = None
    observed_at: str = ""
    base_score: float = 0.0
    time_boost: bool = False


def _parse(text: str) -> tuple[dict[str, str], str]:
    match = FRONTMATTER.match(text)
    if not match:
        return {}, text.strip()
    meta: dict[str, str] = {}
    for line in match.group(1).splitlines():
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip()
    return meta, match.group(2).strip()


def _render(meta: dict[str, str], body: str) -> str:
    lines = ["---"] + [f"{key}: {value}" for key, value in meta.items()] + ["---", body, ""]
    return "\n".join(lines)


class QmdMemoryStore:
    """Minimal QMD-backed memory store."""

    def __init__(
        self,
        *,
        root: str | Path,
        collection: str,
        query_base_url: str,
        qmd_command: Sequence[str],
        index_env: dict[str, str] | None = None,
        mode: str = "hybrid",
        timeout_s: float = 180.0,
    ) -> None:
        self.root = Path(root).expanduser()
        self.collection = collection
        self.query_base_url = query_base_url.rstrip("/")
        self.qmd_command = list(qmd_command)
        self.index_env = dict(index_env or {})
        self.mode = mode
        self.timeout_s = float(timeout_s)
        self.root.mkdir(parents=True, exist_ok=True)
        self._client: Any = None

    # ── interface used by the repository ─────────────────────────────────────

    @property
    def _path(self) -> Path:  # noqa: N802 - voicemem reads this attribute
        return self.root

    def add_records_with_ids(
        self,
        user_id: str,
        items: Sequence[tuple[str, str, str, dict[str, Any]]],
    ) -> list[str]:
        ids: list[str] = []
        for memory_id, text, attributed_to, metadata in items:
            body = (text or "").strip()
            if not body:
                continue
            meta = {
                "id": memory_id,
                "user_id": user_id,
                "attributed_to": attributed_to or "user",
                "observed_at": str((metadata or {}).get("time_start") or (metadata or {}).get("observed_at") or ""),
                "archived": "false",
            }
            path = self._file(user_id, memory_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(_render(meta, body), encoding="utf-8")
            ids.append(memory_id)
        if ids:
            self.reindex()
        return ids

    def search(
        self,
        query: str,
        *,
        user_id: str,
        top_k: int = 10,
        threshold: float | None = None,
        memory_id_filter: Iterable[str] | None = None,
        rescue_k: int = 0,
        include_assistant: bool = False,
    ) -> list[MemorySearchHit]:
        cleaned = (query or "").strip()
        if not cleaned:
            return []
        searches = (
            [{"type": "lex", "query": cleaned}, {"type": "vec", "query": cleaned}]
            if self.mode == "hybrid"
            else [{"type": "vec", "query": cleaned}]
        )
        payload = {
            "searches": searches,
            "collections": [self.collection],
            "limit": max(top_k * 3, 10),
            "rerank": self.mode == "hybrid",
        }
        response = self._http().post(f"{self.query_base_url}/query", json=payload)
        response.raise_for_status()
        allowed = set(memory_id_filter) if memory_id_filter else None

        hits: list[MemorySearchHit] = []
        for row in response.json().get("results", []):
            memory_id = Path(str(row.get("file", ""))).stem
            meta, body = self._read(memory_id)
            if not body:
                continue
            if meta.get("user_id") != user_id:
                continue
            if meta.get("archived") == "true":
                continue
            if meta.get("attributed_to") == "assistant" and not include_assistant:
                continue
            if allowed is not None and memory_id not in allowed:
                continue
            score = float(row.get("score") or 0.0)
            if threshold is not None and score < threshold:
                continue
            hits.append(
                MemorySearchHit(
                    memory_id=memory_id,
                    text=body,
                    score=score,
                    attributed_to=meta.get("attributed_to", "user"),
                    metadata={k: v for k, v in meta.items() if k not in {"id", "user_id"}},
                    observed_at=meta.get("observed_at", ""),
                )
            )
        return hits[:top_k]

    def list_ids(self, *, user_id: str) -> list[str]:
        directory = self.root / user_id
        if not directory.is_dir():
            return []
        return sorted(path.stem for path in directory.glob("*.md"))

    def update_memory(
        self,
        memory_id: str,
        new_text: str,
        session_id: int | str | None = None,
        observed_at: str | None = None,
    ) -> bool:
        body = (new_text or "").strip()
        if not body:
            return False
        for path in self.root.glob(f"*/{memory_id}.md"):
            meta, _ = _parse(path.read_text(encoding="utf-8"))
            if session_id is not None:
                meta["session_id"] = str(session_id)
            if observed_at:
                meta["observed_at"] = str(observed_at)
            path.write_text(_render(meta, body), encoding="utf-8")
            self.reindex()
            return True
        return False

    def delete_memory(self, memory_id: str) -> bool:
        removed = False
        for path in self.root.glob(f"*/{memory_id}.md"):
            path.unlink()
            removed = True
        if removed:
            self.reindex()
        return removed

    # ── not implemented in the prototype ─────────────────────────────────────

    def list_entries(self, *, user_id: str) -> list[dict[str, str]]:
        raise NotImplementedError

    def existing_for_extractor(self, user_id: str, *, limit: int = 50) -> list[dict[str, str]]:
        raise NotImplementedError

    def memory_ids_with_time_expr(self, user_id: str, *, kind: str) -> set[str]:
        raise NotImplementedError

    def archive_memory(self, memory_id: str) -> bool:
        raise NotImplementedError

    def unarchive_memory(self, memory_id: str) -> bool:
        raise NotImplementedError

    # ── storage / indexing helpers ───────────────────────────────────────────

    def reindex(self) -> None:
        """Bring the QMD index in line with the files on disk."""
        for command in (["update"], ["embed", "-c", self.collection]):
            result = subprocess.run(
                [*self.qmd_command, *command],
                capture_output=True,
                text=True,
                env={**os.environ, **self.index_env},
                check=False,
            )
            if result.returncode != 0:
                raise RuntimeError(
                    f"qmd {' '.join(command)} failed: {(result.stderr or result.stdout).strip()[:200]}"
                )

    def _file(self, user_id: str, memory_id: str) -> Path:
        return self.root / user_id / f"{memory_id}.md"

    def _read(self, memory_id: str) -> tuple[dict[str, str], str]:
        for path in self.root.glob(f"*/{memory_id}.md"):
            return _parse(path.read_text(encoding="utf-8"))
        return {}, ""

    def _http(self):
        if self._client is None:
            import httpx

            self._client = httpx.Client(timeout=self.timeout_s)
        return self._client

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None


__all__ = ["MemorySearchHit", "QmdMemoryStore"]
