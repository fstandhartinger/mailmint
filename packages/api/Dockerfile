# MailMint API — REST API, dashboard, webhook delivery and the re-parse worker.
#
# Built from the MONOREPO ROOT, not from this directory: packages/parser is a
# workspace dependency and a build context rooted here could not see it.
#   docker build -f packages/api/Dockerfile -t mailmint-api .
FROM node:20-bookworm-slim

ENV NODE_ENV=production

# curl is not in node:*-slim, and Coolify's rolling-update health gate shells out
# to curl or wget INSIDE the container. Without it the gate reports
# "curl: not found", marks a perfectly healthy container unhealthy and rolls the
# deployment back - the app's own HEALTHCHECK below (which uses node's fetch)
# never gets a say. This cost one failed deploy on 2026-08-26.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The workspace manifests first, so a change to source code does not invalidate
# the dependency layer.
COPY package.json package-lock.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/parser/package.json ./packages/parser/

RUN npm ci --omit=dev --workspace mailmint-api --include-workspace-root \
 && rm -rf /root/.npm

# The parser resolves its LLM client from ../../../shared/llm relative to
# packages/parser/src, i.e. /app/shared/llm. That file used to live only in the
# pdfnode monorepo ONE LEVEL ABOVE this repository, so it resolved on the dev box
# and was absent in the image. The parser then threw 'no LLM client available',
# the error was swallowed, and /v1/parse answered 200 with every field null and
# no flags - the documented quickstart example returned nothing. It is vendored
# into this repository now so the container has what the dev box has.
COPY shared ./shared
COPY packages/parser ./packages/parser
COPY packages/api ./packages/api

# The service handles other people's email and calls out to an LLM with it.
# Nothing here needs root, so nothing here runs as root.
RUN groupadd --system --gid 10001 mailmint \
 && useradd --system --uid 10001 --gid mailmint --home-dir /home/mailmint --create-home mailmint \
 && mkdir -p /app/ops/failures && chown -R mailmint:mailmint /app/ops /home/mailmint
USER mailmint

EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/api/src/server.js"]
