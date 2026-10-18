# Cardboard has no dependencies, so the image is just Node and the source.
# Node 22.18+ runs the TypeScript directly.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY deploy/docker-entrypoint.mjs ./deploy/

# /data holds the database (only sealed data), the server key, backups and the
# host's CLI credentials (so `docker compose exec cardboard cardboard host …` works).
# The port is 8787, or $PORT when a platform sets one.
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    CARDBOARD_HOST=0.0.0.0 \
    CARDBOARD_DATA=/data \
    XDG_CONFIG_HOME=/data/config

# Starts as root only to hand /data to the `node` user (see deploy/docker-entrypoint.mjs), then drops to it.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data \
 && printf '#!/bin/sh\nexec node /app/deploy/docker-entrypoint.mjs "$@"\n' > /usr/local/bin/cardboard \
 && chmod 755 /usr/local/bin/cardboard
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- "http://127.0.0.1:${CARDBOARD_PORT:-${PORT:-8787}}/health" >/dev/null || exit 1

ENTRYPOINT ["node", "/app/deploy/docker-entrypoint.mjs"]
CMD ["start"]
