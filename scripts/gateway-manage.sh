#!/usr/bin/env bash
# ==============================================================================
# A3 伴生网关 (Sidecar Gateway) 终端管理控制台 (gateway-manage.sh)
#
# 提供纯终端 (CLI / TUI) 下的全功能交互式管理能力，覆盖：
# 1. 动态配置中心 (CC): 命名空间查询、单项/批量配置增删改查、秒级热生效广播
# 2. 预置业务助手: 企微机器人 (wecom)、流控参数 (runtime)、会话存档 (wecom-finance) 快捷配置
# 3. 服务注册发现 (SRF): 实例探活、租期监控与手动下线
# 4. 伴生自省手册: 在线接口索引与出入参说明检索 (Manual)
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 颜色与样式定义
COLOR_RESET="\033[0m"
COLOR_BOLD="\033[1m"
COLOR_RED="\033[31m"
COLOR_GREEN="\033[32m"
COLOR_YELLOW="\033[33m"
COLOR_BLUE="\033[34m"
COLOR_MAGENTA="\033[35m"
COLOR_CYAN="\033[36m"
COLOR_GRAY="\033[90m"

log_info() {
    echo -e "${COLOR_GREEN}[INFO]${COLOR_RESET} $1"
}

log_warn() {
    echo -e "${COLOR_YELLOW}[WARN]${COLOR_RESET} $1"
}

log_error() {
    echo -e "${COLOR_RED}[ERROR]${COLOR_RESET} $1"
}

log_success() {
    echo -e "${COLOR_GREEN}${COLOR_BOLD}[SUCCESS]${COLOR_RESET} $1"
}

# 自动发现并加载配置环境
load_env() {
    local custom_gw="${GATEWAY_URL:-}"
    local custom_token="${GATEWAY_AUTH_TOKEN:-${GATEWAY_TOKEN:-}}"

    # 优先加载 A3 根目录 .env
    if [ -f "${APP_ROOT}/.env.local" ]; then
        export $(grep -v '^#' "${APP_ROOT}/.env.local" | xargs -r) 2>/dev/null || true
    elif [ -f "${APP_ROOT}/.env" ]; then
        export $(grep -v '^#' "${APP_ROOT}/.env" | xargs -r) 2>/dev/null || true
    fi

    # 其次加载 gateway 自身 .env
    if [ -f "${APP_ROOT}/sidecar/gateway/.env" ]; then
        export $(grep -v '^#' "${APP_ROOT}/sidecar/gateway/.env" | xargs -r) 2>/dev/null || true
    fi

    # 如果用户外部有显式传入 GATEWAY_URL，优先使用外部传入
    if [ -n "${custom_gw}" ]; then
        GATEWAY_URL="${custom_gw}"
    else
        GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:3003}"
    fi

    # 智能宿主机网络环境适配：若为容器内域名 a3-gateway 且宿主机不可解析，自动回退至 127.0.0.1
    if [[ "${GATEWAY_URL}" =~ a3-gateway ]]; then
        if ! ping -c 1 -W 1 a3-gateway &>/dev/null && ! getent hosts a3-gateway &>/dev/null; then
            GATEWAY_URL="${GATEWAY_URL//a3-gateway/127.0.0.1}"
        fi
    fi

    GATEWAY_URL="${GATEWAY_URL%/}"
    GATEWAY_TOKEN="${custom_token:-${GATEWAY_AUTH_TOKEN:-${GATEWAY_TOKEN:-}}}"
}

