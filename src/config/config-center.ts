/**
 * 启动时从运行时内部网关的配置中心（sidecar/gateway，GET /api/config/{namespace}）加载配置，写进 process.env，
 * 再由 loadEnv 统一校验。约定见 crm-ai-agent/docs/配置中心约定.md：
 * - 本服务读命名空间 agent-shared、agent-app（后者覆盖前者）；键名就是环境变量名（大写下划线），
 *   与 wecom-finance 等命名空间的小驼峰键互不冲突，非大写下划线的键一律忽略；
 * - 配置中心的值覆盖本地 .env / 环境变量；连接类配置（数据库、Redis、网关自身）只取本地，不被覆盖；
 * - 配置中心不可达时默认用本地配置继续启动（打印告警）；CONFIG_CENTER_REQUIRED=true 时直接启动失败；
 * - 日志只打印键名，不打印值。
 */

export const CONFIG_NAMESPACES = ['agent-shared', 'agent-app'] as const;

/** 只从本地取、不被配置中心覆盖的键 */
export const LOCAL_ONLY_KEYS = new Set([
  'NODE_ENV', 'PORT', 'ENV_FILE', 'MYSQL_URL', 'REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REDIS_DB',
  'GATEWAY_URL', 'GATEWAY_ENABLED', 'GATEWAY_AUTH_TOKEN', 'GATEWAY_SERVICE_NAME', 'GATEWAY_INSTANCE_ID', 'GATEWAY_HOST',
  'GATEWAY_HEARTBEAT_INTERVAL_MS', 'CONFIG_CENTER_REQUIRED', 'CONFIG_CENTER_TIMEOUT_MS',
  // 一个机器人只能有一条长连接，按机器决定由哪台持有；配置中心是所有实例共用的，不能放
  'WECOM_BOT_ENABLED',
]);

const KEY = /^[A-Z][A-Z0-9_]*$/;

export interface ConfigCenterResult {
  /** loaded：已加载；disabled：没开网关；unreachable：取不到，用本地配置 */
  status: 'loaded' | 'disabled' | 'unreachable';
  applied: string[];
  ignored: string[];
}

const truthy = (v?: string) => !!v && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
const falsy = (v?: string) => !!v && ['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase());

/** 把配置中心的值转成环境变量字符串（数字、布尔转字符串，对象转 JSON） */
export function toEnvValue(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** 合并多个命名空间（后者覆盖前者），只保留可应用的键 */
export function mergeNamespaces(data: Array<Record<string, unknown>>): { values: Record<string, string>; ignored: string[] } {
  const values: Record<string, string> = {};
  const ignored = new Set<string>();
  for (const ns of data) {
    for (const [k, v] of Object.entries(ns ?? {})) {
      const s = toEnvValue(v);
      if (!KEY.test(k) || LOCAL_ONLY_KEYS.has(k) || s === undefined) ignored.add(k);
      else values[k] = s;
    }
  }
  return { values, ignored: [...ignored] };
}

export async function loadConfigCenter(
  target: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  log: Pick<Console, 'log' | 'warn'> = console,
): Promise<ConfigCenterResult> {
  if (falsy(target.GATEWAY_ENABLED)) return { status: 'disabled', applied: [], ignored: [] };
  const base = (target.GATEWAY_URL || 'http://localhost:3003').replace(/\/+$/, '');
  const timeoutMs = Number(target.CONFIG_CENTER_TIMEOUT_MS) || 3000;
  const headers: Record<string, string> = target.GATEWAY_AUTH_TOKEN ? { 'x-gateway-token': target.GATEWAY_AUTH_TOKEN } : {};
  try {
    const data = await Promise.all(
      CONFIG_NAMESPACES.map(async (ns) => {
        const res = await fetchImpl(`${base}/api/config/${encodeURIComponent(ns)}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`命名空间 ${ns} 返回 HTTP ${res.status}`);
        const body = (await res.json()) as { data?: Record<string, unknown> };
        return body.data ?? {};
      }),
    );
    const { values, ignored } = mergeNamespaces(data);
    for (const [k, v] of Object.entries(values)) target[k] = v;
    const applied = Object.keys(values).sort();
    log.log(`[配置中心] 已加载 ${CONFIG_NAMESPACES.join(' + ')}：${applied.length ? applied.join(', ') : '（空）'}${ignored.length ? `；忽略 ${ignored.join(', ')}` : ''}`);
    return { status: 'loaded', applied, ignored };
  } catch (err) {
    const msg = `[配置中心] ${base} 读取失败：${(err as Error).message}`;
    if (truthy(target.CONFIG_CENTER_REQUIRED)) throw new Error(`${msg}（CONFIG_CENTER_REQUIRED=true，停止启动）`);
    log.warn(`${msg}，使用本地配置继续启动`);
    return { status: 'unreachable', applied: [], ignored: [] };
  }
}
