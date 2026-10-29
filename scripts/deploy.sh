#!/usr/bin/env bash
# ==============================================================================
# a3 体系多组件单宿主机 Docker 整合部署与运维脚本
# 覆盖模块：
#   1. sidecar/gateway       - a3 专属服务注册发现与配置中心 (端口: 3003)
#   2. ai-agent-application  - a3 主应用核心后端 (端口: 3002)
#   3. sidecar/wecom-finance - 企微会话存档全量感知伴生服务 (后台工作进程)
#   4. crm-ai-agent (Core)   - Agent 核心服务：封组之后的理解与组织回复 (端口: 3001，仅本机)
#                              代码在同级目录 ../crm-ai-agent（可用 CORE_DIR 指定）
# 支持环境:
#   本地环境: local (默认对接 host.docker.internal)
#   测试环境: test
#   生产环境: prod
# 支持模式:
#   交互式 TUI: 直接运行 ./deploy.sh 或 ./scripts/deploy.sh
#   命令行 CLI: 传入参数直接静默批处理执行 (适配 CI/CD)
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 彩色输出工具函数
info()    { echo -e "\033[1;34m[INFO]\033[0m $*"; }
succ()    { echo -e "\033[1;32m[SUCCESS]\033[0m $*"; }
warn()    { echo -e "\033[1;33m[WARN]\033[0m $*"; }
error()   { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; }
divider() { echo -e "\033[1;30m----------------------------------------------------------------------\033[0m"; }

# 基础目录与模块路径
GW_DIR="${ROOT_DIR}/sidecar/gateway"
A3_DIR="${ROOT_DIR}"
FIN_DIR="${ROOT_DIR}/sidecar/wecom-finance"
# Agent 核心服务（crm-ai-agent 仓库，与本仓库放在同一目录下）
CORE_DIR="${CORE_DIR:-$(cd "${ROOT_DIR}/.." && pwd)/crm-ai-agent}"
# 共享媒体卷宿主机目录（图片识别 P1/P2，供 A3、会话存档与核心服务共享）
MEDIA_HOST_DIR="${MEDIA_HOST_DIR:-$(cd "${ROOT_DIR}/.." && pwd)/data/media}"

ensure_media_dir() {
  mkdir -p "${MEDIA_HOST_DIR}/bot" "${MEDIA_HOST_DIR}/fin"
  chmod -R 777 "${MEDIA_HOST_DIR}" 2>/dev/null || true
  # 清理超过 90 天的历史图片缓存
  find "${MEDIA_HOST_DIR}" -type f -mtime +90 -delete 2>/dev/null || true
}

# 参数默认值
ACTION=""
ENV="local"
TARGET="all"
REMOTE_HOST=""

# 远程部署连接参数 (支持环境变量注入)
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_PORT="${REMOTE_PORT:-22}"
REMOTE_DIR="${REMOTE_DIR:-/opt/ai-agent-application}"
SSH_KEY="${SSH_KEY:-}"
SKIP_SYNC="${SKIP_SYNC:-false}"
SKIP_MIGRATE="${SKIP_MIGRATE:-false}"

# ==============================================================================
# 终端交互式 UI 引擎与精确对齐 (TUI Engine & Alignments)
# ==============================================================================

# 恢复终端属性的安全退出陷阱
cleanup_terminal() {
  printf "\033[?25h" 2>/dev/null || true
  stty echo 2>/dev/null || true
}
trap cleanup_terminal EXIT INT TERM

# 顶部横幅 (Banner Box - 72 列宽绝对垂直闭合)
print_banner() {
  echo -e "\033[36m  ╭────────────────────────────────────────────────────────────────────────╮\033[0m"
  echo -e "\033[36m  │\033[0m        \033[1;36m🤖 A3 智能体全能平台 · 容器化部署器 (Deploy Runner)\033[0m             \033[36m│\033[0m"
  echo -e "\033[36m  │\033[0m           \033[90mUnified Docker Multi-Service Deployment for A3\033[0m               \033[36m│\033[0m"
  echo -e "\033[36m  ╰────────────────────────────────────────────────────────────────────────╯\033[0m"
  echo ""
}

# 单字符/方向键捕获
read_key() {
  local key
  IFS= read -rsn1 key 2>/dev/null || true
  if [[ "$key" == $'\x1b' ]]; then
    read -rsn2 -t 0.1 key2 2>/dev/null || true
    case "$key2" in
      "[A"|"OA") echo "UP" ;;
      "[B"|"OB") echo "DOWN" ;;
      *) echo "ESC" ;;
    esac
  elif [[ "$key" == "" ]]; then
    echo "ENTER"
  elif [[ "$key" == " " ]]; then
    echo "SPACE"
  elif [[ "$key" == "q" || "$key" == "Q" ]]; then
    echo "QUIT"
  elif [[ "$key" == "a" || "$key" == "A" ]]; then
    echo "ALL"
  elif [[ "$key" == "i" || "$key" == "I" ]]; then
    echo "INVERT"
  elif [[ "$key" =~ ^[0-9]$ ]]; then
    echo "NUM_$key"
  else
    echo "OTHER"
  fi
}

# 通用单选菜单 (ANSI 无闪烁重绘 + 空格与Tab严格对齐)
# 用法: menu_single_select "提示语" 默认索引 数组变量名
SELECTED_SINGLE_INDEX=0
menu_single_select() {
  local prompt="$1"
  local cur_idx="$2"
  local -n items_ref="$3"
  local total=${#items_ref[@]}

  stty -echo
  printf "\033[?25l" # 隐藏光标

  echo -e "\033[1;32m?\033[0m \033[1m${prompt}\033[0m"

  local rendered_lines=0

  while true; do
    # 渲染选项列表
    local i
    for ((i=0; i<total; i++)); do
      local line="${items_ref[$i]}"
      if [[ $i -eq $cur_idx ]]; then
        echo -e "  \033[1;36m❯\033[0m \033[1;36m${line}\033[0m"
      else
        echo -e "    ${line}"
      fi
    done
    rendered_lines=$total

    local key
    key="$(read_key)"
    case "$key" in
      UP)
        cur_idx=$(( (cur_idx - 1 + total) % total ))
        ;;
      DOWN)
        cur_idx=$(( (cur_idx + 1) % total ))
        ;;
      SPACE|ENTER)
        SELECTED_SINGLE_INDEX=$cur_idx
        printf "\033[%dA" "$rendered_lines"
        for ((i=0; i<rendered_lines; i++)); do
          printf "\033[2K\n"
        done
        printf "\033[%dA" "$rendered_lines"
        cleanup_terminal
        return 0
        ;;
      QUIT)
        cleanup_terminal
        echo -e "\n\033[33m[INFO] 已取消操作。\033[0m"
        exit 0
        ;;
      NUM_*)
        local num="${key#NUM_}"
        if [[ $num -ge 1 && $num -le $total ]]; then
          cur_idx=$((num - 1))
        fi
        ;;
    esac

    # 光标回跳清除，避免滚屏残留
    printf "\033[%dA" "$rendered_lines"
  done
}

