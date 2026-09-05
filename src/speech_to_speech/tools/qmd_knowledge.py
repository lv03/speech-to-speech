"""Restricted local knowledge tools backed by the Electron QMD proxy."""
from __future__ import annotations

import asyncio
import json
import math
import os
import re
from typing import Any, cast
from urllib.parse import urlsplit

import httpx

__all__ = ["TOOLS", "CREATE_RESPONSE", "search_knowledge", "get_document", "execute_tool"]

CREATE_RESPONSE = True

MAX_QUERY_LENGTH = 2_000
MAX_TOP_K = 8
MAX_DOCUMENT_LINES = 80
MAX_OUTPUT_CHARS = 16_000
MAX_TITLE_CHARS = 240
MAX_SOURCE_CHARS = 600
MAX_SNIPPET_CHARS = 2_400
MAX_CONTENT_CHARS = 15_000
REQUEST_TIMEOUT_SECONDS = 10.0

_COLLECTION_ID = re.compile(r"col_[a-f0-9]{32}\Z")
_HANDLE = re.compile(r"doc_[a-f0-9]{64}\Z")
_DRIVE_PATH = re.compile(r"[A-Za-z]:[\\/]")
_ABSOLUTE_PATH = re.compile(
    r"(?<![\w:/\\])(?:[A-Za-z]:[\\/](?:[^\\/\s]+[\\/])*[^\\/\s]+|\\\\[^\\/\s]+[\\/](?:[^\\/\s]+[\\/])*[^\\/\s]+|/(?:[^/\s]+/)*[^/\s]+)"
)
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_ERROR_CODES = frozenset(
    {
        "no_collection",
        "knowledge_not_ready",
        "knowledge_indexing",
        "no_results",
        "document_not_allowed",
        "proxy_unavailable",
        "invalid_request",
    }
)
_ERROR_MESSAGES = {
    "no_collection": "No knowledge collection is configured",
    "knowledge_not_ready": "Knowledge base is not ready",
    "knowledge_indexing": "Knowledge base is indexing",
    "no_results": "No knowledge results found",
    "document_not_allowed": "Document handle is not allowed",
    "proxy_unavailable": "Knowledge service is unavailable",
    "invalid_request": "Invalid knowledge request",
}


TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "search_knowledge",
        "description": "Search the user's local Markdown knowledge base for relevant reference material.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The user's knowledge question or search terms.",
                    "maxLength": MAX_QUERY_LENGTH,
                },
                "collection_id": {
                    "type": "string",
                    "description": "Optional opaque knowledge collection id.",
                    "pattern": r"^col_[a-f0-9]{32}$",
                },
                "top_k": {
                    "type": "integer",
                    "description": "Number of relevant results to return.",
                    "minimum": 1,
                    "maximum": MAX_TOP_K,
                    "default": 5,
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "type": "function",
        "name": "get_document",
        "description": "Read a bounded line range from a document returned by search_knowledge.",
        "parameters": {
            "type": "object",
            "properties": {
                "handle": {
                    "type": "string",
                    "description": "Opaque document handle returned by search_knowledge.",
                    "pattern": r"^doc_[a-f0-9]{64}$",
                },
                "start_line": {
                    "type": "integer",
                    "description": "First 1-based line to return.",
                    "minimum": 1,
                    "default": 1,
                },
                "end_line": {
                    "type": "integer",
                    "description": "Last 1-based line to return; at most 80 lines may be requested.",
                    "minimum": 1,
                    "default": MAX_DOCUMENT_LINES,
                },
            },
            "required": ["handle"],
            "additionalProperties": False,
        },
    },
]


def _dump(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _error(code: str) -> str:
    if code not in _ERROR_CODES:
        code = "proxy_unavailable"
    return _dump({"status": "error", "code": code, "message": _ERROR_MESSAGES[code]})


def _no_results() -> str:
    return _dump({"status": "no_results", "results": []})


def _valid_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value) and not _CONTROL.search(value)


def _valid_collection_id(value: Any) -> bool:
    return value is None or isinstance(value, str) and _COLLECTION_ID.fullmatch(value) is not None


def _valid_handle(value: Any) -> bool:
    return isinstance(value, str) and _HANDLE.fullmatch(value) is not None


