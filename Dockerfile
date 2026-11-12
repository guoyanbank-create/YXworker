# 可选：容器化本机部署（默认交付方式是 pnpm install && pnpm start）
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@12.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 YXWORKER_DATA_DIR=/app/.data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY package.json ./
EXPOSE 8787
VOLUME ["/app/.data"]
CMD ["node", "apps/server/dist/index.js"]
