# himarket-gateway — Node ESM 服务（零外部依赖，node:sqlite）
#
# 构建（ARM64 集群）：
#   podman build --platform linux/arm64 -t himarket-gateway:<tag> .
#
# 入口：package.json bin = lib/server.js（已预编译，无需 tsc）
# 数据：sqlite 文件，路径由 GATEWAY_DB_PATH 指定（默认 ~/.dsh-himarket-gateway/audit.db）
FROM node:22-slim

WORKDIR /app

# 零外部依赖，但仍复制 package.json 以保留 ESM type 声明
COPY package.json ./

# 复制运行所需内容（lib 为预编译产物，src 供排错参考）
COPY lib ./lib
COPY scripts ./scripts

# 非 root 运行
RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENV NODE_ENV=production
ENV GATEWAY_PORT=3091
# sqlite 数据文件放 PVC（挂载 /data）
ENV GATEWAY_DB_PATH=/data/audit.db
# 允许集群内访问（网关有 IP 白名单）
ENV GATEWAY_ALLOWLIST=0.0.0.0/0

EXPOSE 3091

CMD ["node", "lib/server.js"]
