# Hugging Face Space + WOS — quick guide

## Do you need a new Space every time?

**Usually no.**

| Situation | What to do |
|-----------|------------|
| **New LoRA / adapter** on the **same base model** (e.g. still Qwen3 32B 4-bit) | Keep the **same Space**. Update **`LORA_REPO`** in Space **Settings → Variables** to the new adapter repo, **or** overwrite `adapter_model.safetensors` in the **same** Hub repo and **Restart** the Space. |
| **New merged full model** (single safetensors repo) | Same Space: set **`USE_LORA=0`**, **`MERGED_MODEL=org/new-repo`**, Restart. |
| **Different base model family** (e.g. new backbone) or **different GPU / API stack** | Often **new Space** (or same Space with a bigger Dockerfile change + long rebuild). |

**WOS app steps** (pick model in UI) only require: Space URL saved, **`/v1/models`** lists the model id, agent uses `hfspace:...` id. That is the same whether you reused or recreated the Space.

---

## One-time (already done if you followed the repo)

1. **WOS** includes `HuggingFaceSpaceProvider` (chat + Responses fallback). Use a current app build.
2. **HF token** in WOS **Settings** if the Space or Hub weights are private/gated.

---

## Deploy or update a Space (repeatable checklist)

### A) First Space, or new Space from this repo

1. **Create Space** on Hugging Face: **Docker**, note slug `owner/space-name`.
2. Copy from this repo into the Space git repo:
   - `huggingface/spaces/wos_demo/Dockerfile`
   - `huggingface/spaces/wos_demo/start.sh`
   - `huggingface/spaces/wos_demo/README.md` (edit title/slug if you like)
3. **Commit & push** (Windows: use HTTPS; HF does not accept account passwords).

   ```powershell
   cd path\to\your\space_clone
   hf auth login
   git remote set-url origin https://huggingface.co/spaces/OWNER/SPACE_NAME.git
   git push origin main
   ```

   If push fails, use a **[User Access Token](https://huggingface.co/settings/tokens)** (write) — not your HF account password.

4. **Space → Settings → Secrets:** `HF_TOKEN` = token with **read** to base model + adapter/merged repos.
5. **Hardware:** pick a **GPU** that fits the model (32B 4-bit + LoRA still needs a **large** GPU tier on HF).
6. Wait for **Running**. Test: `https://YOUR-SPACE-SUBDOMAIN.hf.space/v1/models` (see `README` in the Space folder for URL shape).

### B) Same Space, **new model** (typical after fine-tuning)

1. Push the new **adapter** or **merged** weights to a Hub **model** repo.
2. Open **Space → Settings → Variables** and set, as needed:
   - **`LORA_REPO`** / **`LORA_NAME`** — LoRA path; or  
   - **`USE_LORA=0`** and **`MERGED_MODEL=org/repo`** — full merged model.
3. **Restart** the Space (or let it rebuild if you changed Dockerfile).
4. Confirm **`/v1/models`** lists the **model id** you will select in WOS (default LoRA name is `wos-orch` from `start.sh`).

---

## Wire into WOS (every new Space or after URL change)

1. **Settings → Hugging Face token** (if private/gated).
2. **Settings → Hugging Face Spaces:** paste `https://huggingface.co/spaces/OWNER/SPACE` → **Load Space**.
3. **Refresh models** → model picker → choose **`hfspace:...`** entry matching **`/v1/models`**.
4. Set that model on the **WOS** (or Meeting) agent.

Default API base is `https://owner-space.hf.space/v1` — only use **base URL override** if you use a reverse proxy or non-standard port.

---

## Minimal troubleshooting

| Problem | Check |
|--------|--------|
| **`config file at '/workspace/start.sh' is not valid JSON` / `model /workspace/start.sh`** | Use the repo **Dockerfile** that clears `ENTRYPOINT` (`ENTRYPOINT []`). Older one-line images passed `start.sh` as `--model` to vLLM. Rebuild after `git pull`. |
| **401 / cannot download model** | `HF_TOKEN` secret on Space; token in WOS for private Spaces. |
| **404 on `/v1/models`** | Space not awake, wrong port, or server not vLLM/OpenAI-compatible. |
| **Build OOM / crash** | GPU tier; merge/quantize; lower `MAX_MODEL_LEN` in Variables. |
| **vLLM won’t load bnb 4-bit base** | Merge to AWQ/GFPQ/full in Colab, push `MERGED_MODEL`, `USE_LORA=0`. |

---

## File map in this repo

- `huggingface/spaces/wos_demo/` — reference **Dockerfile**, **start.sh**, **README** for Spaces.  
- `electron/main/providers/huggingfaceSpaceProvider.ts` — app HTTP client (OpenAI-compatible).
