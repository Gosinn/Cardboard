# Cardboard has no dependencies, so the image is just Node and the source.
# Node 22.18+ runs the TypeScript directly.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

# /data holds the database (only sealed data), the server key, backups and the
# host's CLI credentials (so `docker compose exec cardboard node src/cli.ts host …` works).
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    CARDBOARD_HOST=0.0.0.0 \
    CARDBOARD_PORT=8787 \
    CARDBOARD_DATA=/data \
    XDG_CONFIG_HOME=/data/config

RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8787/health >/dev/null || exit 1

ENTRYPOINT ["node", "src/cli.ts"]
CMD ["start"]