# 通用 HTTP 请求包装函数
api_request() {
    local method="$1"
    local endpoint="$2"
    local data="${3:-}"

    local url="${GATEWAY_URL}${endpoint}"
    local headers=(-H "Content-Type: application/json")
    if [ -n "${GATEWAY_TOKEN}" ]; then
        headers+=(-H "x-gateway-token: ${GATEWAY_TOKEN}")
    fi

    local response=""
    local http_code=""
    local temp_out
    temp_out=$(mktemp)

    local curl_exit=0
    if [ -n "${data}" ]; then
        http_code=$(curl -s -w "%{http_code}" -X "${method}" "${headers[@]}" -d "${data}" "${url}" -o "${temp_out}") || curl_exit=$?
    else
        http_code=$(curl -s -w "%{http_code}" -X "${method}" "${headers[@]}" "${url}" -o "${temp_out}") || curl_exit=$?
    fi

    if [ -f "${temp_out}" ]; then
        response=$(cat "${temp_out}")
        rm -f "${temp_out}"
    fi

    # 规范化提取 HTTP 状态码末位三位数字
    if [[ "${http_code}" =~ ([0-9]{3})$ ]]; then
        http_code="${BASH_REMATCH[1]}"
    else
        http_code="000"
    fi

    if [ "${curl_exit}" -ne 0 ] || [ "${http_code}" = "000" ]; then
        log_error "无法连接到伴生网关服务: ${url} (请确认网关是否正常启动在端口 3003)" >&2
        return 2
    fi

    if [ "${http_code}" = "404" ]; then
        return 44
    fi

    if [ "${http_code}" -ge 400 ]; then
        log_error "网关响应异常 (HTTP ${http_code}):" >&2
        echo "${response}" | format_json >&2
        return 1
    fi

    echo "${response}"
}

# 格式化 JSON 输出
format_json() {
    if command -v jq &>/dev/null; then
        jq . 2>/dev/null || cat
    elif command -v python3 &>/dev/null; then
        python3 -m json.tool 2>/dev/null || cat
    else
        cat
    fi
}

# ==============================================================================
# 功能函数: 服务注册与发现 (SRF)
# ==============================================================================

