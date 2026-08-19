import asyncio
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from threading import Event as ThreadingEvent
from typing import Any

from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect

from speech_to_speech.api.audio_api import AudioApiConfig, mount_audio_api
from speech_to_speech.api.openai_realtime.llm_proxy import LLMProxyConfig, mount_llm_proxy
from speech_to_speech.api.openai_realtime.pipeline_unit import PipelineUnit
from speech_to_speech.api.openai_realtime.service import (
    PIPELINE_SAMPLE_RATE,
    build_error_event,
)
from speech_to_speech.api.openai_realtime.session_lifecycle import (
    _clean_unit,
    _dispatch_client_event,
    _release_session,
    claim_unit,
    send_loop_for,
)
from speech_to_speech.api.openai_realtime.transports import (
    WebSocketTransport,
    send_ws_event,
)
from speech_to_speech.pipeline.log_context import pipeline_log_ctx

# aiortc (the 'webrtc' extra) is optional. Import it here, at module load,
# rather than lazily in the calls endpoint: the av/cryptography C extensions
# take up to a second to load cold, which would block the shared event loop —
# and every live conversation's audio — on the first WebRTC handshake.
try:
    from aiortc import RTCPeerConnection

    from speech_to_speech.api.openai_realtime.webrtc_session import (
        WebRTCSession,
        rtc_configuration_from_env,
    )

    WEBRTC_AVAILABLE = True
except ImportError:
    WEBRTC_AVAILABLE = False

logger = logging.getLogger(__name__)


