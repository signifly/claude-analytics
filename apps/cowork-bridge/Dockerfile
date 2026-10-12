# Build from the repository root: docker build -f apps/cowork-bridge/Dockerfile .
FROM node:22-alpine
WORKDIR /app
COPY plugins/usage-analytics/scripts plugins/usage-analytics/scripts
COPY apps/cowork-bridge/*.mjs apps/cowork-bridge/
USER node
ENV PORT=4318
EXPOSE 4318
CMD ["node", "apps/cowork-bridge/main.mjs"]