cmd_registry_list() {
    local service_name="${1:-}"
    local endpoint="/api/registry/instances"
    if [ -n "${service_name}" ]; then
        endpoint="/api/registry/instances/${service_name}"
    fi

    log_info "正在查询网关服务注册表 [${endpoint}]..."
    local res=""
    local api_code=0

    if [ -z "${service_name}" ]; then
        # 1. 尝试直接请求 /api/registry/instances
        res=$(api_request "GET" "/api/registry/instances") || api_code=$?

        # 2. 如果网关返回 404 (退出码 44，代表网关未注册该无参路由)，自动智能降级为：拉取 /services 并遍历聚合各服务实例
        if [ "${api_code}" -eq 44 ]; then
            local services_res
            services_res=$(api_request "GET" "/api/registry/services") || return 1
            res=$(python3 -c "
import json, urllib.request, sys
gw_url = sys.argv[1]
token = sys.argv[2]
headers = {'Content-Type': 'application/json'}
if token: headers['x-gateway-token'] = token
try:
    s_data = json.loads(sys.argv[3]).get('data', [])
    all_inst = []
    for s in s_data:
        req = urllib.request.Request(f'{gw_url}/api/registry/instances/{s}', headers=headers)
        with urllib.request.urlopen(req) as resp:
            inst_list = json.loads(resp.read().decode()).get('data', [])
            all_inst.extend(inst_list)
    print(json.dumps({'success': True, 'data': all_inst}))
except Exception as e:
    print(json.dumps({'success': False, 'error': str(e), 'data': []}))
" "${GATEWAY_URL}" "${GATEWAY_TOKEN}" "${services_res}")
        elif [ "${api_code}" -ne 0 ]; then
            return 1
        fi
    else
        res=$(api_request "GET" "${endpoint}") || return 1
    fi

    if [ -z "${res}" ]; then
        return 1
    fi


    echo -e "${COLOR_CYAN}============ 网关已注册服务与活跃实例 ============${COLOR_RESET}"
    python3 -c "
import json, sys

try:
    payload = json.loads(sys.argv[1])
    items = payload.get('data', [])
    if not items:
        print('  (暂无注册活跃实例)')
        sys.exit(0)
    
    header = f'  {\"实例 ID\":<16} {\"服务名称\":<24} {\"监听端点\":<20} {\"状态\":<8} {\"租期TTL\":<8}'
    print(header)
    print('  ' + '-' * 80)
    for it in items:
        inst_id = str(it.get('instanceId', '-'))
        s_name = str(it.get('serviceName', '-'))
        host_port = f\"{it.get('host', '127.0.0.1')}:{it.get('port', 0)}\"
        status = str(it.get('status', 'UP'))
        ttl = f\"{it.get('ttlSeconds', 30)}s\"
        print(f'  {inst_id:<16} {s_name:<24} {host_port:<20} {status:<8} {ttl:<8}')
except Exception:
    sys.stdout.write(sys.argv[1])
" "${res}"
}


cmd_registry_deregister() {
    local instance_id="${1:-}"
    local service_name="${2:-}"

    if [ -z "${instance_id}" ] || [ -z "${service_name}" ]; then
        log_error "用法: $0 registry deregister <instanceId> <serviceName>"
        return 1
    fi

    local payload
    payload=$(printf '{"instanceId":"%s","serviceName":"%s"}' "${instance_id}" "${service_name}")
    log_info "正在注销实例 [${service_name}] ${instance_id}..."
    local res
    res=$(api_request "POST" "/api/registry/deregister" "${payload}")
    log_success "实例注销指令已完成:"
    echo "${res}" | format_json
}

# ==============================================================================
# 功能函数: 配置中心 (CC)
# ==============================================================================

cmd_config_list() {
    log_info "正在获取所有配置命名空间列表..."
    local res
    res=$(api_request "GET" "/api/config/namespaces")
    echo -e "${COLOR_CYAN}============ 配置命名空间列表 (Namespaces) ============${COLOR_RESET}"
    echo "${res}" | format_json
}

cmd_config_get() {
    local namespace="${1:-}"
    local key="${2:-}"

    if [ -z "${namespace}" ]; then
        log_error "用法: $0 config get <namespace> [key]"
        return 1
    fi

    local endpoint="/api/config/${namespace}"
    if [ -n "${key}" ]; then
        endpoint="/api/config/${namespace}/${key}"
    else
        endpoint="/api/config/${namespace}?detail=true"
    fi

    log_info "正在读取配置 [${endpoint}]..."
    local res
    res=$(api_request "GET" "${endpoint}")
    echo -e "${COLOR_CYAN}============ 配置详情 [${namespace}${key:+.$key}] ============${COLOR_RESET}"
    echo "${res}" | format_json
}

cmd_config_set() {
    local namespace="${1:-}"
    local key="${2:-}"
    local value="${3:-}"
    local comment="${4:-cli_update}"

    if [ -z "${namespace}" ] || [ -z "${key}" ] || [ -z "${value}" ]; then
        log_error "用法: $0 config set <namespace> <key> <value> [comment]"
        return 1
    fi

    # 尝试将 value 解析为 JSON，若解析失败则按纯字符串处理
    local json_value
    if python3 -c "import json, sys; json.loads(sys.argv[1])" "${value}" 2>/dev/null; then
        json_value="${value}"
    else
        json_value=$(python3 -c "import json, sys; print(json.dumps(sys.argv[1]))" "${value}")
    fi

    local payload
    payload=$(python3 -c "import json, sys; print(json.dumps({'key': sys.argv[1], 'value': json.loads(sys.argv[2]), 'comment': sys.argv[3]}))" "${key}" "${json_value}" "${comment}")

    log_info "正在更新配置 [${namespace}.${key}]..."
    local res
    res=$(api_request "POST" "/api/config/${namespace}" "${payload}")
    log_success "配置已成功更新并广播至 Redis (ag:cfg:changed):"
    echo "${res}" | format_json
}

cmd_config_batch() {
    local namespace="${1:-}"
    local configs_json="${2:-}"
    local comment="${3:-cli_batch_update}"

    if [ -z "${namespace}" ] || [ -z "${configs_json}" ]; then
        log_error "用法: $0 config batch <namespace> '<json_configs>' [comment]"
        return 1
    fi

    local payload
    payload=$(python3 -c "import json, sys; print(json.dumps({'configs': json.loads(sys.argv[1]), 'comment': sys.argv[2]}))" "${configs_json}" "${comment}")

    log_info "正在批量更新命名空间 [${namespace}] 配置..."
    local res
    res=$(api_request "POST" "/api/config/${namespace}/batch" "${payload}")
    log_success "批量配置已成功保存并广播热生效:"
    echo "${res}" | format_json
}

cmd_config_delete() {
    local namespace="${1:-}"
    local key="${2:-}"

    if [ -z "${namespace}" ]; then
        log_error "用法: $0 config delete <namespace> [key]"
        return 1
    fi

    local endpoint="/api/config/${namespace}"
    if [ -n "${key}" ]; then
        endpoint="/api/config/${namespace}/${key}"
        log_info "正在删除单项配置 [${namespace}.${key}]..."
    else
        log_warn "即将清空并删除整个命名空间 [${namespace}]！"
    fi

    local res
    res=$(api_request "DELETE" "${endpoint}")
    log_success "删除操作成功，已广播变更通知:"
    echo "${res}" | format_json
}

# ==============================================================================
# 快捷业务助手: 企微机器人配置 (wecom)
# ==============================================================================

cmd_wecom_get() {
    log_info "正在读取企业微信 (wecom) 当前生效配置..."
    cmd_config_get "wecom"
}

cmd_wecom_set() {
    local bot_id=""
    local bot_secret=""
    local bot_ws_url="wss://openws.work.weixin.qq.com"
    local staff_mentions="@客服"
    local bot_enabled="true"
    local callback_token=""
    local callback_aes_key=""
    local corpid=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --bot-id) bot_id="$2"; shift 2 ;;
            --bot-secret) bot_secret="$2"; shift 2 ;;
            --ws-url) bot_ws_url="$2"; shift 2 ;;
            --staff-mentions) staff_mentions="$2"; shift 2 ;;
            --enabled) bot_enabled="$2"; shift 2 ;;
            --callback-token) callback_token="$2"; shift 2 ;;
            --callback-aes-key) callback_aes_key="$2"; shift 2 ;;
            --corpid) corpid="$2"; shift 2 ;;
            *) log_error "未知企微参数: $1"; return 1 ;;
        esac
    done

    if [ -z "${bot_id}" ] && [ -z "${bot_secret}" ] && [ -z "${callback_token}" ]; then
        log_error "请至少提供 --bot-id、--bot-secret 或 --callback-token 参数！"
        return 1
    fi

    local configs_json
    configs_json=$(python3 -c "
import json, sys
data = {}
if sys.argv[1]: data['botId'] = sys.argv[1]
if sys.argv[2]: data['botSecret'] = sys.argv[2]
if sys.argv[3]: data['botWsUrl'] = sys.argv[3]
if sys.argv[4]: data['staffMentions'] = sys.argv[4]
if sys.argv[5]: data['botEnabled'] = (sys.argv[5].lower() == 'true')
if sys.argv[6]: data['callbackToken'] = sys.argv[6]
if sys.argv[7]: data['callbackAesKey'] = sys.argv[7]
if sys.argv[8]: data['corpid'] = sys.argv[8]
print(json.dumps(data))
" "${bot_id}" "${bot_secret}" "${bot_ws_url}" "${staff_mentions}" "${bot_enabled}" "${callback_token}" "${callback_aes_key}" "${corpid}")

    cmd_config_batch "wecom" "${configs_json}" "终端助手更新企业微信配置"
}

