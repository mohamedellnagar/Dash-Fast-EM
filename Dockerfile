# ---- Build stage ----
FROM node:20-alpine AS build
# OpenSSL is required for Prisma to pick the correct query engine on Alpine.
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:20-alpine AS runtime
# Version stamp baked in at build time (the image has no .git to read). CI passes
# these; they surface in the UI footer and /health.
ARG GIT_SHA=unknown
ARG BUILD_TIME
ENV NODE_ENV=production
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME
# OpenSSL so Prisma detects the right engine at runtime (no runtime download).
RUN apk add --no-cache openssl
WORKDIR /app
# Non-root user for security.
RUN addgroup -S app && adduser -S app -G app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
# Let the non-root user write Prisma engines if the CLI ever needs to (belt-and-suspenders).
RUN chown -R app:app /app/node_modules/@prisma /app/node_modules/.prisma /app/node_modules/prisma 2>/dev/null || true
USER app
EXPOSE 3000
# The entrypoint runs `prisma migrate deploy` then execs the command below.
# The container runs the web server by default; the worker uses the same image
# with command: node dist/workers/sync.worker.js
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