# 通用多选菜单 (对齐截图 ❯ ◉ / ◯ 样式 + 空格/Tab对齐)
# 用法: menu_multi_select "提示语" 状态数组变量名 标签数组变量名
SELECTED_MULTI_COUNT=0
menu_multi_select() {
  local prompt="$1"
  local -n checked_ref="$2"
  local -n labels_ref="$3"
  local total=${#labels_ref[@]}
  local cur_idx=0

  stty -echo
  printf "\033[?25l"

  echo -e "\033[1;32m?\033[0m \033[1m${prompt}\033[0m"

  local rendered_lines=0

  while true; do
    local i
    for ((i=0; i<total; i++)); do
      local label="${labels_ref[$i]}"
      local check_mark
      if [[ "${checked_ref[$i]}" -eq 1 ]]; then
        check_mark="\033[1;32m◉\033[0m"
      else
        check_mark="\033[90m◯\033[0m"
      fi

      if [[ $i -eq $cur_idx ]]; then
        echo -e "  \033[1;36m❯\033[0m ${check_mark} \033[1;36m${label}\033[0m"
      else
        echo -e "    ${check_mark} ${label}"
      fi
    done
    rendered_lines=$total

    local key
    key="$(read_key)"
    case "$key" in
      UP)
        cur_idx=$(( (cur_idx - 1 + total) % total ))
        ;;
      DOWN)
        cur_idx=$(( (cur_idx + 1) % total ))
        ;;
      SPACE)
        if [[ "${checked_ref[$cur_idx]}" -eq 1 ]]; then
          checked_ref[$cur_idx]=0
        else
          checked_ref[$cur_idx]=1
        fi
        ;;
      ALL)
        for ((i=0; i<total; i++)); do checked_ref[$i]=1; done
        ;;
      INVERT)
        for ((i=0; i<total; i++)); do
          checked_ref[$i]=$(( 1 - checked_ref[$i] ))
        done
        ;;
      NUM_*)
        local num="${key#NUM_}"
        if [[ $num -ge 1 && $num -le $total ]]; then
          local target_idx=$((num - 1))
          checked_ref[$target_idx]=$(( 1 - checked_ref[$target_idx] ))
        fi
        ;;
      ENTER)
        # 计算已选中的数量
        SELECTED_MULTI_COUNT=0
        for ((i=0; i<total; i++)); do
          if [[ "${checked_ref[$i]}" -eq 1 ]]; then
            SELECTED_MULTI_COUNT=$((SELECTED_MULTI_COUNT + 1))
          fi
        done

        if [[ $SELECTED_MULTI_COUNT -eq 0 ]]; then
          # 若一项都没选，默认不放行，提示用户
          continue
        fi

        printf "\033[%dA" "$rendered_lines"
        for ((i=0; i<rendered_lines; i++)); do
          printf "\033[2K\n"
        done
        printf "\033[%dA" "$rendered_lines"
        cleanup_terminal
        return 0
        ;;
      QUIT)
        cleanup_terminal
        echo -e "\n\033[33m[INFO] 已取消操作。\033[0m"
        exit 0
        ;;
    esac

    printf "\033[%dA" "$rendered_lines"
  done
}

# ==============================================================================
# 三级级联交互控制器 (Cascading Runner)
# ==============================================================================

interactive_runner() {
  clear 2>/dev/null || true
  print_banner

  # ----------------------------------------------------------------------------
  # 【第一级：目标服务器选择 (单选)】
  # ----------------------------------------------------------------------------
  local server_labels=(
    "1. 🏠 本地宿主机 (Localhost)     	- 本地开发调试环境 (127.0.0.1 / Docker)"
    "2. 🧪 测试服务器 (Test Server)   	- 测试验证环境 (使用 .env.test 配置)"
    "3. 🏢 生产服务器 (Production)    	- 线上生产宿主机 (默认 1.1.1.1 / .env.prod)"
    "4. 🌐 自定义远程主机 (Custom SSH)	- 输入自定义 IP 与 SSH 端口"
  )

  menu_single_select "请选择部署目标服务器 (方向键移动光标，回车确认):" 0 server_labels
  local server_choice=$SELECTED_SINGLE_INDEX

  local chosen_env="local"
  local chosen_host=""
  local server_display_name=""

  case "$server_choice" in
    0)
      chosen_env="local"
      chosen_host="localhost"
      server_display_name="🏠 本地宿主机 (Localhost)"
      ;;
    1)
      chosen_env="test"
      read -r -p "请输入测试服务器 IP/域名 [127.0.0.1]: " input_host
      chosen_host="${input_host:-127.0.0.1}"
      server_display_name="🧪 测试服务器 (${chosen_host})"
      ;;
    2)
      chosen_env="prod"
      read -r -p "请输入生产服务器 IP/域名 [1.1.1.1]: " input_host
      chosen_host="${input_host:-1.1.1.1}"
      server_display_name="🏢 生产服务器 (${chosen_host})"
      ;;
    3)
      chosen_env="prod"
      read -r -p "请输入远程服务器 IP/域名: " input_host
      if [[ -z "${input_host:-}" ]]; then
        error "远程主机不能为空！"
        exit 1
      fi
      chosen_host="$input_host"
      read -r -p "请输入 SSH 端口 [22]: " input_port
      REMOTE_PORT="${input_port:-22}"
      read -r -p "请输入 SSH 用户名 [root]: " input_user
      REMOTE_USER="${input_user:-root}"
      server_display_name="🌐 自定义远程主机 (${REMOTE_USER}@${chosen_host}:${REMOTE_PORT})"
      ;;
  esac

  ENV="$chosen_env"
  if [[ "$chosen_host" != "localhost" ]]; then
    REMOTE_HOST="$chosen_host"
  fi

  echo -e "\033[1;32m✔\033[0m 当前目标环境: \033[1;36m${server_display_name}\033[0m\n"

  # ----------------------------------------------------------------------------
  # 【第二级：选择对该服务器执行的运维动作 (单选)】
  # ----------------------------------------------------------------------------
  local action_labels=(
    "1. 🚀 部署应用组件 (Deploy)      	- 进入组件多选，按依赖拓扑有序构建启动"
    "2. 📊 状态看板与探针 (Status)    	- 查看容器运行状态与 HTTP 健康探针"
    "3. 📜 查看容器实时日志 (Logs)    	- 流式追踪指定容器实时控制台日志"
    "4. 🔄 重启服务集群 (Restart)     	- 重新启动该环境的所有容器"
    "5. 🛑 优雅停止服务 (Stop)        	- 逆序优雅停止所有容器"
    "6. 🧹 清理容器与网络 (Clean)     	- 停止容器并删除专属 Docker 桥接网络"
    "7. ↩️ 返回重新选择 (Restart TUI) 	- 重新选择目标服务器"
  )

  menu_single_select "请选择对 [${server_display_name}] 执行的操作 (方向键移动光标，回车确认):" 0 action_labels
  local action_choice=$SELECTED_SINGLE_INDEX

  case "$action_choice" in
    0)
      # 部署应用 (Deploy) -> 进入第三级组件多选
      ;;
    1)
      # 查看状态 (Status)
      if [[ -n "${REMOTE_HOST:-}" ]]; then
        ACTION="remote-status"
      else
        ACTION="status"
      fi
      check_prerequisites_and_run
      exit 0
      ;;
    2)
      # 查看日志 (Logs)
      local log_target_labels=(
        "1. 🤖 A3 主应用 (a3-app)         	- 核心会话治理/防抖聚合/仲裁日志"
        "2. 🚪 专属网关 (a3-gateway)      	- 注册发现与动态配置中心日志"
        "3. 💬 会话存档 (a3-finance)      	- 外部群全量无感感知 Worker 日志"
        "4. 📋 查看全部容器最近 10 行简报 	- 综合速查"
      )
      menu_single_select "请选择需要追踪哪个容器的实时日志 (回车确认):" 0 log_target_labels
      case "$SELECTED_SINGLE_INDEX" in
        0) TARGET="a3" ;;
        1) TARGET="gateway" ;;
        2) TARGET="finance" ;;
        3) TARGET="all" ;;
      esac
      if [[ -n "${REMOTE_HOST:-}" ]]; then
        ACTION="remote-logs"
      else
        ACTION="logs"
      fi
      check_prerequisites_and_run
      exit 0
      ;;
    3)
      # 重启服务 (Restart)
      TARGET="all"
      if [[ -n "${REMOTE_HOST:-}" ]]; then
        ACTION="remote-restart"
      else
        ACTION="restart"
      fi
      check_prerequisites_and_run
      exit 0
      ;;
    4)
      # 停止服务 (Stop)
      TARGET="all"
      if [[ -n "${REMOTE_HOST:-}" ]]; then
        ACTION="remote-stop"
      else
        ACTION="stop"
      fi
      check_prerequisites_and_run
      exit 0
      ;;
    5)
      # 清理网络 (Clean)
      TARGET="all"
      ACTION="clean"
      check_prerequisites_and_run
      exit 0
      ;;
    6)
      # 重新开始
      exec "$0"
      ;;
  esac

  # ----------------------------------------------------------------------------
  # 【第三级：部署的应用组件 (多选，空格+Tab对齐)】
  # ----------------------------------------------------------------------------
  local comp_checked=(1 1 1 1)
  local comp_labels=(
    "1. 🚪 专属微服务网关 (Gateway)   	- 服务注册发现与配置中心 (:3003)"
    "2. 🧠 Agent 核心服务 (Core)      	- 封组后的理解与组织回复 (:3001)"
    "3. 🤖 A3 主应用核心后端 (A3 App) 	- 会话治理/防抖聚合/抢话筒仲裁 (:3002)"
    "4. 💬 企微会话存档服务 (Finance)  	- 外部群全量无感感知 Worker (后台守护)"
  )

  menu_multi_select "请选择需要部署的应用组件 (空格键多选/取消，回车确认启动):" comp_checked comp_labels

  # 映射选中的组件
  local sel_gw=${comp_checked[0]}
  local sel_core=${comp_checked[1]}
  local sel_a3=${comp_checked[2]}
  local sel_fin=${comp_checked[3]}
  local sel_sum=$((sel_gw + sel_core + sel_a3 + sel_fin))

  if [[ $sel_sum -eq 4 ]]; then
    TARGET="all"
  elif [[ $sel_sum -eq 1 && $sel_gw -eq 1 ]]; then
    TARGET="gateway"
  elif [[ $sel_sum -eq 1 && $sel_core -eq 1 ]]; then
    TARGET="core"
  elif [[ $sel_sum -eq 1 && $sel_a3 -eq 1 ]]; then
    TARGET="a3"
  elif [[ $sel_sum -eq 1 && $sel_fin -eq 1 ]]; then
    TARGET="finance"
  else
    # 组合部分，如选中了 gateway、core 和 a3
    TARGET="custom_${sel_gw}_${sel_core}_${sel_a3}_${sel_fin}"
  fi

  echo -e "\033[1;32m✔\033[0m 已选定微服务组件，即将启动部署流程...\n"

  if [[ -n "${REMOTE_HOST:-}" ]]; then
    ACTION="remote"
  else
    ACTION="deploy"
  fi

  check_prerequisites_and_run
}