def create_app(
    pool: list[PipelineUnit],
    stop_event: ThreadingEvent,
    llm_proxy_config: LLMProxyConfig | None = None,
    audio_api_config: AudioApiConfig | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # One send loop per pipeline unit; each polls its own queues and forwards
        # to the websocket currently attached via unit.session.
        send_tasks = [asyncio.create_task(send_loop_for(unit, stop_event)) for unit in pool]
        yield
        for task in send_tasks:
            task.cancel()
        for task in send_tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        for unit in pool:
            sess = unit.session
            if sess is not None and sess.transport is not None:
                try:
                    await sess.transport.close()
                except Exception:
                    pass

    app = FastAPI(lifespan=lifespan)

    llm_proxy_usage = mount_llm_proxy(app, llm_proxy_config)
    mount_audio_api(app, audio_api_config)

    @app.websocket("/v1/realtime")
    async def realtime_endpoint(ws: WebSocket) -> None:
        offered_subprotocols = {
            protocol.strip() for protocol in ws.headers.get("sec-websocket-protocol", "").split(",")
        }
        await ws.accept(subprotocol="realtime" if "realtime" in offered_subprotocols else None)

        transport = WebSocketTransport(ws)
        unit = claim_unit(pool, transport)
        if unit is None:
            logger.warning(f"Rejected connection: all {len(pool)} pipeline slots in use")
            # Stateless error event — rejection is not chargeable to any unit's usage metrics.
            await send_ws_event(
                ws,
                build_error_event(
                    f"All {len(pool)} session slots are in use. Disconnect an existing client first.",
                    error_type="session_limit_reached",
                ),
            )
            await ws.close(code=1008, reason="All session slots are in use")
            return

        pipeline_log_ctx.set(unit.index)
        # _claim_unit guarantees unit.session is not None for the returned unit.
        assert unit.session is not None
        # Everything after the claim runs inside try so the finally below always
        # releases the unit, even if session setup fails.
        session_id = ""
        try:
            session_id = unit.service.register()
            unit.session.session_id = session_id
            logger.info(f"Client connected to pipeline {unit.index} (session {session_id})")

            # Defensive: drain edge queues and reset events so stale data from a
            # previous session that survived SESSION_END propagation doesn't leak.
            _clean_unit(unit)

            await send_ws_event(ws, unit.service.build_session_created(session_id))

            while not stop_event.is_set():
                try:
                    raw = await asyncio.wait_for(ws.receive_json(), timeout=0.1)
                except asyncio.TimeoutError:
                    continue

                await _dispatch_client_event(unit, session_id, raw, transport)

        except WebSocketDisconnect:
            logger.info(f"Client {session_id} disconnected from pipeline {unit.index}")
        except Exception as e:
            logger.error(f"Client {session_id} on pipeline {unit.index} error: {type(e).__name__}: {e}", exc_info=True)
        finally:
            # Hold the session reference: the send loop's snapshot will still resolve
            # to this object until we clear unit.session, so any handler output that
            # arrives during the drain window is sent to the now-closed ws (silently
            # dropped) instead of leaking to whichever client claims this unit next.
            # _release_session spawns the drain-and-release as a separate task so
            # this finally returns immediately. Awaiting here is unreliable: after
            # WebSocketDisconnect propagates, subsequent awaits in the same task
            # can be skipped/cancelled by Starlette's runner and never resume.
            _release_session(unit, session_id)

    @app.get("/v1/usage")
    async def usage_endpoint() -> dict[str, Any]:
        # Aggregate usage across the pool. Numeric fields sum; dict fields (e.g.
        # errors_by_type) merge with numeric leaves summed too, so per-unit error
        # counts don't get dropped by the first-unit's value.
        def _merge(into: dict[str, Any], src: dict[str, Any]) -> None:
            for k, v in src.items():
                if isinstance(v, (int, float)):
                    into[k] = into.get(k, 0) + v
                elif isinstance(v, dict):
                    sub = into.setdefault(k, {})
                    if isinstance(sub, dict):
                        _merge(sub, v)
                else:
                    into.setdefault(k, v)

        total: dict[str, Any] = {}
        for unit in pool:
            _merge(total, unit.service.get_usage())
        # Additive section: proxy traffic is app-level, not per-unit, so it
        # lands after the per-unit merge and never collides with unit keys.
        total["llm_proxy"] = llm_proxy_usage.model_dump()
        return total

    @app.get("/v1/pool")
    async def pool_endpoint() -> dict[str, Any]:
        now = time.monotonic()

        def _state(u: PipelineUnit) -> dict[str, Any]:
            s = u.session
            if s is None:
                return {"index": u.index, "state": "idle", "session_id": None}
            if s.released_at is None:
                return {"index": u.index, "state": "active", "session_id": s.session_id}
            # Drain wait gave up (quarantine timeout): the unit stays occupied
            # until SESSION_END actually drains — possibly forever if a handler
            # thread died. Surfaced distinctly so operators can act on it.
            if s.quarantined_at is not None:
                return {
                    "index": u.index,
                    "state": "stuck",
                    "session_id": s.session_id,
                    "draining_for_s": round(now - s.released_at, 2),
                    "stuck_for_s": round(now - s.quarantined_at, 2),
                }
            # released by client but SESSION_END hasn't drained yet → unit
            # is still occupied; surface elapsed time so operators can spot
            # stuck handlers.
            return {
                "index": u.index,
                "state": "draining",
                "session_id": s.session_id,
                "draining_for_s": round(now - s.released_at, 2),
            }

        return {
            "size": len(pool),
            "in_use": sum(1 for u in pool if u.session is not None),
            "units": [_state(u) for u in pool],
        }

    @app.post("/v1/realtime/calls")
    async def webrtc_calls_endpoint(request: Request) -> Response:
        """WebRTC SDP handshake (OpenAI GA Realtime 'calls' endpoint).

        The client POSTs an SDP offer with Content-Type: application/sdp and
        receives an SDP answer. Audio then flows over WebRTC media tracks;
        events flow over the 'oai-events' data channel using the same JSON
        protocol as the WebSocket transport.
        """
        if not WEBRTC_AVAILABLE:
            return Response(
                content="WebRTC support requires the 'webrtc' extra: pip install 'speech-to-speech[webrtc]'",
                status_code=501,
                media_type="text/plain",
            )

        if "application/sdp" not in request.headers.get("content-type", ""):
            return Response(
                content="Content-Type must be application/sdp",
                status_code=415,
                media_type="text/plain",
            )
        offer_sdp = (await request.body()).decode("utf-8")

        # Claim with a placeholder transport; the send loop tolerates a
        # transport-less snapshot until the session object below is attached.
        unit = claim_unit(pool, None)
        if unit is None:
            logger.warning(f"Rejected WebRTC offer: all {len(pool)} pipeline slots in use")
            return Response(
                content=build_error_event(
                    f"All {len(pool)} session slots are in use. Disconnect an existing client first.",
                    error_type="session_limit_reached",
                ).model_dump_json(),
                status_code=503,
                media_type="application/json",
            )

        pipeline_log_ctx.set(unit.index)
        try:
            session_id = unit.service.register()
            assert unit.session is not None
            unit.session.session_id = session_id
            logger.info(f"WebRTC client claiming pipeline {unit.index} (session {session_id})")

            # Defensive: drain edge queues and reset events so stale data from a
            # previous session that survived SESSION_END propagation doesn't leak.
            _clean_unit(unit)
        except Exception as e:  # noqa: BLE001
            logger.error(f"WebRTC call setup failed (pipeline {unit.index}): {type(e).__name__}: {e}")
            # No transport or drain task exists yet, so undoing the claim
            # directly is the whole release.
            unit.session = None
            return Response(content="WebRTC session setup failed", status_code=500, media_type="text/plain")

        released = False

        def _on_closed() -> None:
            # close() is idempotent but can be reached from several aiortc
            # callbacks; release the unit exactly once.
            nonlocal released
            if released:
                return
            released = True
            logger.info(f"WebRTC client {session_id} disconnected from pipeline {unit.index}")
            _release_session(unit, session_id)

        async def _on_client_event(raw: dict[str, Any]) -> None:
            assert session is not None  # callbacks only fire after setup()
            await _dispatch_client_event(unit, session_id, raw, session, transport_kind="webrtc")

        def _on_audio(pcm: bytes) -> None:
            chunks = unit.service.append_pcm(session_id, pcm, PIPELINE_SAMPLE_RATE)
            if not chunks:
                return
            rt_cfg = unit.service._state(session_id).runtime_config
            for chunk in chunks:
                unit.input_queue.put((chunk, rt_cfg))

        async def _on_open() -> None:
            assert session is not None  # callbacks only fire after setup()
            await session.send_events([unit.service.build_session_created(session_id)])
            logger.info(f"WebRTC session.created sent (session {session_id})")

        # Any failure between the claim above and a successful negotiate()
        # must release the unit, or it stays occupied forever with no peer
        # attached — the connect watchdog only exists once negotiate() ran.
        session = None
        try:
            config = rtc_configuration_from_env()
            pc = RTCPeerConnection(configuration=config) if config is not None else RTCPeerConnection()
            session = WebRTCSession(
                pc,
                on_client_event=_on_client_event,
                on_audio=_on_audio,
                on_open=_on_open,
                on_closed=_on_closed,
            )
            session.setup()
            unit.session.transport = session
        except Exception as e:  # noqa: BLE001
            logger.error(f"WebRTC session setup failed (session {session_id}): {type(e).__name__}: {e}")
            if session is not None:
                await session.close()  # fires _on_closed → _release_session
            else:
                _on_closed()
            return Response(content="WebRTC session setup failed", status_code=500, media_type="text/plain")

        try:
            answer_sdp = await session.negotiate(offer_sdp)
        except Exception as e:  # noqa: BLE001
            logger.error(f"WebRTC negotiation failed (session {session_id}): {type(e).__name__}: {e}")
            await session.close()
            return Response(content="Invalid SDP offer", status_code=400, media_type="text/plain")

        logger.info(f"WebRTC SDP answer returned (session {session_id})")
        return Response(
            content=answer_sdp,
            status_code=201,
            media_type="application/sdp",
            headers={"Location": f"/v1/realtime/calls/{session_id}"},
        )

    @app.delete("/v1/realtime/calls/{call_id}")
    async def webrtc_hangup_endpoint(call_id: str) -> Response:
        """Hang up a WebRTC call — the Location URL advertised by the POST above."""
        for unit in pool:
            session = unit.session
            if (
                session is None
                or session.session_id != call_id
                or session.released_at is not None
                or session.transport is None
                or session.transport.kind != "webrtc"
            ):
                continue
            logger.info(f"WebRTC call {call_id} hung up via DELETE (pipeline {unit.index})")
            # close() fires the session's on_closed callback, which releases
            # the unit exactly once (idempotent with aiortc's own callbacks).
            await session.transport.close()
            return Response(status_code=200)
        return Response(content="Unknown call", status_code=404, media_type="text/plain")


    return app