# ==============================================================================
# 快捷业务助手: 运行态流控配置 (runtime)
# ==============================================================================

cmd_runtime_get() {
    log_info "正在读取运行态流控 (runtime) 当前配置..."
    cmd_config_get "runtime"
}

cmd_runtime_set() {
    local quiet_ms=""
    local timeout_ms=""
    local group_max=""
    local mic_scope=""
    local human_wait_ms=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --quiet) quiet_ms="$2"; shift 2 ;;
            --timeout) timeout_ms="$2"; shift 2 ;;
            --group-max) group_max="$2"; shift 2 ;;
            --mic-scope) mic_scope="$2"; shift 2 ;;
            --human-wait) human_wait_ms="$2"; shift 2 ;;
            *) log_error "未知流控参数: $1"; return 1 ;;
        esac
    done

    local configs_json
    configs_json=$(python3 -c "
import json, sys
data = {}
if sys.argv[1]: data['quietWindowMs'] = int(sys.argv[1])
if sys.argv[2]: data['hardTimeoutMs'] = int(sys.argv[2])
if sys.argv[3]: data['groupMaxMessages'] = int(sys.argv[3])
if sys.argv[4]: data['micSeizeScope'] = sys.argv[4]
if sys.argv[5]: data['humanWaitTimeoutMs'] = int(sys.argv[5])
print(json.dumps(data))
" "${quiet_ms}" "${timeout_ms}" "${group_max}" "${mic_scope}" "${human_wait_ms}")

    cmd_config_batch "runtime" "${configs_json}" "终端助手更新运行态流控配置"
}

