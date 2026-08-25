# MailMint API — REST API, dashboard, webhook delivery and the re-parse worker.
#
# Built from the MONOREPO ROOT, not from this directory: packages/parser is a
# workspace dependency and a build context rooted here could not see it.
#   docker build -f packages/api/Dockerfile -t mailmint-api .
FROM node:20-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

# The workspace manifests first, so a change to source code does not invalidate
# the dependency layer.
COPY package.json package-lock.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/parser/package.json ./packages/parser/

RUN npm ci --omit=dev --workspace mailmint-api --include-workspace-root \
 && rm -rf /root/.npm

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
