# The stage console. Runs on ECS beside the gateway, behind the same ALB.
#
# It exists as a server rather than a static bundle for one reason: every call
# it makes to the gateway carries the master key, and a key must never reach a
# browser. The key arrives from Secrets Manager as an environment variable at
# runtime and is never baked in - see .dockerignore.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Inlined at build time, so it has to be present for the build, not just at run.
ENV NEXT_PUBLIC_BASE_PATH=/console
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3100
# HOSTNAME is deliberately NOT set here. Docker sets HOSTNAME to the container
# hostname and that wins, so Next binds to a name that resolves to loopback -
# the server starts, logs "Ready", and the load balancer can never reach it.
# Observed: healthy-looking logs, targets draining forever, 503 at the edge.
# The command below pins it at exec time, where nothing can override it.
ENV NEXT_PUBLIC_BASE_PATH=/console
# standalone is a self-contained server bundle: node + this directory, no
# node_modules tree to ship.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3100
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 exec node server.js"]
