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
