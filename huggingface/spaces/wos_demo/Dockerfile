# Hugging Face Space: OpenAI-compatible API for WOS (chat + optional Responses via vLLM).
# Pin image tag if builds become unstable; check https://hub.docker.com/r/vllm/vllm-openai/tags
FROM vllm/vllm-openai:latest

ENV PYTHONUNBUFFERED=1

WORKDIR /workspace

COPY start.sh /workspace/start.sh
RUN chmod +x /workspace/start.sh

# HF Spaces maps HTTPS traffic to this port (must match README app_port).
EXPOSE 7860

# vllm/vllm-openai sets ENTRYPOINT to the OpenAI API server; its first arg is --model.
# Without this, CMD is interpreted as a model *path* (e.g. literally "/workspace/start.sh").
ENTRYPOINT []

CMD ["/bin/bash", "/workspace/start.sh"]