# ==============================================================================
# CLI 命令参数与底层部署逻辑
# ==============================================================================

show_help() {
  cat << EOF
a3 体系 (主应用 + 网关 + 核心服务 + 会话存档) 单宿主机 Docker 整合部署管理脚本

用法:
  交互式运行: ./deploy.sh
  命令行运行: ./scripts/deploy.sh [action] [env] [target]
  远程命令行: ./scripts/deploy.sh remote* <host> [env] [target]

可用操作 (action):
  【本地操作】
  deploy         (默认) 构建镜像、按依赖拓扑顺序部署并进行健康检查
  build          仅执行 Docker 镜像构建
  start          启动已有容器
  stop           优雅停止并移除容器 (逆序关停)
  restart        重启指定或全部容器
  status         查看各容器运行状态与健康探针信息
  logs           追踪指定容器实时日志
  clean          停止容器并清理专属 Docker 桥接网络
  help           显示此帮助信息

  【远程主机操作 (例如部署到 1.1.1.1)】
  remote         一键同步源码与配置至远程宿主机，并执行远端拓扑部署与状态检查
  remote-status  查看远程宿主机上的 A3 容器集群与健康探针状态
  remote-logs    流式追踪远程宿主机上指定容器的实时日志
  remote-stop    远程停止并移除远端宿主机上的 A3 容器集群
  remote-restart 远程重启远端宿主机上的 A3 容器集群

可用环境 (env):
  local          (默认) 本地开发环境 (自动对接宿主机 host.docker.internal)
  test           测试环境 (使用各模块 .env.test 配置)
  prod           生产环境 (使用各模块 .env.prod 配置)

可用目标 (target):
  all            (默认) 全量四个容器 (Gateway -> Core -> A3 -> Finance)
  gateway        仅针对专属网关 (sidecar/gateway)
  core           仅针对 Agent 核心服务 (../crm-ai-agent，理解与组织回复)
  a3             仅针对 a3 主应用 (ai-agent-application)
  finance        仅针对会话存档 (sidecar/wecom-finance)

远程控制环境变量:
  REMOTE_USER    远程登录用户 (默认: root)
  REMOTE_PORT    远程 SSH 端口 (默认: 22)
  REMOTE_DIR     远程部署目标路径 (默认: /opt/ai-agent-application)
  SSH_KEY        自定义 SSH 私钥路径 (可选，例如: ~/.ssh/id_rsa)
  SKIP_SYNC      跳过 rsync 代码同步 (true/false, 默认: false)
  SKIP_MIGRATE   跳过数据库表结构迁移 (true/false, 默认: false)

常用命令示例:
  # 1. 启动交互式引导 (推荐)
  ./deploy.sh

  # 2. 本地快速批处理部署
  ./scripts/deploy.sh deploy local              # 本地部署所有 3 个容器
  ./scripts/deploy.sh status local              # 查看本地 3 个容器状态与探针
  ./scripts/deploy.sh logs local a3             # 查看本地 A3 容器日志

  # 3. 远程主机批处理部署 (例如 1.1.1.1)
  ./scripts/deploy.sh remote 1.1.1.1 prod       # 一键增量同步并在 1.1.1.1 部署全套服务
  ./scripts/deploy.sh remote 1.1.1.1 prod a3    # 仅向 1.1.1.1 更新并重新部署 A3 主应用
  ./scripts/deploy.sh remote-status 1.1.1.1 prod# 在本地远程查看 1.1.1.1 容器集群状态
  ./scripts/deploy.sh remote-logs 1.1.1.1 prod a3 # 在本地追踪 1.1.1.1 的 A3 实时日志

EOF
}

