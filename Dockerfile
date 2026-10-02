FROM node:24-bookworm-slim AS base
RUN npm install -g pnpm@12.5.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY apps apps
COPY packages packages
RUN pnpm build

FROM base AS runtime-dependencies
RUN pnpm --filter @kikit/server... install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=runtime-dependencies /app /app
COPY --from=build /app/apps/server/src apps/server/src
COPY --from=build /app/apps/server/migrations apps/server/migrations
COPY --from=build /app/packages/contracts/src packages/contracts/src
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
EXPOSE 3001
CMD ["node", "apps/server/node_modules/tsx/dist/cli.mjs", "apps/server/src/main.ts"]
