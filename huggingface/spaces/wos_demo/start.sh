#!/usr/bin/env bash
# OpenAI-compatible API on port 7860 for HF Spaces (app_port must match).
set -euo pipefail

export HF_HOME="${HF_HOME:-/tmp/hf}"
mkdir -p "${HF_HOME}"

# Training adapters target this base (see adapter_config.json on wcc0/wos_orch_qwen).
BASE_MODEL="${BASE_MODEL:-unsloth/Qwen3-32B-bnb-4bit}"
LORA_REPO="${LORA_REPO:-wcc0/wos_orch_qwen}"
# Served OpenAI "model" id — pick this in WOS model picker after syncing the Space.
LORA_NAME="${LORA_NAME:-wos-orch}"

# Merged-only mode: set MERGED_MODEL to a Hub repo id and leave USE_LORA=0
USE_LORA="${USE_LORA:-1}"
MERGED_MODEL="${MERGED_MODEL:-}"

if [[ "${USE_LORA}" == "1" && -z "${MERGED_MODEL}" ]]; then
  exec python3 -m vllm.entrypoints.openai.api_server \
    --model "${BASE_MODEL}" \
    --host 0.0.0.0 \
    --port 7860 \
    --trust-remote-code \
    --max-model-len "${MAX_MODEL_LEN:-8192}" \
    --dtype auto \
    --enable-auto-tool-choice \
    --tool-call-parser "${TOOL_CALL_PARSER:-hermes}" \
    --enable-lora \
    --max-lora-rank 64 \
    --max-loras 4 \
    --lora-modules "${LORA_NAME}=${LORA_REPO}"
else
  MM="${MERGED_MODEL:?Set MERGED_MODEL Hub repo id or USE_LORA=1}"
  exec python3 -m vllm.entrypoints.openai.api_server \
    --model "${MM}" \
    --host 0.0.0.0 \
    --port 7860 \
    --trust-remote-code \
    --max-model-len "${MAX_MODEL_LEN:-8192}" \
    --dtype auto
fi