def _valid_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _safe_source(value: Any) -> str | None:
    if not isinstance(value, str) or not value or len(value) > MAX_SOURCE_CHARS:
        return None
    if (
        value.startswith(("/", "\\", "~"))
        or _DRIVE_PATH.match(value)
        or "://" in value
        or "\\" in value
        or _CONTROL.search(value)
    ):
        return None
    parts = value.split("/")
    if any(not part or part in {".", ".."} for part in parts):
        return None
    return value


def _strip_absolute_paths(value: str) -> str:
    return _ABSOLUTE_PATH.sub("[path omitted]", value)


def _safe_title(value: Any) -> str:
    if not isinstance(value, str) or not value or _CONTROL.search(value):
        return "Untitled document"
    if value.startswith(("/", "\\", "~")) or _DRIVE_PATH.match(value):
        return "Untitled document"
    return _strip_absolute_paths(value)[:MAX_TITLE_CHARS]


def _proxy_url(path: str) -> str | None:
    raw_base = os.environ.get("QMD_PROXY_URL", "")
    if _CONTROL.search(raw_base):
        return None
    base = raw_base.strip()
    token = os.environ.get("QMD_PROXY_TOKEN", "")
    if not base or base != raw_base or not token or token != token.strip() or _CONTROL.search(token):
        return None
    try:
        parsed = urlsplit(base)
    except ValueError:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "::1"}
        or port is None
        or not 1 <= port <= 65535
        or parsed.path != ""
        or parsed.query
        or parsed.fragment
        or parsed.username is not None
        or parsed.password is not None
    ):
        return None
    return f"{base.rstrip('/')}{path}"


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {os.environ.get('QMD_PROXY_TOKEN', '')}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _body_error_code(status_code: Any, payload: Any) -> str:
    if status_code in {401, 404}:
        return "proxy_unavailable"
    if isinstance(payload, dict):
        code = payload.get("code")
        if isinstance(code, str) and code in _ERROR_CODES:
            return code
    if isinstance(status_code, int) and 400 <= status_code < 500:
        return "invalid_request"
    return "proxy_unavailable"


async def _post(path: str, body: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    url = _proxy_url(path)
    if url is None:
        return None, "proxy_unavailable"
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS, trust_env=False) as client:
            response = await client.request("POST", url, headers=_headers(), json=body)
            status_code = getattr(response, "status_code", None)
            payload = response.json()
    except asyncio.CancelledError:
        return None, "proxy_unavailable"
    except (httpx.HTTPError, TimeoutError, ValueError, TypeError):
        return None, "proxy_unavailable"
    except Exception:
        return None, "proxy_unavailable"

    if not isinstance(payload, dict):
        return None, "proxy_unavailable"
    if not isinstance(status_code, int) or not 200 <= status_code < 300:
        return None, _body_error_code(status_code, payload)
    if payload.get("status") == "error":
        code = payload.get("code")
        return None, code if isinstance(code, str) and code in _ERROR_CODES else "proxy_unavailable"
    return payload, None


def _validate_search(query: Any, collection_id: Any, top_k: Any) -> tuple[str, str | None, int] | None:
    if not _valid_text(query):
        return None
    normalized_query = query.strip()
    if not normalized_query or len(normalized_query) > MAX_QUERY_LENGTH:
        return None
    if not _valid_collection_id(collection_id):
        return None
    if not _valid_integer(top_k) or not 1 <= top_k <= MAX_TOP_K:
        return None
    return normalized_query, collection_id, top_k


def _validate_document(handle: Any, start_line: Any, end_line: Any) -> tuple[str, int, int] | None:
    if not _valid_handle(handle) or not _valid_integer(start_line):
        return None
    if end_line is None:
        end_line = start_line + MAX_DOCUMENT_LINES - 1
    if not _valid_integer(end_line):
        return None
    if start_line < 1 or end_line < start_line or end_line - start_line + 1 > MAX_DOCUMENT_LINES:
        return None
    return handle, start_line, end_line


def _bounded_search(results: list[dict[str, Any]]) -> str:
    bounded = results[:MAX_TOP_K]
    payload: dict[str, Any] = {"status": "ok", "results": bounded}
    while len(_dump(payload)) > MAX_OUTPUT_CHARS and bounded:
        largest = max(bounded, key=lambda item: len(item["snippet"]))
        snippet = largest["snippet"]
        if snippet:
            excess = len(_dump(payload)) - MAX_OUTPUT_CHARS
            largest["snippet"] = snippet[: max(0, len(snippet) - max(1, excess))]
        else:
            bounded.pop()
    if len(_dump(payload)) > MAX_OUTPUT_CHARS:
        return _no_results()
    return _dump(payload)


