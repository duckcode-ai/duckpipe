FROM node:20-slim

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm ci --omit=dev

COPY agents/runtime.ts ./agents/
COPY agents/airflow/ ./agents/airflow/
COPY src/types.ts ./src/

RUN npx tsc

ENV DUCKPIPE_BUS_DIR=/app/bus
CMD ["node", "dist/agents/airflow/index.js"]
