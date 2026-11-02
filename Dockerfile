FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV CLAUDE_CONFIG_DIR=/data/.claude
ENV HOST=127.0.0.1

VOLUME ["/data/.claude"]

CMD ["node", "src/server.js"]
