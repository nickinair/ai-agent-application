#!/usr/bin/env bash
# ==============================================================================
# 企业微信会话内容存档 (WeCom Finance SDK) Sidecar 容器化部署脚本
# 支持环境: local (本地开发) / test (测试环境) / prod (生产环境)
# 用法:
#   ./deploy.sh [action] [env]
#   例如:
#     ./deploy.sh deploy local   # 一键构建并部署本地容器
#     ./deploy.sh deploy test    # 一键构建并部署测试环境 (默认)
#     ./deploy.sh deploy prod    # 一键构建并部署生产环境
#     ./deploy.sh logs local     # 追踪本地容器实时日志
#     ./deploy.sh status local   # 查看本地容器状态
#     ./deploy.sh stop local     # 停止本地容器
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ACTION="deploy"
TARGET_ENV="${ENV:-test}"

# 打印彩色输出
info()  { echo -e "\033[34m[INFO]\033[0m $*"; }
warn()  { echo -e "\033[33m[WARN]\033[0m $*"; }
error() { echo -e "\033[31m[ERROR]\033[0m $*" >&2; }
succ()  { echo -e "\033[32m[SUCCESS]\033[0m $*"; }

show_help() {
  cat << EOF
企业微信会话内容存档 (wecom-finance) Sidecar 部署管理脚本

用法:
  ./deploy.sh [action] [env]

可用操作 (action):
  deploy   (默认) 构建镜像、停止旧容器并启动新容器
  build    仅执行 Docker 镜像构建
  start    启动容器（若已存在则直接启动，不存在则创建）
  stop     优雅停止并移除容器
  restart  重启容器
  status   查看容器运行状态与资源信息
  logs     追踪容器实时日志 (相当于 docker logs -f)
  help     显示此帮助信息

可用环境 (env):
  local    本地开发环境 (使用 .env.local 或 .env.dev 配置，容器名: wecom-finance-local)
  test     测试环境 (默认，使用 .env.test 配置，容器名: wecom-finance-test)
  prod     生产环境 (使用 .env.prod 配置，容器名: wecom-finance-prod)

示例:
  ./deploy.sh deploy local    # 部署本地容器
  ./deploy.sh deploy test     # 部署测试环境
  ./deploy.sh deploy prod     # 部署生产环境
  ./deploy.sh logs local      # 查看本地容器实时日志
  ./deploy.sh status local    # 查看本地容器状态
  ./deploy.sh stop local      # 停止本地容器
EOF
}

# 命令行参数解析
if [[ $# -ge 1 ]]; then
  case "$1" in
    local|dev|test|prod)
      TARGET_ENV="$1"
      if [[ $# -ge 2 ]]; then
        ACTION="$2"
      fi
      ;;
    deploy|build|start|stop|restart|status|logs)
      ACTION="$1"
      if [[ $# -ge 2 ]]; then
        TARGET_ENV="$2"
      fi
      ;;
    help|-h|--help)
      show_help
      exit 0
      ;;
    *)
      error "未知参数: $1"
      echo ""
      show_help
      exit 1
      ;;
  esac
fi

# 规范化环境名称
case "$TARGET_ENV" in
  local|dev)
    TARGET_ENV="local"
    if [[ -z "${ENV_FILE:-}" ]]; then
      if [[ -f ".env.local" ]]; then
        ENV_FILE=".env.local"
      else
        ENV_FILE=".env.dev"
      fi
    fi
    CONTAINER_NAME="${CONTAINER_NAME:-wecom-finance-local}"
    DATA_DIR="./data/local"
    IMAGE_TAG="${IMAGE_TAG:-local}"
    ;;
  test)
    TARGET_ENV="test"
    ENV_FILE="${ENV_FILE:-.env.test}"
    CONTAINER_NAME="${CONTAINER_NAME:-wecom-finance-test}"
    DATA_DIR="./data/test"
    IMAGE_TAG="${IMAGE_TAG:-test}"
    ;;
  prod|production)
    TARGET_ENV="prod"
    ENV_FILE="${ENV_FILE:-.env.prod}"
    CONTAINER_NAME="${CONTAINER_NAME:-wecom-finance-prod}"
    DATA_DIR="./data/prod"
    IMAGE_TAG="${IMAGE_TAG:-latest}"
    ;;
  *)
    error "不受支持的目标环境: $TARGET_ENV (仅支持 local、test 或 prod)"
    exit 1
    ;;
