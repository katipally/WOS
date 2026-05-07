---
title: WOS orchestrator inference
emoji: 🧭
colorFrom: gray
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
short_description: OpenAI-compatible API for wcc0/wos_orch_qwen (vLLM)
---

## What this Space does

Serves your fine-tuned **LoRA** [`wcc0/wos_orch_qwen`](https://huggingface.co/wcc0/wos_orch_qwen) on top of [`unsloth/Qwen3-32B-bnb-4bit`](https://huggingface.co/unsloth/Qwen3-32B-bnb-4bit) via **vLLM**, exposing:

- `GET /v1/models`
- `POST /v1/chat/completions` (streaming tools supported)

The WOS desktop app connects with base URL `https://wcc0-wos_demo.hf.space/v1` and selects model id **`wos-orch`** (see `start.sh` / `LORA_NAME`).

## Hardware

**Qwen3 32B (4-bit base) + LoRA needs a large GPU** (often **≥40GB VRAM** depending on vLLM build). Free-tier CPU Spaces will **not** run this. Upgrade GPU in **Space Settings → Hardware** if the build fails or the container OOMs.

## Secrets (recommended)

In **Space Settings → Secrets**:

| Name | Value |
|------|--------|
| `HF_TOKEN` | Your Hugging Face token with **read** access to the base model + adapter repos |

The container picks up `HF_TOKEN` automatically for gated/private downloads.

To override defaults without editing files, add **Variables** (optional):

| Variable | Purpose |
|----------|---------|
| `BASE_MODEL` | Default `unsloth/Qwen3-32B-bnb-4bit` |
| `LORA_REPO` | Default `wcc0/wos_orch_qwen` |
| `LORA_NAME` | OpenAI model id (default `wos-orch`) |
| `MAX_MODEL_LEN` | Default `8192` |
| `TOOL_CALL_PARSER` | vLLM tool-call parser name (default `hermes` for Qwen) |
| `USE_LORA` | Set `0` to serve a **merged** Hub repo only |
| `MERGED_MODEL` | e.g. `wcc0/wos_orch_qwen_merged` when `USE_LORA=0` |

## If the Docker build or startup fails

1. **BitsAndBytes / base model unsupported by vLLM** — merge adapters to **AWQ/GPTQ/FP16** in Colab, push a new Hub repo, then set `USE_LORA=0` and `MERGED_MODEL=...`.
2. **OOM** — smaller `MAX_MODEL_LEN`, larger GPU tier, or merged quantized checkpoint.
3. Check **Space → Logs** for the exact vLLM traceback.

## Deploy from this folder

```bash
cd huggingface/spaces/wos_demo
# Clone your Space repo if empty, then copy files:
# git clone https://huggingface.co/spaces/wcc0/wos_demo
cp Dockerfile README.md start.sh /path/to/wos_demo/
git add -A && git commit -m "vLLM OpenAI API for WOS" && git push
```

After the Space shows **Running**, open:

`https://wcc0-wos_demo.hf.space/v1/models`

You should see JSON listing `wos-orch` (or your `LORA_NAME`).