# ==============================================================================
# 自省手册与健康检查
# ==============================================================================

cmd_manual() {
    local index="${1:-}"
    local endpoint="/api/manual"
    if [ -n "${index}" ]; then
        endpoint="/api/manual?index=${index}"
    fi

    log_info "正在拉取网关自省手册 [${endpoint}]..."
    local res
    res=$(api_request "GET" "${endpoint}")
    echo -e "${COLOR_CYAN}============ 伴生网关自省手册与接口索引 ============${COLOR_RESET}"
    echo "${res}" | format_json
}

cmd_health() {
    log_info "正在探测伴生网关健康状态..."
    local res
    res=$(api_request "GET" "/health")
    log_success "网关健康运行中:"
    echo "${res}" | format_json
}

# ==============================================================================
# 交互式菜单主循环 (TUI Mode)
# ==============================================================================

interactive_menu() {
    while true; do
        echo -e ""
        echo -e "${COLOR_CYAN}${COLOR_BOLD}================================================================${COLOR_RESET}"
        echo -e "${COLOR_CYAN}${COLOR_BOLD}       A3 伴生网关 (Sidecar Gateway) 终端管理控制台             ${COLOR_RESET}"
        echo -e "${COLOR_CYAN}${COLOR_BOLD}================================================================${COLOR_RESET}"
        echo -e "网关地址: ${COLOR_YELLOW}${GATEWAY_URL}${COLOR_RESET}  |  Token 状态: ${COLOR_GREEN}${GATEWAY_TOKEN:+'[已加载鉴权 Token]'}${GATEWAY_TOKEN:-'[未配置 Token]'}${COLOR_RESET}"
        echo -e ""
        echo -e "  ${COLOR_BOLD}[1] 服务发现:${COLOR_RESET} 查看已注册微服务与健康实例 (SRF)"
        echo -e "  ${COLOR_BOLD}[2] 配置中心:${COLOR_RESET} 列出所有命名空间与配置项总览 (CC)"
        echo -e "  ${COLOR_BOLD}[3] 配置中心:${COLOR_RESET} 查看某命名空间详细配置"
        echo -e "  ${COLOR_BOLD}[4] 企微助手:${COLOR_RESET} 交互式录入/更新企业微信机器人凭证 (wecom)"
        echo -e "  ${COLOR_BOLD}[5] 流控助手:${COLOR_RESET} 交互式调节运行态静默/熔断/话筒参数 (runtime)"
        echo -e "  ${COLOR_BOLD}[6] 侧车助手:${COLOR_RESET} 交互式调节会话存档参数 (wecom-finance)"
        echo -e "  ${COLOR_BOLD}[7] 高级管理:${COLOR_RESET} 手动设置/修改任意单项配置"
        echo -e "  ${COLOR_BOLD}[8] 高级管理:${COLOR_RESET} 删除指定配置项或清空命名空间"
        echo -e "  ${COLOR_BOLD}[9] 接口手册:${COLOR_RESET} 检索网关自省手册与出入参说明 (Manual)"
        echo -e "  ${COLOR_BOLD}[h] 健康状态:${COLOR_RESET} 查看网关实时健康检查"
        echo -e "  ${COLOR_BOLD}[0] 退出控制台${COLOR_RESET}"
        echo -e "${COLOR_CYAN}----------------------------------------------------------------${COLOR_RESET}"
        read -r -p "请输入选项 [0-9/h]: " choice

        case "${choice}" in
            1)
                echo ""
                read -r -p "输入过滤服务名 (直接回车查看全部): " s_name
                cmd_registry_list "${s_name}"
                ;;
            2)
                echo ""
                cmd_config_list
                ;;
            3)
                echo ""
                read -r -p "请输入命名空间名称 (如 wecom / runtime / wecom-finance): " ns_name
                if [ -n "${ns_name}" ]; then
                    cmd_config_get "${ns_name}"
                else
                    log_warn "命名空间不能为空！"
                fi
                ;;
            4)
                echo ""
                echo -e "${COLOR_BOLD}>>> 企业微信机器人凭证动态配置向导 <<<${COLOR_RESET}"
                read -r -p "Bot ID (机器人唯一标识): " in_bot_id
                read -rs -p "Bot Secret (机器人密钥，输入隐藏): " in_bot_secret
                echo ""
                read -r -p "WebSocket 网关地址 [默认 wss://openws.work.weixin.qq.com]: " in_ws_url
                in_ws_url="${in_ws_url:-wss://openws.work.weixin.qq.com}"
                read -r -p "转人工群内 @ 标识 [默认 @客服]: " in_staff
                in_staff="${in_staff:-@客服}"
                read -r -p "是否启用长连接 (true/false) [默认 true]: " in_enabled
                in_enabled="${in_enabled:-true}"

                cmd_wecom_set --bot-id "${in_bot_id}" \
                              --bot-secret "${in_bot_secret}" \
                              --ws-url "${in_ws_url}" \
                              --staff-mentions "${in_staff}" \
                              --enabled "${in_enabled}"
                ;;
            5)
                echo ""
                echo -e "${COLOR_BOLD}>>> 运行态流控与话筒参数动态调节向导 <<<${COLOR_RESET}"
                read -r -p "静默窗口毫秒数 (默认 3000): " in_quiet
                read -r -p "硬超时熔断毫秒数 (默认 15000): " in_timeout
                read -r -p "单组最大消息数 (默认 5): " in_group_max
                read -r -p "员工抢话筒范围 (ALL_INTERNAL / CS_ONLY): " in_mic_scope

                cmd_runtime_set ${in_quiet:+--quiet "${in_quiet}"} \
                                ${in_timeout:+--timeout "${in_timeout}"} \
                                ${in_group_max:+--group-max "${in_group_max}"} \
                                ${in_mic_scope:+--mic-scope "${in_mic_scope}"}
                ;;
            6)
                echo ""
                echo -e "${COLOR_BOLD}>>> 会话存档侧车 (wecom-finance) 参数调节向导 <<<${COLOR_RESET}"
                read -r -p "CorpID (企业微信 CorpID): " in_corp
                read -rs -p "ChatData Secret (会话存档 Secret，输入隐藏): " in_sec
                echo ""
                read -r -p "轮询拉取间隔毫秒数 (默认 1000): " in_poll
                read -r -p "单批次最大条数 (默认 100): " in_batch

                local wf_json
                wf_json=$(python3 -c "
import json, sys
d = {}
if sys.argv[1]: d['corpid'] = sys.argv[1]
if sys.argv[2]: d['secret'] = sys.argv[2]
if sys.argv[3]: d['pollIntervalMs'] = int(sys.argv[3])
if sys.argv[4]: d['batchSize'] = int(sys.argv[4])
print(json.dumps(d))
" "${in_corp}" "${in_sec}" "${in_poll}" "${in_batch}")

                if [ -n "${wf_json}" ] && [ "${wf_json}" != "{}" ]; then
                    cmd_config_batch "wecom-finance" "${wf_json}" "终端助手调节会话存档参数"
                else
                    log_warn "未录入有效参数，已取消"
                fi
                ;;
            7)
                echo ""
                echo -e "${COLOR_BOLD}>>> 手动设置/修改配置项 <<<${COLOR_RESET}"
                read -r -p "命名空间 (Namespace): " m_ns
                read -r -p "配置键名 (Key): " m_key
                read -r -p "配置值 (Value，支持数字、字符串或 JSON 格式): " m_val
                read -r -p "变更备注 (Comment) [选填]: " m_comment
                if [ -n "${m_ns}" ] && [ -n "${m_key}" ] && [ -n "${m_val}" ]; then
                    cmd_config_set "${m_ns}" "${m_key}" "${m_val}" "${m_comment:-manual_update}"
                else
                    log_error "命名空间、键名和配置值均为必填项！"
                fi
                ;;
            8)
                echo ""
                echo -e "${COLOR_BOLD}>>> 删除配置项或清空命名空间 <<<${COLOR_RESET}"
                read -r -p "命名空间 (Namespace): " d_ns
                read -r -p "配置键名 (直接回车将清空整个命名空间！): " d_key
                if [ -n "${d_ns}" ]; then
                    read -r -p "确认执行删除？(y/N): " confirm
                    if [[ "${confirm}" =~ ^[Yy]$ ]]; then
                        cmd_config_delete "${d_ns}" "${d_key}"
                    else
                        log_info "操作已取消"
                    fi
                fi
                ;;
            9)
                echo ""
                read -r -p "输入接口索引参数 index (直接回车查看全量手册): " m_idx
                cmd_manual "${m_idx}"
                ;;
            h|H)
                echo ""
                cmd_health
                ;;
            0|q|Q)
                echo -e "${COLOR_GREEN}感谢使用 A3 终端管理控制台，再见！${COLOR_RESET}"
                exit 0
                ;;
            *)
                log_warn "无效选项，请重新输入"
                ;;
        esac

        echo ""
        read -r -p "按回车键返回主菜单..."
    done
}