esac

IMAGE_NAME="${IMAGE_NAME:-wecom-finance-sidecar}"
KEYS_DIR="./keys"
LIB_DIR="./lib"

# 检查 Docker 运行时环境
check_docker() {
  if ! command -v docker &> /dev/null; then
    error "未检测到 docker 命令，请先安装 Docker: https://docs.docker.com/get-docker/"
    exit 1
  fi
  if ! docker info &> /dev/null; then
    error "Docker 服务未运行或当前用户没有权限访问 Docker Daemon。"
    exit 1
  fi
}

# 检查环境配置文件
check_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    if [[ "$TARGET_ENV" == "prod" ]]; then
      error "未找到生产环境配置文件 $ENV_FILE！"
      echo "👉 请先根据模板创建生产配置并填写真实企业凭据:"
      echo "   cp .env.prod.example .env.prod"
      echo "   vim .env.prod"
      exit 1
    elif [[ "$TARGET_ENV" == "local" ]]; then
      warn "未找到本地配置文件 $ENV_FILE，尝试从 .env.example 生成 .env.dev..."
      if [[ -f ".env.example" ]]; then
        cp .env.example .env.dev
        ENV_FILE=".env.dev"
        info "已为您自动生成 .env.dev"
      else
        error "缺少本地配置文件且未找到 .env.example 模板！"
        exit 1
      fi
    else
      warn "未找到测试环境配置文件 $ENV_FILE，尝试使用 .env.example 生成默认配置..."
      if [[ -f ".env.example" ]]; then
        cp .env.example "$ENV_FILE"
        info "已为您自动生成 $ENV_FILE"
      else
        error "缺少配置文件 $ENV_FILE 且未找到 .env.example 模板！"
        exit 1
      fi
    fi
  fi
}

# 预检与准备挂载目录
prepare_dirs() {
  mkdir -p "$DATA_DIR" "$KEYS_DIR" "$LIB_DIR"
}

# Native 模式下的前置资源检查
check_native_prerequisites() {
  local driver_mode
  driver_mode=$(grep -E "^FINANCE_DRIVER_MODE=" "$ENV_FILE" | cut -d= -f2- | tr -d ' "\r' || true)

  if [[ "$driver_mode" == "native" ]]; then
    info "检测到驱动模式为 native (真实 C-SDK 生产模式)，正在执行必要凭证检查..."
    if [[ ! -f "$KEYS_DIR/private.pem" ]]; then
      warn "未在 $KEYS_DIR/private.pem 检测到 RSA 私钥！"
      warn "容器启动后若无有效私钥将无法解密会话消息，请确认已将企业私钥放置于 $KEYS_DIR/private.pem"
    fi
    if [[ ! -f "$LIB_DIR/libWeWorkFinanceSdk_C.so" ]]; then
      warn "未在 $LIB_DIR/libWeWorkFinanceSdk_C.so 检测到官方 C 动态库！"
      warn "容器启动后将无法加载企微原生 SDK，请从企业微信官方文档下载 Linux glibc 动态库并放入 $LIB_DIR/"
    fi
  fi
}

# 构建镜像
do_build() {
  info "==> 开始构建 Docker 镜像: ${IMAGE_NAME}:${IMAGE_TAG} ..."
  docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" .
  succ "Docker 镜像构建完成: ${IMAGE_NAME}:${IMAGE_TAG}"
}