# 解析命令行参数
parse_args() {
  local positional=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      help|-h|--help)
        show_help
        exit 0
        ;;
      deploy|build|start|stop|restart|status|logs|clean)
        ACTION="$1"
        shift
        ;;
      remote|remote-status|remote-logs|remote-stop|remote-restart)
        ACTION="$1"
        shift
        ;;
      local|test|prod)
        ENV="$1"
        shift
        ;;
      all|gateway|core|a3|finance)
        TARGET="$1"
        shift
        ;;
      *)
        positional+=("$1")
        shift
        ;;
    esac
  done

  # 如果是远程操作，首个位置参数为 REMOTE_HOST
  if [[ "$ACTION" =~ ^remote ]]; then
    if [[ ${#positional[@]} -ge 1 ]]; then
      REMOTE_HOST="${positional[0]}"
    fi
    if [[ ${#positional[@]} -ge 2 ]]; then
      ENV="${positional[1]}"
    fi
    if [[ ${#positional[@]} -ge 3 ]]; then
      TARGET="${positional[2]}"
    fi
  else
    # 兼容普通位置参数传入
    if [[ ${#positional[@]} -ge 1 && -z "${ACTION:-}" ]]; then
      ACTION="${positional[0]}"
    fi
    if [[ ${#positional[@]} -ge 2 ]]; then
      ENV="${positional[1]}"
    fi
    if [[ ${#positional[@]} -ge 3 ]]; then
      TARGET="${positional[2]}"
    fi
  fi
}

check_prerequisites() {
  if ! command -v docker &>/dev/null; then
    error "未检测到 docker 命令，请先安装 Docker。"
    exit 1
  fi
  if ! docker info &>/dev/null; then
    error "Docker 服务未运行或当前用户无权限访问 Docker Daemon。"
    exit 1
  fi
}

setup_vars() {
  NETWORK="a3-net-${ENV}"

  # 专属网关配置
  GW_IMAGE="a3-gateway:${ENV}"
  GW_CONTAINER="a3-gateway-${ENV}"
  GW_PORT=3003
  GW_HEALTH_URL="http://127.0.0.1:${GW_PORT}/health"

  # A3 主应用配置
  A3_IMAGE="ai-agent-application:${ENV}"
  A3_CONTAINER="a3-app-${ENV}"
  A3_PORT=3002
  A3_HEALTH_URL="http://127.0.0.1:${A3_PORT}/health"

  # 企微会话存档配置
  FIN_IMAGE="wecom-finance-sidecar:${ENV}"
  FIN_CONTAINER="a3-finance-${ENV}"

  # Agent 核心服务配置（只监听本机，不对外）
  CORE_IMAGE="crm-ai-agent:${ENV}"
  CORE_CONTAINER="a3-core-${ENV}"
  CORE_PORT=3001
  CORE_HEALTH_URL="http://127.0.0.1:${CORE_PORT}/health"
}

# 按约定顺序找组件的 env 文件：.env.${ENV}.local > .env.local > .env.${ENV} > .env（找不到输出空）
pick_env_file() {
  local dir="$1" f
  for f in "${dir}/.env.${ENV}.local" "${dir}/.env.local" "${dir}/.env.${ENV}" "${dir}/.env"; do
    if [[ -f "$f" ]]; then
      echo "$f"
      return 0
    fi
  done
  return 0
}

# env 文件里是否显式配置了某个键（值非空）。配置了就以 env 文件为准，脚本不再用 -e 传默认值
# （docker run 的 -e 优先级高于 --env-file，传了默认值会把 env 文件里的值盖掉）
env_file_has() {
  local file="$1" key="$2"
  [[ -n "$file" && -f "$file" ]] && grep -Eq "^[[:space:]]*${key}=[^[:space:]]" "$file"
}

# 读 env 文件里某个键的值（去掉引号），只用于比较，不打印
env_file_get() {
  local file="$1" key="$2"
  [[ -n "$file" && -f "$file" ]] || return 0
  grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 | cut -d= -f2- | sed -e 's/^[\"'\'']//' -e 's/[\"'\'']$//'
}

# 核心服务与 A3 主应用必须连同一个 Redis 的同一个库（封组 / 回复队列在里面交接），不一致直接停止部署
check_same_redis() {
  local a3_file core_file a3_url core_url
  a3_file="$(pick_env_file "$A3_DIR")"
  core_file="$(pick_env_file "$CORE_DIR")"
  a3_url="$(env_file_get "$a3_file" REDIS_URL)"
  core_url="$(env_file_get "$core_file" REDIS_URL)"
  if [[ -n "$a3_url" && -n "$core_url" && "$a3_url" != "$core_url" ]]; then
    error "核心服务与 A3 主应用的 REDIS_URL 不一致（${core_file} / ${a3_file}）：两边必须连同一个 Redis 的同一个库，否则机器人收到消息后永远不会回复。"
    exit 1
  fi
  if [[ -n "$a3_url" && -z "$core_url" ]] || [[ -z "$a3_url" && -n "$core_url" ]]; then
    warn "只有一边的 env 文件配了 REDIS_URL（核心服务: ${core_file:-无} / A3: ${a3_file:-无}），请确认两边连的是同一个 Redis 的同一个库。"
  fi
}

ensure_network() {
  if ! docker network inspect "$NETWORK" &>/dev/null; then
    info "创建专属 Docker 桥接网络: ${NETWORK}..."
    docker network create "$NETWORK"
    succ "网络创建成功: ${NETWORK}"
  fi
}

build_image_gateway() {
  info "正在构建专属网关镜像 [${GW_IMAGE}]..."
  (cd "$GW_DIR" && docker build -t "$GW_IMAGE" -f Dockerfile .)
  succ "网关镜像构建完成: ${GW_IMAGE}"
}

build_image_a3() {
  info "正在构建 A3 主应用镜像 [${A3_IMAGE}]..."
  (cd "$A3_DIR" && docker build -t "$A3_IMAGE" -f Dockerfile .)
  succ "A3 主应用镜像构建完成: ${A3_IMAGE}"
}

build_image_core() {
  if [[ ! -f "${CORE_DIR}/Dockerfile" ]]; then
    error "找不到 Agent 核心服务代码：${CORE_DIR}（crm-ai-agent 需与本仓库放在同一目录下，或用 CORE_DIR 指定路径）"
    exit 1
  fi
  info "正在构建 Agent 核心服务镜像 [${CORE_IMAGE}]..."
  (cd "$CORE_DIR" && docker build -t "$CORE_IMAGE" -f Dockerfile .)
  succ "核心服务镜像构建完成: ${CORE_IMAGE}"
}

build_image_finance() {
  info "正在构建企微会话存档镜像 [${FIN_IMAGE}]..."
  (cd "$FIN_DIR" && docker build -t "$FIN_IMAGE" -f Dockerfile .)
  succ "会话存档镜像构建完成: ${FIN_IMAGE}"
}

build_targets() {
  divider
  case "$TARGET" in
    gateway)
      build_image_gateway
      ;;
    core)
      build_image_core
      ;;
    a3)
      build_image_a3
      ;;
    finance)
      build_image_finance
      ;;
    all)
      build_image_gateway
      build_image_core
      build_image_a3
      build_image_finance
      ;;
    *)
      error "未知目标: $TARGET"
      exit 1
      ;;
  esac
  divider
}

stop_single_container() {
  local container="$1"
  if docker ps -a --format '{{.Names}}' | grep -Eq "^${container}\$"; then
    info "正在停止并清理容器: ${container}..."
    docker stop "$container" 2>/dev/null || true
    docker rm -f "$container" 2>/dev/null || true
  fi
}

wait_for_health() {
  local url="$1"
  local name="$2"
  local max_wait="${3:-30}"
  local count=0

  info "等待 [${name}] 服务就绪探针: ${url} (最大等待 ${max_wait}s)..."
  while [[ $count -lt $max_wait ]]; do
    if curl -s -f -o /dev/null "$url"; then
      succ "✅ [${name}] 服务健康探针检测通过！"
      return 0
    fi
    sleep 1
    count=$((count + 1))
    echo -n "."
  done
  echo ""
  warn "⚠️  [${name}] 在 ${max_wait}s 内未响应健康状态，建议查看日志排查: ./deploy.sh logs ${ENV} $(echo "$name" | tr '[:upper:]' '[:lower:]')"
  return 1
}

wait_for_container_running() {
  local container="$1"
  local name="$2"
  local max_wait="${3:-15}"
  local count=0

  info "检查 [${name}] 容器运行状态 (最大等待 ${max_wait}s)..."
  while [[ $count -lt $max_wait ]]; do
    local status
    status="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || echo 'missing')"
    if [[ "$status" == "running" ]]; then
      succ "✅ [${name}] 容器运行正常 (Status: running)"
      return 0
    fi
    sleep 1
    count=$((count + 1))
    echo -n "."
  done
  echo ""
  warn "⚠️  [${name}] 容器状态异常: ${status}"
  return 1
}

bridge_middleware_network() {
  local container="$1"
  local middleware_net=""
  if docker network inspect "agent-platform_default" &>/dev/null; then
    middleware_net="agent-platform_default"
  elif docker network inspect "deploy_default" &>/dev/null; then
    middleware_net="deploy_default"
  fi

  if [[ -n "$middleware_net" ]]; then
    if ! docker inspect "$container" --format '{{range $net, $v := .NetworkSettings.Networks}}{{$net}} {{end}}' 2>/dev/null | grep -qw "$middleware_net"; then
      info "将容器 [${container}] 智能桥接至中间件网络 [${middleware_net}]..."
      docker network connect "$middleware_net" "$container" 2>/dev/null || true
    fi
  fi
}

deploy_gateway() {
  info "==> 开始部署专属网关: ${GW_CONTAINER} (端口: ${GW_PORT})"
  build_image_gateway
  stop_single_container "$GW_CONTAINER"

  local env_opts=()
  if [[ -f "${GW_DIR}/.env.${ENV}.local" ]]; then
    env_opts+=("--env-file" "${GW_DIR}/.env.${ENV}.local")
  elif [[ -f "${GW_DIR}/.env.local" ]]; then
    env_opts+=("--env-file" "${GW_DIR}/.env.local")
  elif [[ -f "${GW_DIR}/.env.${ENV}" ]]; then
    env_opts+=("--env-file" "${GW_DIR}/.env.${ENV}")
  elif [[ -f "${GW_DIR}/.env" ]]; then
    env_opts+=("--env-file" "${GW_DIR}/.env")
  fi

  local redis_host="redis"
  if [[ "$ENV" == "local" ]] && ! docker network inspect "agent-platform_default" &>/dev/null; then
    redis_host="host.docker.internal"
  fi

  docker run -d \
    --name "$GW_CONTAINER" \
    --network "$NETWORK" \
    --network-alias a3-gateway \
    --restart unless-stopped \
    -p "127.0.0.1:${GW_PORT}:3003" \
    --add-host=host.docker.internal:host-gateway \
    -e "NODE_ENV=${ENV}" \
    -e "PORT=3003" \
    -e "REDIS_HOST=${redis_host}" \
    "${env_opts[@]}" \
    "$GW_IMAGE"

  bridge_middleware_network "$GW_CONTAINER"
  wait_for_health "$GW_HEALTH_URL" "Gateway" 30 || true
}

deploy_core() {
  info "==> 开始部署 Agent 核心服务: ${CORE_CONTAINER} (端口: ${CORE_PORT}，只监听本机)"
  build_image_core
  check_same_redis
  stop_single_container "$CORE_CONTAINER"
  ensure_media_dir

  local core_env_file
  core_env_file="$(pick_env_file "$CORE_DIR")"
  local env_opts=()
  if [[ -n "$core_env_file" ]]; then
    env_opts+=("--env-file" "$core_env_file")
  fi

  # 中间件默认地址（env 文件里配了就以 env 文件为准）：有 agent-platform 中间件网络时用容器名，否则用宿主机
  local mw_host="mysql" redis_host="redis" qdrant_host="qdrant"
  if ! docker network inspect "agent-platform_default" &>/dev/null; then
    mw_host="host.docker.internal"
    redis_host="host.docker.internal"
    qdrant_host="host.docker.internal"
  fi
  local mw_opts=()
  env_file_has "$core_env_file" MYSQL_URL || mw_opts+=("-e" "MYSQL_URL=mysql://agent:agent_pw@${mw_host}:3306/agent_platform")
  env_file_has "$core_env_file" REDIS_URL || mw_opts+=("-e" "REDIS_URL=redis://${redis_host}:6379")
  env_file_has "$core_env_file" QDRANT_URL || mw_opts+=("-e" "QDRANT_URL=http://${qdrant_host}:6333")
  env_file_has "$core_env_file" GATEWAY_URL || mw_opts+=("-e" "GATEWAY_URL=http://a3-gateway:3003")

  # 封组后的理解与回复固定走队列；临时直通模式已停用（RabbitMQ 不再需要）
  docker run -d \
    --name "$CORE_CONTAINER" \
    --network "$NETWORK" \
    --network-alias a3-core \
    --restart unless-stopped \
    -p "127.0.0.1:${CORE_PORT}:3001" \
    --add-host=host.docker.internal:host-gateway \
    -e "NODE_ENV=${ENV}" \
    -e "PORT=3001" \
    -e "TURN_QUEUE_ENABLED=true" \
    -e "PIPELINE_DIRECT=false" \
    -e "MEDIA_DIR=/data/media" \
    -v "${MEDIA_HOST_DIR}:/data/media:ro" \
    "${mw_opts[@]}" \
    "${env_opts[@]}" \
    "$CORE_IMAGE"

  bridge_middleware_network "$CORE_CONTAINER"
  wait_for_health "$CORE_HEALTH_URL" "Core" 40 || true
}

deploy_a3() {
  info "==> 开始部署 A3 主应用: ${A3_CONTAINER} (端口: ${A3_PORT})"
  build_image_a3
  stop_single_container "$A3_CONTAINER"
  ensure_media_dir

  local env_opts=()
  if [[ -f "${A3_DIR}/.env.${ENV}.local" ]]; then
    env_opts+=("--env-file" "${A3_DIR}/.env.${ENV}.local")
  elif [[ -f "${A3_DIR}/.env.local" ]]; then
    env_opts+=("--env-file" "${A3_DIR}/.env.local")
  elif [[ -f "${A3_DIR}/.env.${ENV}" ]]; then
    env_opts+=("--env-file" "${A3_DIR}/.env.${ENV}")
  elif [[ -f "${A3_DIR}/.env" ]]; then
    env_opts+=("--env-file" "${A3_DIR}/.env")
  fi

  local has_agent_platform=false
  if docker network inspect "agent-platform_default" &>/dev/null; then
    has_agent_platform=true
  fi

  # 默认中间件参数推断
  local default_mysql_url="mysql://agent:agent_pw@mysql:3306/agent_platform"
  local default_redis_url="redis://redis:6379"
  local default_redis_host="redis"

  if [[ "$has_agent_platform" != "true" ]]; then
    default_mysql_url="mysql://agent:agent_pw@host.docker.internal:3306/agent_platform"
    default_redis_url="redis://host.docker.internal:6379"
    default_redis_host="host.docker.internal"
  fi

  # env 文件里配了数据库 / Redis 就以它为准（-e 会盖掉 --env-file 的同名值）
  local a3_env_file
  a3_env_file="$(pick_env_file "$A3_DIR")"
  local mysql_opts=() redis_opts=()
  env_file_has "$a3_env_file" MYSQL_URL || mysql_opts+=("-e" "MYSQL_URL=${default_mysql_url}")
  if ! env_file_has "$a3_env_file" REDIS_URL && ! env_file_has "$a3_env_file" REDIS_HOST; then
    redis_opts+=("-e" "REDIS_URL=${default_redis_url}" "-e" "REDIS_HOST=${default_redis_host}")
  fi

  if [[ "$SKIP_MIGRATE" != "true" ]]; then
    info "检测数据库表结构，执行容器化自动迁移..."
    local migrate_net="$NETWORK"
    if [[ "$has_agent_platform" == "true" ]]; then
      migrate_net="agent-platform_default"
    fi

    docker run --rm \
      --network "$migrate_net" \
      --add-host=host.docker.internal:host-gateway \
      "${env_opts[@]}" \
      "${mysql_opts[@]}" \
      "$A3_IMAGE" node dist/database/migrate.js 2>&1 || warn "数据库迁移跳过或连接失败，继续执行应用部署..."
  fi

  docker run -d \
    --name "$A3_CONTAINER" \
    --network "$NETWORK" \
    --network-alias a3-app \
    --restart unless-stopped \
    -p "127.0.0.1:${A3_PORT}:3002" \
    --add-host=host.docker.internal:host-gateway \
    -e "NODE_ENV=${ENV}" \
    -e "PORT=3002" \
    -e "GATEWAY_ENABLED=true" \
    -e "GATEWAY_URL=http://a3-gateway:3003" \
    -e "MEDIA_DIR=/data/media" \
    -v "${MEDIA_HOST_DIR}:/data/media" \
    "${mysql_opts[@]}" \
    "${redis_opts[@]}" \
    "${env_opts[@]}" \
    "$A3_IMAGE"

  bridge_middleware_network "$A3_CONTAINER"
  wait_for_health "$A3_HEALTH_URL" "A3-App" 40 || true
}

deploy_finance() {
  info "==> 开始部署企微会话存档 Sidecar: ${FIN_CONTAINER}"
  build_image_finance
  stop_single_container "$FIN_CONTAINER"

  mkdir -p "${FIN_DIR}/data" "${FIN_DIR}/keys" "${FIN_DIR}/lib"
  ensure_media_dir

  local env_opts=()
  if [[ -f "${FIN_DIR}/.env.${ENV}" ]]; then
    env_opts+=("--env-file" "${FIN_DIR}/.env.${ENV}")
  elif [[ -f "${FIN_DIR}/.env" ]]; then
    env_opts+=("--env-file" "${FIN_DIR}/.env")
  fi

  docker run -d \
    --name "$FIN_CONTAINER" \
    --network "$NETWORK" \
    --network-alias a3-finance \
    --restart unless-stopped \
    --add-host=host.docker.internal:host-gateway \
    -e "NODE_ENV=${ENV}" \
    -e "GATEWAY_ENABLED=true" \
    -e "GATEWAY_URL=http://a3-gateway:3003" \
    -e "A3_WEBHOOK_URL=http://a3-app:3002/api/admin/wecom/finance-inbound" \
    -e "MEDIA_DIR=/data/media" \
    -v "${FIN_DIR}/data:/app/data" \
    -v "${FIN_DIR}/keys:/app/keys" \
    -v "${FIN_DIR}/lib:/app/lib" \
    -v "${MEDIA_HOST_DIR}:/data/media" \
    "${env_opts[@]}" \
    "$FIN_IMAGE"

  wait_for_container_running "$FIN_CONTAINER" "Finance" 15 || true
}

execute_deploy() {
  ensure_network
  divider
  case "$TARGET" in
    gateway)
      deploy_gateway
      ;;
    core)
      deploy_core
      ;;
    a3)
      deploy_a3
      ;;
    finance)
      deploy_finance
      ;;
    all)
      info "🚀 开始按依赖拓扑顺序部署 A3 全量套件 (网关 -> 核心服务 -> 主应用 -> 会话存档)..."
      deploy_gateway
      deploy_core
      deploy_a3
      deploy_finance
      succ "🎉 A3 全量微服务已部署完成！"
      ;;
    custom_*)
      info "🚀 按依赖拓扑启动已勾选组件..."
      # 解析 custom_gw_core_a3_fin
      local flags="${TARGET#custom_}"
      local gw_flag="${flags:0:1}"
      local core_flag="${flags:2:1}"
      local a3_flag="${flags:4:1}"
      local fin_flag="${flags:6:1}"

      if [[ "$gw_flag" -eq 1 ]]; then deploy_gateway; fi
      if [[ "$core_flag" -eq 1 ]]; then deploy_core; fi
      if [[ "$a3_flag" -eq 1 ]]; then deploy_a3; fi
      if [[ "$fin_flag" -eq 1 ]]; then deploy_finance; fi
      succ "🎉 目标微服务已部署完成！"
      ;;
    *)
      error "未知部署目标: $TARGET"
      exit 1
      ;;
  esac
  divider
  show_status
}

show_status() {
  info "================== A3 容器集群状态 [${ENV}] =================="
  info "专属网络: ${NETWORK}"
  docker network inspect "$NETWORK" --format '{{range .Containers}}{{.Name}} ({{.IPv4Address}}) {{end}}' 2>/dev/null || echo "网络未创建"
  echo ""

  info "容器运行列表:"
  docker ps -a --filter "name=^(${GW_CONTAINER}|${CORE_CONTAINER}|${A3_CONTAINER}|${FIN_CONTAINER})$" \
    --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}"

  echo ""
  info "服务健康探针检测:"
  local gw_status
  gw_status="$(curl -s -o /dev/null -w "%{http_code}" "$GW_HEALTH_URL" 2>/dev/null || echo "CONN_FAIL")"
  if [[ "$gw_status" == "200" ]]; then
    succ "  • 专属网关 (Gateway:3003):  UP (HTTP 200) -> ${GW_HEALTH_URL}"
  else
    warn "  • 专属网关 (Gateway:3003):  DOWN/UNAVAILABLE (${gw_status}) -> ${GW_HEALTH_URL}"
  fi

  local core_status
  core_status="$(curl -s -o /dev/null -w "%{http_code}" "$CORE_HEALTH_URL" 2>/dev/null || echo "CONN_FAIL")"
  if [[ "$core_status" == "200" ]]; then
    succ "  • 核心服务 (Core:3001):      UP (HTTP 200) -> ${CORE_HEALTH_URL}"
  else
    warn "  • 核心服务 (Core:3001):      DOWN/UNAVAILABLE (${core_status}) -> ${CORE_HEALTH_URL}"
  fi

  local a3_status
  a3_status="$(curl -s -o /dev/null -w "%{http_code}" "$A3_HEALTH_URL" 2>/dev/null || echo "CONN_FAIL")"
  if [[ "$a3_status" == "200" ]]; then
    succ "  • A3 主服务 (A3-App:3002):   UP (HTTP 200) -> ${A3_HEALTH_URL}"
  else
    warn "  • A3 主服务 (A3-App:3002):   DOWN/UNAVAILABLE (${a3_status}) -> ${A3_HEALTH_URL}"
  fi

  local fin_state
  fin_state="$(docker inspect --format '{{.State.Status}}' "$FIN_CONTAINER" 2>/dev/null || echo 'NOT_FOUND')"
  if [[ "$fin_state" == "running" ]]; then
    succ "  • 会话存档 (Finance Worker): UP (Docker: running)"
  else
    warn "  • 会话存档 (Finance Worker): ${fin_state}"
  fi
  info "============================================================"
}

stop_containers() {
  divider
  case "$TARGET" in
    gateway)
      stop_single_container "$GW_CONTAINER"
      ;;
    core)
      stop_single_container "$CORE_CONTAINER"
      ;;
    a3)
      stop_single_container "$A3_CONTAINER"
      ;;
    finance)
      stop_single_container "$FIN_CONTAINER"
      ;;
    all|*)
      info "🛑 正在按逆序关停容器 (Finance -> A3 -> Core -> Gateway)..."
      stop_single_container "$FIN_CONTAINER"
      stop_single_container "$A3_CONTAINER"
      stop_single_container "$CORE_CONTAINER"
      stop_single_container "$GW_CONTAINER"
      succ "所有目标容器已停止并清理。"
      ;;
  esac
  divider
}

