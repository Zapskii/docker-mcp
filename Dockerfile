FROM node:24-alpine
WORKDIR /app

# Docker CLI + compose plugin — needed by runSafe-based tools (compose, build)
RUN apk add --no-cache docker-cli docker-cli-compose
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1
EXPOSE 3001
USER node
CMD ["node", "server.js"]
