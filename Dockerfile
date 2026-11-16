# The hub and the console ship as one image with two entrypoints; nothing to install because there are no runtime deps.
FROM node:24-slim AS hub
WORKDIR /app
COPY . .
ENV AGENT_AUTOLOOP_HOME=/data
EXPOSE 3350
# entrypoint so `docker compose run hub init --no-service` works without repeating the interpreter
ENTRYPOINT ["node", "bin/agent-autoloop.ts"]
CMD ["up"]

FROM node:24-slim AS console
WORKDIR /app
COPY . .
ENV AGENT_AUTOLOOP_HOME=/data
ENV CONSOLE_HOST=0.0.0.0
CMD ["node", "tools/console/serve.ts"]

# Optional: the hub plus Codex, for running the agent inside the container. Build it with
# `docker build --target hub-codex -t agent-autoloop:codex .`; the other targets are unchanged.
FROM hub AS hub-codex
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @openai/codex
# Keep the agent's login in the data volume, so rebuilding the image does not sign it out again.
ENV CODEX_HOME=/data/codex
