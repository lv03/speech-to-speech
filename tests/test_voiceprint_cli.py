from __future__ import annotations

import json

import numpy as np
import pytest

import speech_to_speech.cli as cli_module


def test_voiceprint_enroll_records_natural_speech_profile(monkeypatch, tmp_path, capsys):
    recorded: list[float] = []

    def fake_record(duration_s: float = 4.0) -> np.ndarray:
        recorded.append(duration_s)
        return np.ones(int(duration_s * 16000), dtype=np.float32)

    class FakeVoiceprint:
        def enroll(self, takes, *, wake_word, enrollment_protocol):
            assert len(takes) == 2
            assert wake_word == "测试唤醒词"
            assert enrollment_protocol == "conversation_v1"
            return cli_module.VoiceprintProfile(
                embedding=np.ones(2, dtype=np.float32),
                wake_word=wake_word,
                takes=2,
                total_duration_s=8.0,
            )

    monkeypatch.setattr(cli_module, "_record_voiceprint_take", fake_record)
    monkeypatch.setattr(cli_module, "Voiceprint", FakeVoiceprint)
    output = tmp_path / "profile.npz"

    cli_module.run_voiceprint_command(
        ["enroll", "--takes", "2", "--take-duration", "4", "--wake-word", "测试唤醒词", "--output", str(output)]
    )

    assert recorded == [4.0, 4.0]
    assert output.is_file()
    assert "自然说话" in capsys.readouterr().out


def test_voiceprint_info_marks_legacy_profile(tmp_path, capsys):
    path = tmp_path / "legacy.npz"
    np.savez(
        path,
        embedding=np.ones(2, dtype=np.float32),
        model_name="legacy-model",
        wake_word="噜噜噜噜",
        takes=3,
        created_at=123.0,
    )

    cli_module.run_voiceprint_command(["info", "--profile", str(path)])

    out = capsys.readouterr().out
    assert "legacy_wake_word_v1" in out
    assert "否（需重新注册）" in out


def test_voiceprint_info_json_output(tmp_path, capsys):
    profile = cli_module.VoiceprintProfile(
        embedding=np.ones(2, dtype=np.float32),
        wake_word="噜噜噜噜",
        takes=5,
        total_duration_s=20.0,
    )
    path = profile.save(tmp_path / "profile.npz")

    cli_module.run_voiceprint_command(["info", "--json", "--profile", str(path)])

    data = json.loads(capsys.readouterr().out)
    assert data["enrolled"] is True
    assert data["supports_continuous_gating"] is True
    assert data["enrollment_protocol"] == "conversation_v1"
    assert data["takes"] == 5
    assert data["total_duration_s"] == pytest.approx(20.0)


def test_voiceprint_info_json_marks_legacy(tmp_path, capsys):
    path = tmp_path / "legacy.npz"
    np.savez(
        path,
        embedding=np.ones(2, dtype=np.float32),
        model_name="legacy-model",
        wake_word="噜噜噜噜",
        takes=3,
        created_at=123.0,
    )

    cli_module.run_voiceprint_command(["info", "--json", "--profile", str(path)])

    data = json.loads(capsys.readouterr().out)
    assert data["supports_continuous_gating"] is False
    assert data["enrollment_protocol"] == "legacy_wake_word_v1"