# ==============================================================================
# CLI 命令路由与入口分发
# ==============================================================================

print_help() {
    cat << EOF
A3 伴生网关 (Sidecar Gateway) 终端管理控制台

用法:
  $0 [子命令] [参数...]

无参数时默认进入交互式菜单控制台 (TUI 模式)。

常用子命令:
  config list                                   列出所有配置命名空间
  config get <namespace> [key]                  获取命名空间或特定项配置
  config set <namespace> <key> <val> [comment]  设置/更新单项配置
  config batch <namespace> '<json>' [comment]   批量更新配置字典
  config delete <namespace> [key]               删除配置项或清空命名空间

业务助手快捷命令:
  wecom get                                     查看企业微信当前配置
  wecom set --bot-id <id> --bot-secret <secret> [--ws-url <url>] [--staff-mentions <staff>]
  runtime get                                   查看当前流控阈值
  runtime set [--quiet <ms>] [--timeout <ms>] [--group-max <n>] [--mic-scope <scope>]

服务发现与手册:
  registry list [serviceName]                   列出已注册实例
  registry deregister <instanceId> <serviceName>注销实例
  manual [index]                                检索自省手册接口说明
  health                                        网关健康检查探活

环境变量支持:
  GATEWAY_URL          网关请求地址 (默认: http://127.0.0.1:3003)
  GATEWAY_AUTH_TOKEN   网关鉴权令牌 (默认从 .env 自动读取)

EOF
}

main() {
    load_env

    if [ $# -eq 0 ]; then
        interactive_menu
        exit 0
    fi

    local action="$1"
    shift

    case "${action}" in
        -h|--help|help)
            print_help
            ;;
        health)
            cmd_health
            ;;
        manual)
            cmd_manual "$@"
            ;;
        registry)
            local sub="$1"
            shift || true
            case "${sub}" in
                list) cmd_registry_list "$@" ;;
                deregister) cmd_registry_deregister "$@" ;;
                *) log_error "未知 registry 子命令: ${sub}"; print_help; exit 1 ;;
            esac
            ;;
        config)
            local sub="$1"
            shift || true
            case "${sub}" in
                list) cmd_config_list ;;
                get) cmd_config_get "$@" ;;
                set) cmd_config_set "$@" ;;
                batch) cmd_config_batch "$@" ;;
                delete) cmd_config_delete "$@" ;;
                *) log_error "未知 config 子命令: ${sub}"; print_help; exit 1 ;;
            esac
            ;;
        wecom)
            local sub="$1"
            shift || true
            case "${sub}" in
                get) cmd_wecom_get ;;
                set) cmd_wecom_set "$@" ;;
                *) log_error "未知 wecom 子命令: ${sub}"; print_help; exit 1 ;;
            esac
            ;;
        runtime)
            local sub="$1"
            shift || true
            case "${sub}" in
                get) cmd_runtime_get ;;
                set) cmd_runtime_set "$@" ;;
                *) log_error "未知 runtime 子命令: ${sub}"; print_help; exit 1 ;;
            esac
            ;;
        *)
            log_error "未知子命令: ${action}"
            print_help
            exit 1
            ;;
    esac
}

main "$@"