restart_containers() {
  divider
  case "$TARGET" in
    gateway)
      info "重启网关容器: ${GW_CONTAINER}..."
      docker restart "$GW_CONTAINER"
      wait_for_health "$GW_HEALTH_URL" "Gateway" 30 || true
      ;;
    core)
      info "重启核心服务容器: ${CORE_CONTAINER}..."
      docker restart "$CORE_CONTAINER"
      wait_for_health "$CORE_HEALTH_URL" "Core" 30 || true
      ;;
    a3)
      info "重启 A3 容器: ${A3_CONTAINER}..."
      docker restart "$A3_CONTAINER"
      wait_for_health "$A3_HEALTH_URL" "A3-App" 30 || true
      ;;
    finance)
      info "重启会话存档容器: ${FIN_CONTAINER}..."
      docker restart "$FIN_CONTAINER"
      wait_for_container_running "$FIN_CONTAINER" "Finance" 15 || true
      ;;
    all|*)
      info "🔄 重启全量容器 (Gateway -> Core -> A3 -> Finance)..."
      docker restart "$GW_CONTAINER" 2>/dev/null || true
      wait_for_health "$GW_HEALTH_URL" "Gateway" 20 || true
      docker restart "$CORE_CONTAINER" 2>/dev/null || true
      wait_for_health "$CORE_HEALTH_URL" "Core" 20 || true
      docker restart "$A3_CONTAINER" 2>/dev/null || true
      wait_for_health "$A3_HEALTH_URL" "A3-App" 20 || true
      docker restart "$FIN_CONTAINER" 2>/dev/null || true
      succ "全量容器重启完成！"
      ;;
  esac
  divider
  show_status
}

