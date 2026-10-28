# 构建上下文：本仓库根目录
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
# 与数据库会话时区（+08:00）一致：mysql2 按容器本地时区读写 DATETIME，容器为 UTC 时 NOW() 读出会偏 8 小时
ENV NODE_ENV=production \
    TZ=Asia/Shanghai
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/database ./database
USER node
CMD ["node", "dist/main.js"]
