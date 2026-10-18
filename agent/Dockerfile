FROM node:22-bookworm-slim
WORKDIR /app
COPY agent/package*.json ./
RUN npm ci --omit=dev && mkdir /data && chown node:node /data
COPY --chown=node:node agent/ ./
USER node:node
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