show_logs() {
  case "$TARGET" in
    gateway)
      info "追踪网关实时日志 (${GW_CONTAINER})..."
      docker logs -f "$GW_CONTAINER"
      ;;
    core)
      info "追踪核心服务实时日志 (${CORE_CONTAINER})..."
      docker logs -f "$CORE_CONTAINER"
      ;;
    a3)
      info "追踪 A3 主服务实时日志 (${A3_CONTAINER})..."
      docker logs -f "$A3_CONTAINER"
      ;;
    finance)
      info "追踪会话存档实时日志 (${FIN_CONTAINER})..."
      docker logs -f "$FIN_CONTAINER"
      ;;
    all|*)
      info "最近 10 行容器简报:"
      divider
      echo -e "\033[1m--- Gateway 最近日志 ---\033[0m"
      docker logs --tail 10 "$GW_CONTAINER" 2>&1 || true
      echo -e "\033[1m--- Core 最近日志 ---\033[0m"
      docker logs --tail 10 "$CORE_CONTAINER" 2>&1 || true
      echo -e "\033[1m--- A3 最近日志 ---\033[0m"
      docker logs --tail 10 "$A3_CONTAINER" 2>&1 || true
      echo -e "\033[1m--- Finance 最近日志 ---\033[0m"
      docker logs --tail 10 "$FIN_CONTAINER" 2>&1 || true
      divider
      ;;
  esac
}

