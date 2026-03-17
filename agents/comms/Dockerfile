FROM node:20-slim

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm ci --omit=dev

COPY agents/comms/ ./agents/comms/
COPY src/ ./src/

RUN npx tsc

CMD ["node", "dist/agents/comms/tools.js"]
