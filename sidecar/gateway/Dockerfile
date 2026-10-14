# a3 专属内部微服务网关 (服务注册发现与配置中心) 镜像
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# 安装构建依赖
COPY package.json tsconfig*.json ./
RUN npm install --registry=https://registry.npmmirror.com

# 复制源码并编译
COPY src/ ./src/
RUN npm run build

# 生产运行阶段
FROM node:22-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

# 从 builder 复制编译出的 dist
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production \
    PORT=3003 \
    REDIS_HOST=redis \
    REDIS_PORT=6379 \
    REGISTRY_TTL_SECONDS=30

EXPOSE 3003

ENTRYPOINT ["node", "dist/main.js"]
