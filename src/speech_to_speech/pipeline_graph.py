"""Pipeline graph: deep module for backend construction.

Owns queue topology, stage topology (gate → VAD → STT → transcription notifier
→ LM → LMOutputProcessor → TTS), handler factories, context injection,
capability checks, and service wiring. ``instantiate`` returns a fully-wired
``PipelineUnit``; callers never touch queues or handler ordering.
"""

from copy import deepcopy
from dataclasses import fields
from pathlib import Path
from queue import Queue
from threading import Event
from typing import Any

from speech_to_speech.api.openai_realtime.pipeline_unit import PipelineUnit
from speech_to_speech.arguments_classes.module_arguments import ModuleArguments
from speech_to_speech.arguments_classes.vad_arguments import VADHandlerArguments
from speech_to_speech.backend_registry import (
    BackendSelection,
    HandlerContext,
    create_backend_handler,
)
from speech_to_speech.pipeline.cancel_scope import CancelScope
from speech_to_speech.pipeline.queue_types import (
    AudioInItem,
    AudioOutItem,
    LMOutItem,
    STTOutItem,
    TextEventItem,
    TextPromptItem,
    TTSInItem,
    VADOutItem,
)
from speech_to_speech.pipeline.speculative_turns import SpeculativeTurnTracker
from speech_to_speech.STT.transcription_notifier import TranscriptionNotifier
from speech_to_speech.VAD.vad_handler import VADHandler