clean_all() {
  stop_containers
  if docker network inspect "$NETWORK" &>/dev/null; then
    info "清理专属网络: ${NETWORK}..."
    docker network rm "$NETWORK" 2>/dev/null || true
    succ "网络清理完成: ${NETWORK}"
  fi
}

start_containers() {
  ensure_network
  case "$TARGET" in
    gateway)
      docker start "$GW_CONTAINER"
      wait_for_health "$GW_HEALTH_URL" "Gateway" 20 || true
      ;;
    core)
      docker start "$CORE_CONTAINER"
      wait_for_health "$CORE_HEALTH_URL" "Core" 20 || true
      ;;
    a3)
      docker start "$A3_CONTAINER"
      wait_for_health "$A3_HEALTH_URL" "A3-App" 20 || true
      ;;
    finance)
      docker start "$FIN_CONTAINER"
      wait_for_container_running "$FIN_CONTAINER" "Finance" 15 || true
      ;;
    all|*)
      info "启动所有已存在容器..."
      docker start "$GW_CONTAINER" 2>/dev/null || true
      wait_for_health "$GW_HEALTH_URL" "Gateway" 20 || true
      docker start "$CORE_CONTAINER" 2>/dev/null || true
      wait_for_health "$CORE_HEALTH_URL" "Core" 20 || true
      docker start "$A3_CONTAINER" 2>/dev/null || true
      wait_for_health "$A3_HEALTH_URL" "A3-App" 20 || true
      docker start "$FIN_CONTAINER" 2>/dev/null || true
      succ "全量容器启动完成！"
      ;;
  esac
  show_status
}

# ==============================================================================
# 远程宿主机自动化执行
# ==============================================================================

get_ssh_opts() {
  local opts=(-p "${REMOTE_PORT}" -o "StrictHostKeyChecking=no" -o "ConnectTimeout=10")
  if [[ -n "${SSH_KEY}" ]]; then
    opts+=(-i "${SSH_KEY}")
  fi
  echo "${opts[@]}"
}

