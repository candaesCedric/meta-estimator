FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV CHAMPION_POOL_SIZE=300
ENV CHAMPION_BATTLES=5000
ENV CHAMPION_CONCURRENCY=4
ENV CHAMPION_REPORT_EVERY=1000
ENV CHAMPION_FLUSH_EVERY=100
ENV CHAMPION_RETIRE_AFTER=750
ENV CHAMPION_EXTRA_ARGS=""

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

COPY . .
RUN node build

RUN mkdir -p /app/databases/champion-meta && chown -R node:node /app
VOLUME ["/app/databases/champion-meta"]

USER node

CMD ["sh", "-lc", "node tools/champion-meta/index.js --format=champion --pool-size=${CHAMPION_POOL_SIZE} --battles=${CHAMPION_BATTLES} --concurrency=${CHAMPION_CONCURRENCY} --report-every=${CHAMPION_REPORT_EVERY} --flush-every=${CHAMPION_FLUSH_EVERY} --retire-after=${CHAMPION_RETIRE_AFTER} ${CHAMPION_EXTRA_ARGS}"]
