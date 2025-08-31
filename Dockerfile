# syntax=docker/dockerfile:1

FROM node:20-alpine

WORKDIR /app

RUN npm init -y \
 && npm pkg set type=module \
 && npm i -E \
      typescript ts-node \
      @walletconnect/core @walletconnect/types \
      @reown/walletkit \
      uuid redis tsx \
      --no-audit --no-fund --loglevel=warn

ENV NODE_ENV=production \
    REDIS_URL=redis://localhost:6379

COPY walletconnect-bridge.ts ./

CMD ["npx","tsx","walletconnect-bridge.ts"]
