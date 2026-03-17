FROM node:20-slim

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm ci --omit=dev

COPY agents/dbt/ ./agents/dbt/
COPY src/ ./src/

RUN npx tsc

CMD ["node", "dist/agents/dbt/tools.js"]
