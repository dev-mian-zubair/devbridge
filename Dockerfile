FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Pin deliberately: both execution paths (the chat-completions route's
# stream-json event shapes and the debug terminal's PTY output) depend on
# this CLI version's exact behavior.
RUN npm install -g @anthropic-ai/claude-code@2.1.316

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# 0.0.0.0 so `docker run -p 127.0.0.1:3000:3000 ...` can actually reach the
# server: Docker's port forward lands on the container's own network
# interface, not its loopback, so a server bound to 127.0.0.1 *inside* the
# container is unreachable even with a published port. The host-side bind
# in `docker run -p 127.0.0.1:...` is what satisfies PRD §5.2, not this one.
ENV CLAUDE_CONFIG_DIR=/data/.claude
ENV HOST=0.0.0.0

VOLUME ["/data/.claude"]

CMD ["node", "src/server.js"]