run_remote_cmd() {
  local ssh_opts
  # shellcheck disable=SC2207
  ssh_opts=($(get_ssh_opts))
  ssh "${ssh_opts[@]}" "${REMOTE_USER}@${REMOTE_HOST}" "$@"
}

run_remote_tty() {
  local ssh_opts
  # shellcheck disable=SC2207
  ssh_opts=($(get_ssh_opts))
  ssh -t "${ssh_opts[@]}" "${REMOTE_USER}@${REMOTE_HOST}" "$@"
}

check_remote_env() {
  if [[ -z "${REMOTE_HOST:-}" ]]; then
    error "未指定远程目标主机！"
    exit 1
  fi

  info "正在检测与远程宿主机 [${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PORT}] 的 SSH 连通性..."
  if ! run_remote_cmd "echo SSH_OK" &>/dev/null; then
    error "无法连接到远程主机 ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PORT}，请检查网络、端口及 SSH 密钥配置。"
    exit 1
  fi
  succ "SSH 连接成功！"

  info "正在检测远程宿主机 Docker 运行时环境..."
  if ! run_remote_cmd "command -v docker &>/dev/null && docker info &>/dev/null"; then
    error "远程主机 ${REMOTE_HOST} 未安装 Docker 或 Docker Daemon 未启动！请先在远端安装并启动 Docker。"
    exit 1
  fi
  succ "远程宿主机 Docker 运行正常。"
}

sync_to_remote() {
  if [[ "$SKIP_SYNC" == "true" ]]; then
    warn "已配置 SKIP_SYNC=true，跳过代码同步步骤。"
    return 0
  fi

  if ! command -v rsync &>/dev/null; then
    error "本地缺少 rsync 工具，请先安装: sudo apt-get install rsync 或 brew install rsync"
    exit 1
  fi

  info "准备远程部署目标目录: ${REMOTE_DIR}..."
  run_remote_cmd "mkdir -p '${REMOTE_DIR}'"

  info "正在向远程主机 [${REMOTE_HOST}] 执行极速增量代码同步 (rsync)..."

  local rsync_ssh_arg="ssh -p ${REMOTE_PORT} -o StrictHostKeyChecking=no"
  if [[ -n "${SSH_KEY}" ]]; then
    rsync_ssh_arg="ssh -p ${REMOTE_PORT} -i ${SSH_KEY} -o StrictHostKeyChecking=no"
  fi

  rsync -avz --delete \
    -e "$rsync_ssh_arg" \
    --exclude 'node_modules' \
    --exclude '*/node_modules' \
    --exclude '.git' \
    --exclude 'dist' \
    --exclude '*/dist' \
    --exclude '*.log' \
    --exclude '.DS_Store' \
    --exclude '.env.local' \
    --exclude '.env.dev' \
    --exclude 'sidecar/wecom-finance/data/*.cursor' \
    "${ROOT_DIR}/" \
    "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"

  # Agent 核心服务代码同步到远端同级目录（远端脚本按 ../crm-ai-agent 找它）
  if [[ -d "$CORE_DIR" ]]; then
    local remote_core_dir
    remote_core_dir="$(dirname "${REMOTE_DIR}")/crm-ai-agent"
    info "正在同步 Agent 核心服务代码至 ${remote_core_dir}..."
    run_remote_cmd "mkdir -p '${remote_core_dir}'"
    rsync -avz --delete \
      -e "$rsync_ssh_arg" \
      --exclude 'node_modules' \
      --exclude '.git' \
      --exclude 'dist' \
      --exclude '*.log' \
      --exclude '.env.local' \
      --exclude 'deploy/.env' \
      "${CORE_DIR}/" \
      "${REMOTE_USER}@${REMOTE_HOST}:${remote_core_dir}/"
  else
    warn "本地没有核心服务代码目录 ${CORE_DIR}，跳过同步（远端若无核心服务，机器人不会回复）"
  fi

  succ "增量同步完成！"
  run_remote_cmd "chmod +x '${REMOTE_DIR}/scripts/'*.sh '${REMOTE_DIR}/'*.sh 2>/dev/null || true"
}

execute_remote_deploy() {
  divider
  info "🚀 开始对远程主机 [${REMOTE_HOST}] 执行全自动整合部署流水线..."
  check_remote_env
  sync_to_remote

  info "在远程宿主机触发构建与容器编排: ./scripts/deploy.sh deploy '${ENV}' '${TARGET}'..."
  run_remote_cmd "cd '${REMOTE_DIR}' && SKIP_MIGRATE='${SKIP_MIGRATE}' ./scripts/deploy.sh deploy '${ENV}' '${TARGET}'"

  succ "🎉 远程主机 [${REMOTE_HOST}] 部署流程已全部完成！"
  divider
}

execute_remote_status() {
  check_remote_env
  info "正在查询远程主机 [${REMOTE_HOST}] 的容器运行与健康探针状态..."
  run_remote_cmd "cd '${REMOTE_DIR}' && ./scripts/deploy.sh status '${ENV}'"
}

execute_remote_logs() {
  check_remote_env
  info "正在连接远程主机 [${REMOTE_HOST}] 查看实时容器日志 (按 Ctrl+C 退出)..."
  run_remote_tty "cd '${REMOTE_DIR}' && ./scripts/deploy.sh logs '${ENV}' '${TARGET}'"
}

execute_remote_stop() {
  check_remote_env
  info "正在请求远程主机 [${REMOTE_HOST}] 优雅停止容器..."
  run_remote_cmd "cd '${REMOTE_DIR}' && ./scripts/deploy.sh stop '${ENV}' '${TARGET}'"
  succ "远程容器关停指令已完成。"
}

execute_remote_restart() {
  check_remote_env
  info "正在请求远程主机 [${REMOTE_HOST}] 重启容器..."
  run_remote_cmd "cd '${REMOTE_DIR}' && ./scripts/deploy.sh restart '${ENV}' '${TARGET}'"
  succ "远程容器重启指令已完成。"
}

check_prerequisites_and_run() {
  if [[ "$ACTION" =~ ^remote ]]; then
    case "$ACTION" in
      remote|remote-deploy) execute_remote_deploy ;;
      remote-status) execute_remote_status ;;
      remote-logs) execute_remote_logs ;;
      remote-stop) execute_remote_stop ;;
      remote-restart) execute_remote_restart ;;
    esac
  else
    check_prerequisites
    setup_vars
    case "$ACTION" in
      deploy) execute_deploy ;;
      build) build_targets ;;
      start) start_containers ;;
      stop) stop_containers ;;
      restart) restart_containers ;;
      status) show_status ;;
      logs) show_logs ;;
      clean) clean_all ;;
    esac
  fi
}

# 主程序入口
main() {
  # 若未传入任何参数，且终端处于交互式 tty，启动交互式一体化部署器
  if [[ $# -eq 0 && -t 0 ]]; then
    interactive_runner
    exit 0
  fi

  # 否则进入 CLI 批处理模式
  parse_args "$@"
  if [[ -z "${ACTION:-}" ]]; then
    ACTION="deploy"
  fi
  check_prerequisites_and_run
}

main "$@"
