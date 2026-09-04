# syntax=docker/dockerfile:1
FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json nest-cli.json mikro-orm.config.ts ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

USER bun
EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
