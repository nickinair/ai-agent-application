# 企业微信会话内容存档 (Finance SDK) 独立 Sidecar 镜像
# 注意：企微官方 libWeWorkFinanceSdk_C.so 基于 GNU C Library (glibc)，故必须使用 Debian 系基础镜像
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# 安装构建依赖
COPY package.json tsconfig.json ./
RUN npm install --registry=https://registry.npmmirror.com

# 复制源码并编译
COPY src/ ./src/
RUN npm run build

# 生产运行阶段
FROM node:22-bookworm-slim AS runner

WORKDIR /app

# 安装 glibc 运行时基础库与证书
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

# 从 builder 复制编译出的 dist
COPY --from=builder /app/dist ./dist

# 创建持久化卷与挂载目录
RUN mkdir -p /app/data /app/keys /app/lib

# 环境变量默认配置
ENV NODE_ENV=production \
    FINANCE_DRIVER_MODE=mock \
    POLL_INTERVAL_MS=1000 \
    BATCH_SIZE=100 \
    CURSOR_STORAGE_PATH=/app/data/seq.cursor \
    RSA_PRIVATE_KEY_PATH=/app/keys/private.pem \
    WECOM_C_SDK_LIB_PATH=/app/lib/libWeWorkFinanceSdk_C.so \
    A3_WEBHOOK_URL=http://ai-agent-application:3002/api/admin/wecom/finance-inbound \
    A3_WEBHOOK_SECRET=

VOLUME ["/app/data", "/app/keys", "/app/lib"]

ENTRYPOINT ["node", "dist/index.js"]