# 停止容器
do_stop() {
  info "==> 检查并停止容器: ${CONTAINER_NAME} ..."
  if docker ps -a --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
    docker stop "$CONTAINER_NAME" > /dev/null 2>&1 || true
    docker rm "$CONTAINER_NAME" > /dev/null 2>&1 || true
    succ "容器 ${CONTAINER_NAME} 已停止并移除。"
  else
    info "容器 ${CONTAINER_NAME} 不存在或已处于停止状态。"
  fi
}

# 启动容器
do_start() {
  check_docker
  check_env_file
  prepare_dirs
  check_native_prerequisites

  if docker ps --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
    warn "容器 ${CONTAINER_NAME} 已经在运行中！"
    return 0
  fi

  # 若存在同名停止容器，则移除
  if docker ps -a --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
    docker rm "$CONTAINER_NAME" > /dev/null 2>&1 || true
  fi

  info "==> 启动容器: ${CONTAINER_NAME} (环境: ${TARGET_ENV}, 配置文件: ${ENV_FILE}) ..."

  local network_arg=()
  if [[ -n "${DOCKER_NETWORK:-}" ]]; then
    network_arg=(--network "$DOCKER_NETWORK")
  elif docker network ls --format '{{.Name}}' | grep -Eq "^agent-platform\$"; then
    # 若存在主项目的 compose 网络则自动加入
    network_arg=(--network "agent-platform")
  fi

  # 注入 host-gateway 以支持容器内直接访问宿主机服务 (host.docker.internal)
  local extra_args=(--add-host=host.docker.internal:host-gateway)

  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --env-file "$ENV_FILE" \
    -v "$(pwd)/$DATA_DIR:/app/data" \
    -v "$(pwd)/$KEYS_DIR:/app/keys" \
    -v "$(pwd)/$LIB_DIR:/app/lib" \
    "${network_arg[@]}" \
    "${extra_args[@]}" \
    "${IMAGE_NAME}:${IMAGE_TAG}"

  # 等待启动并检查健康状态
  info "正在验证容器启动状态 (等待 3 秒)..."
  sleep 3

  if docker ps --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
    succ "容器 ${CONTAINER_NAME} 已成功运行！"
    echo "--------------------------------------------------------"
    docker ps --filter "name=^/${CONTAINER_NAME}$"
    echo "--------------------------------------------------------"
    info "启动初期输出日志 (前 15 行):"
    docker logs --tail 15 "$CONTAINER_NAME"
    echo "--------------------------------------------------------"
    info "若需持续查看实时日志，请执行: ./deploy.sh logs ${TARGET_ENV}"
  else
    error "容器 ${CONTAINER_NAME} 启动后异常退出！"
    echo "----------------- 容器崩溃日志输出 -----------------"
    docker logs --tail 30 "$CONTAINER_NAME" 2>&1 || true
    echo "----------------------------------------------------"
    exit 1
  fi
}

# 查看状态
do_status() {
  check_docker
  info "==> 容器状态查询: ${CONTAINER_NAME} (环境: ${TARGET_ENV})"
  if docker ps -a --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
    docker ps -a --filter "name=^/${CONTAINER_NAME}$"
  else
    warn "未找到正在运行或已停止的容器: ${CONTAINER_NAME}"
  fi
}

# 查看日志
do_logs() {
  check_docker
  if ! docker ps -a --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
    error "未找到容器 ${CONTAINER_NAME}，无法查看日志。"
    exit 1
  fi
  info "==> 正在追踪日志: ${CONTAINER_NAME} (按 Ctrl+C 退出)..."
  docker logs -f --tail 100 "$CONTAINER_NAME"
}

# 执行分发
case "$ACTION" in
  deploy)
    check_docker
    check_env_file
    prepare_dirs
    check_native_prerequisites
    do_build
    do_stop
    do_start
    ;;
  build)
    check_docker
    do_build
    ;;
  start)
    do_start
    ;;
  stop)
    check_docker
    do_stop
    ;;
  restart)
    check_docker
    do_stop
    do_start
    ;;
  status)
    do_status
    ;;
  logs)
    do_logs
    ;;
  *)
    error "未知操作: $ACTION"
    show_help
    exit 1
    ;;
esac