class PipelineGraph:
    """Builds one isolated realtime pipeline (handler chain + queues + service)."""

    def __init__(
        self,
        *,
        module_kwargs: ModuleArguments,
        vad_handler_kwargs: VADHandlerArguments,
        stt_backend: BackendSelection,
        llm_backend: BackendSelection,
        tts_backend: BackendSelection,
    ) -> None:
        self.module_kwargs = module_kwargs
        self.vad_handler_kwargs = vad_handler_kwargs
        self.stt_backend = stt_backend
        self.llm_backend = llm_backend
        self.tts_backend = tts_backend

    def instantiate(self, index: int, stop_event: Event) -> PipelineUnit:
        """Build one pipeline unit with its own queues, service, and handlers."""
        from speech_to_speech.api.openai_realtime.service import RealtimeService
        from speech_to_speech.LLM.utils import preload_sat

        module_kwargs = self.module_kwargs
        # Per-unit copies isolate any setup-time mutation performed by
        # third-party libraries.
        vad_kw = deepcopy(self.vad_handler_kwargs)
        stt_selection = self.stt_backend.copy_for_pipeline()
        llm_selection = self.llm_backend.copy_for_pipeline()
        tts_selection = self.tts_backend.copy_for_pipeline()

        should_listen = Event()
        response_playing = Event()
        cancel_scope = CancelScope()
        speculative_turns = SpeculativeTurnTracker()
        recv_audio_chunks_queue: Queue[AudioInItem] = Queue()
        send_audio_chunks_queue: Queue[AudioOutItem] = Queue()
        spoken_prompt_queue: Queue[VADOutItem] = Queue()
        stt_output_queue: Queue[STTOutItem] = Queue()
        text_prompt_queue: Queue[TextPromptItem] = Queue()
        lm_response_queue: Queue[LMOutItem] = Queue()
        lm_processed_queue: Queue[TTSInItem] = Queue()
        text_output_queue: Queue[TextEventItem] = Queue()

        chat_size = llm_selection.config.get("chat_size", 10)
        default_instructions = llm_selection.config.get("init_chat_prompt")

        service = RealtimeService(
            text_prompt_queue=text_prompt_queue,
            should_listen=should_listen,
            chat_size=chat_size,
            speculative_turns=speculative_turns,
            default_instructions=default_instructions,
        )

        if module_kwargs.enable_live_transcription:
            vad_kw.enable_realtime_transcription = True
            vad_kw.realtime_processing_pause = module_kwargs.live_transcription_update_interval

        handlers = self._build_handlers(
            stop_event=stop_event,
            should_listen=should_listen,
            recv_audio_chunks_queue=recv_audio_chunks_queue,
            spoken_prompt_queue=spoken_prompt_queue,
            stt_output_queue=stt_output_queue,
            text_prompt_queue=text_prompt_queue,
            lm_response_queue=lm_response_queue,
            lm_processed_queue=lm_processed_queue,
            send_audio_chunks_queue=send_audio_chunks_queue,
            text_output_queue=text_output_queue,
            module_kwargs=module_kwargs,
            vad_handler_kwargs=vad_kw,
            stt_backend=stt_selection,
            llm_backend=llm_selection,
            tts_backend=tts_selection,
            speculative_turns=speculative_turns,
            cancel_scope=cancel_scope,
            pipeline_index=index,
        )
        for h in handlers:
            h.pipeline_index = index

        # Warm the multilingual sentence segmenter (SaT) during startup so the
        # first conversational turn does not pay its multi-second lazy load.
        preload_sat()

        return PipelineUnit(
            index=index,
            service=service,
            cancel_scope=cancel_scope,
            should_listen=should_listen,
            response_playing=response_playing,
            input_queue=recv_audio_chunks_queue,
            output_queue=send_audio_chunks_queue,
            text_output_queue=text_output_queue,
            text_prompt_queue=text_prompt_queue,
            handlers=handlers,
        )

    def _build_handlers(
        self,
        *,
        stop_event: Event,
        should_listen: Event,
        recv_audio_chunks_queue: Queue[AudioInItem],
        spoken_prompt_queue: Queue[VADOutItem],
        stt_output_queue: Queue[STTOutItem],
        text_prompt_queue: Queue[TextPromptItem],
        lm_response_queue: Queue[LMOutItem],
        lm_processed_queue: Queue[TTSInItem],
        send_audio_chunks_queue: Queue[AudioOutItem],
        text_output_queue: Queue[TextEventItem],
        module_kwargs: ModuleArguments,
        vad_handler_kwargs: VADHandlerArguments,
        stt_backend: BackendSelection,
        llm_backend: BackendSelection,
        tts_backend: BackendSelection,
        speculative_turns: SpeculativeTurnTracker,
        cancel_scope: CancelScope,
        pipeline_index: int,
    ) -> list[Any]:
        """Build a handler chain: VAD → STT/AudioInput → LM → TTS."""
        from speech_to_speech.LLM.lm_output_processor import LMOutputProcessor

        vad_queue_in: Queue[Any] = recv_audio_chunks_queue
        gate = None
        if module_kwargs.enable_wake_word:
            from speech_to_speech.security.gate import SecurityGateHandler

            enrollment = module_kwargs.voiceprint_enrollment
            if module_kwargs.enable_voiceprint and enrollment is None:
                enrollment = str(Path.home() / ".cache" / "speech_to_speech" / "voiceprint" / "default.npz")
            gate_queue: Queue[Any] = Queue()
            gate = SecurityGateHandler(
                stop_event,
                queue_in=recv_audio_chunks_queue,
                queue_out=gate_queue,
                setup_kwargs={
                    "wake_word": module_kwargs.wake_word,
                    "voiceprint_enrollment": enrollment if module_kwargs.enable_voiceprint else None,
                    "voiceprint_threshold": module_kwargs.voiceprint_threshold,
                    "security_timeout_s": module_kwargs.security_timeout_s,
                    "unlock_acknowledgment": module_kwargs.unlock_acknowledgment,
                },
            )
            vad_queue_in = gate_queue

        vad = VADHandler(
            stop_event,
            queue_in=vad_queue_in,
            queue_out=spoken_prompt_queue,
            setup_args=(should_listen,),
            setup_kwargs={
                **{
                    config_field.name: deepcopy(getattr(vad_handler_kwargs, config_field.name))
                    for config_field in fields(vad_handler_kwargs)
                },
                "text_output_queue": text_output_queue,
                "speculative_turns": speculative_turns,
            },
        )

        needs_notifier = not stt_backend.spec.capabilities.bypasses_transcription_notifier
        stt_queue_out: Queue[Any] = stt_output_queue if needs_notifier else text_prompt_queue
        stt_context = HandlerContext(
            stop_event=stop_event,
            queue_in=spoken_prompt_queue,
            queue_out=stt_queue_out,
            text_output_queue=text_output_queue,
            should_listen=should_listen,
            cancel_scope=cancel_scope,
            speculative_turns=speculative_turns,
            pipeline_index=pipeline_index,
            sample_rate=vad_handler_kwargs.sample_rate,
            enable_live_transcription=module_kwargs.enable_live_transcription,
            live_transcription_update_interval=module_kwargs.live_transcription_update_interval,
        )
        speech_input_handlers = [create_backend_handler(stt_backend, stt_context)]
        if needs_notifier:
            transcription_notifier = TranscriptionNotifier(
                stop_event,
                queue_in=stt_output_queue,
                queue_out=text_prompt_queue,  # type: ignore[arg-type]
                setup_kwargs={
                    "text_output_queue": text_output_queue,
                    "should_listen": should_listen,
                },
            )
            speech_input_handlers.append(transcription_notifier)

        def handler_context(queue_in: Queue[Any], queue_out: Queue[Any]) -> HandlerContext:
            return HandlerContext(
                stop_event=stop_event,
                queue_in=queue_in,
                queue_out=queue_out,
                text_output_queue=text_output_queue,
                should_listen=should_listen,
                cancel_scope=cancel_scope,
                speculative_turns=speculative_turns,
                pipeline_index=pipeline_index,
                sample_rate=vad_handler_kwargs.sample_rate,
                enable_live_transcription=module_kwargs.enable_live_transcription,
                live_transcription_update_interval=module_kwargs.live_transcription_update_interval,
            )

        lm_context = handler_context(text_prompt_queue, lm_response_queue)
        lm = create_backend_handler(
            llm_backend,
            lm_context,
        )

        lm_processor = LMOutputProcessor(
            stop_event,
            queue_in=lm_response_queue,
            queue_out=lm_processed_queue,
            setup_kwargs={
                "speculative_turns": speculative_turns,
                "text_output_queue": text_output_queue,
            },
        )

        tts_context = handler_context(lm_processed_queue, send_audio_chunks_queue)
        tts = create_backend_handler(
            tts_backend,
            tts_context,
        )

        return [*(gate and [gate] or []), vad, *speech_input_handlers, lm, lm_processor, tts]
