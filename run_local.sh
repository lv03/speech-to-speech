#!/usr/bin/env bash
# 本地全链路启动：paraformer-zh + Qwen3:8B(vLLM 服务器) + qwen3 TTS(1.7B, 已缓存)
# 用法: ./run_local.sh
set -euo pipefail
cd "$(dirname "$0")"

# 激活虚拟环境（若已激活则无副作用）
if [ -f .venv/bin/activate ]; then
  source .venv/bin/activate
fi

speech-to-speech local \
  --stt paraformer \
  --paraformer_stt_device cpu \
  --llm_backend chat-completions \
  --model_name Qwen3:8B \
  --responses_api_base_url http://192.168.8.88:8005/v1 \
  --responses_api_api_key EMPTY \
  --tts qwen3