def _bounded_document(payload: dict[str, Any]) -> str:
    content = payload["content"][:MAX_CONTENT_CHARS]
    bounded = {**payload, "content": content}
    if len(_dump(bounded)) <= MAX_OUTPUT_CHARS:
        return _dump(bounded)
    low, high = 0, len(content)
    while low < high:
        middle = (low + high + 1) // 2
        candidate = {**payload, "content": content[:middle]}
        if len(_dump(candidate)) <= MAX_OUTPUT_CHARS:
            low = middle
        else:
            high = middle - 1
    bounded["content"] = content[:low]
    return _dump(bounded)


async def search_knowledge(
    query: str,
    collection_id: str | None = None,
    top_k: int = 5,
) -> str:
    """Search the app-owned knowledge proxy and return bounded JSON."""
    validated = _validate_search(query, collection_id, top_k)
    if validated is None:
        return _error("invalid_request")
    normalized_query, normalized_collection_id, normalized_top_k = validated
    body: dict[str, Any] = {"query": normalized_query, "top_k": normalized_top_k}
    if normalized_collection_id is not None:
        body["collection_id"] = normalized_collection_id
    payload, error_code = await _post("/v1/search", body)
    if error_code is not None:
        return _error(error_code)
    if payload is None:
        return _error("proxy_unavailable")
    if payload.get("status") == "no_results":
        if payload.get("results") != []:
            return _error("proxy_unavailable")
        return _no_results()
    raw_results = payload.get("results")
    if payload.get("status") != "ok" or not isinstance(raw_results, list):
        return _error("proxy_unavailable")

    results: list[dict[str, Any]] = []
    for raw in raw_results:
        if not isinstance(raw, dict):
            continue
        handle = raw.get("handle")
        source = _safe_source(raw.get("source"))
        if not _valid_handle(handle) or source is None:
            continue
        raw_snippet = raw.get("snippet")
        snippet = raw_snippet if isinstance(raw_snippet, str) else ""
        score = raw.get("score")
        if not isinstance(score, (int, float)) or isinstance(score, bool) or not math.isfinite(score):
            score = 0.0
        results.append(
            {
                "handle": handle,
                "title": _safe_title(raw.get("title")),
                "source": source,
                "score": score,
                "snippet": _strip_absolute_paths(snippet)[:MAX_SNIPPET_CHARS],
            }
        )
    if not results:
        return _no_results()
    return _bounded_search(results)


async def get_document(
    handle: str,
    start_line: int = 1,
    end_line: int | None = None,
) -> str:
    """Read a bounded document range through an opaque proxy handle."""
    validated = _validate_document(handle, start_line, end_line)
    if validated is None:
        return _error("invalid_request")
    normalized_handle, normalized_start, normalized_end = validated
    payload, error_code = await _post(
        "/v1/document",
        {"handle": normalized_handle, "start_line": normalized_start, "end_line": normalized_end},
    )
    if error_code is not None:
        return _error(error_code)
    if payload is None:
        return _error("proxy_unavailable")
    if payload.get("status") != "ok":
        return _error("proxy_unavailable")
    if payload.get("handle") != normalized_handle:
        return _error("document_not_allowed")
    source = _safe_source(payload.get("source"))
    content = payload.get("content")
    if source is None:
        return _error("document_not_allowed")
    if not isinstance(content, str):
        return _error("proxy_unavailable")
    return _bounded_document(
        {
            "status": "ok",
            "handle": normalized_handle,
            "title": _safe_title(payload.get("title")),
            "source": source,
            "content": _strip_absolute_paths(content),
        }
    )


async def execute_tool(name: str, arguments: dict[str, Any]) -> str:
    """Dispatch only the two explicitly declared knowledge tools."""
    if not isinstance(name, str) or not isinstance(arguments, dict):
        return _error("invalid_request")
    if name == "search_knowledge":
        if set(arguments) - {"query", "collection_id", "top_k"}:
            return _error("invalid_request")
        return await search_knowledge(
            cast(str, arguments.get("query")),
            cast(str | None, arguments.get("collection_id")),
            cast(int, arguments.get("top_k", 5)),
        )
    if name == "get_document":
        if set(arguments) - {"handle", "start_line", "end_line"}:
            return _error("invalid_request")
        return await get_document(
            cast(str, arguments.get("handle")),
            cast(int, arguments.get("start_line", 1)),
            cast(int | None, arguments.get("end_line")),
        )
    return _error("invalid_request")
