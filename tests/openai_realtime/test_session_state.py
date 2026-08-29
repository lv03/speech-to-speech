import time
from queue import Queue
from threading import Event as ThreadingEvent

from speech_to_speech.api.openai_realtime.pipeline_unit import PipelineUnit
from speech_to_speech.api.openai_realtime.session_lifecycle import SessionState, pool_view
from speech_to_speech.api.openai_realtime.service import RealtimeService
from speech_to_speech.pipeline.cancel_scope import CancelScope


def _make_unit() -> PipelineUnit:
    text_prompt_queue: Queue = Queue()
    should_listen = ThreadingEvent()
    should_listen.set()
    return PipelineUnit(
        index=0,
        service=RealtimeService(text_prompt_queue=text_prompt_queue, should_listen=should_listen),
        cancel_scope=CancelScope(),
        should_listen=should_listen,
        response_playing=ThreadingEvent(),
        input_queue=Queue(),
        output_queue=Queue(),
        text_output_queue=Queue(),
        text_prompt_queue=text_prompt_queue,
        handlers=[],
    )


def test_session_state_lifecycle_helpers_drive_pool_view():
    unit = _make_unit()
    session = SessionState()
    unit.session = session

    assert pool_view(unit, time.monotonic())["state"] == "active"
    assert session.is_released is False
    assert session.is_drained is False
    assert session.is_quarantined is False

    session.mark_released()
    draining = pool_view(unit, time.monotonic())
    assert draining["state"] == "draining"
    assert draining["draining_for_s"] >= 0
    assert session.is_released is True

    session.mark_quarantined()
    stuck = pool_view(unit, time.monotonic())
    assert stuck["state"] == "stuck"
    assert stuck["stuck_for_s"] >= 0
    assert session.is_quarantined is True

    session.mark_drained()
    assert session.is_drained is True
