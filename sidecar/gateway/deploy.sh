#!/usr/bin/env bash
# ==============================================================================
# a3 专属内部微服务网关 (服务注册发现与配置中心) 部署与运维脚本
# 支持模式：
#   ./deploy.sh deploy local    - 本地开发容器部署
#   ./deploy.sh deploy test     - 测试环境部署
#   ./deploy.sh deploy prod     - 生产环境部署
#   ./deploy.sh status [env]    - 查看容器状态
#   ./deploy.sh logs [env]      - 查看日志
#   ./deploy.sh stop [env]      - 停止并删除容器
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

APP_NAME="a3-internal-gateway"
IMAGE_TAG="a3-gateway:latest"

info()  { echo -e "\033[1;32m[INFO]\033[0m $*"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m $*"; }
error() { echo -e "\033[1;31m[ERROR]\033[0m $*"; exit 1; }

check_docker() {
  if ! command -v docker &>/dev/null; then
    error "未检测到 docker 命令，请先安装 Docker: https://docs.docker.com/get-docker/"
  fi
}

build_image() {
  info "正在构建网关微服务 Docker 镜像 (${IMAGE_TAG})..."
  docker build -t "$IMAGE_TAG" -f Dockerfile .
  info "镜像构建完成: ${IMAGE_TAG}"
}

deploy_env() {
  local target_env="${1:-local}"
  local container_name="${APP_NAME}-${target_env}"
  local port=3003

  info "正在部署环境: [${target_env}] (容器: ${container_name})..."
  build_image

  # 清理旧容器
  if docker ps -a --format '{{.Names}}' | grep -Eq "^${container_name}\$"; then
    warn "发现旧容器 ${container_name}，正在停止并移除..."
    docker stop "$container_name" 2>/dev/null || true
    docker rm -f "$container_name" 2>/dev/null || true
  fi

  local run_opts=(
    "-d"
    "--name" "$container_name"
    "--restart" "unless-stopped"
    "-p" "${port}:3003"
    "-e" "NODE_ENV=${target_env}"
    "-e" "PORT=3003"
  )

  if [ "$target_env" = "local" ]; then
    run_opts+=("--add-host=host.docker.internal:host-gateway")
    run_opts+=("-e" "REDIS_HOST=host.docker.internal")
  fi

  if [ -f ".env.${target_env}" ]; then
    run_opts+=("--env-file" ".env.${target_env}")
  elif [ -f ".env" ]; then
    run_opts+=("--env-file" ".env")
  fi

  info "启动网关容器: docker run ${run_opts[*]} $IMAGE_TAG"
  docker run "${run_opts[@]}" "$IMAGE_TAG"

  info "✅ 部署成功！容器已启动: ${container_name}"
  info "👉 服务地址: http://127.0.0.1:${port}/health"
}

show_status() {
  local target_env="${1:-local}"
  local container_name="${APP_NAME}-${target_env}"
  check_docker
  docker ps -a --filter "name=^${container_name}$"
}

show_logs() {
  local target_env="${1:-local}"
  local container_name="${APP_NAME}-${target_env}"
  check_docker
  docker logs -f "$container_name"
}

stop_env() {
  local target_env="${1:-local}"
  local container_name="${APP_NAME}-${target_env}"
  check_docker
  info "停止并清理容器: ${container_name}"
  docker stop "$container_name" 2>/dev/null || true
  docker rm -f "$container_name" 2>/dev/null || true
  info "清理完成。"
}

# 命令行路由
ACTION="$1"
TARGET_ENV="${2:-local}"

check_docker

case "$ACTION" in
  deploy)
    deploy_env "$TARGET_ENV"
    ;;
  status)
    show_status "$TARGET_ENV"
    ;;
  logs)
    show_logs "$TARGET_ENV"
    ;;
  stop)
    stop_env "$TARGET_ENV"
    ;;
  build)
    build_image
    ;;
  *)
    echo "用法: $0 {deploy|status|logs|stop|build} [local|test|prod]"
    exit 1
    ;;
esac
