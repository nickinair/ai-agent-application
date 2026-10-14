/**
 * @file turn-context.ts
 * @description 智能体核心流水线上下文契约（贯穿六道关的主干数据模型）
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.2、§5.4、§5.5、§5.6、§5.7、§5.8、§5.9
 */

import type {
  ActionType,
  AnswerSource,
  EmotionType,
  HandoffType,
  MainIntent,
  MemberRole,
  TurnRelation,
} from './enums';
import type { MessageRef } from './message';

/**
 * 客户业务画像与 CRM 关联属性
 * 
 * 业务背景：
 * - 详见方案 §5.3 与 §11.2。在封组时由接入层结合群名称正则解析与 CRM 预取获得；
 * - 写入会话快照（conversation.customer_snapshot），在当前会话的生命周期内缓存复用，避免频繁穿透 CRM 查询；
 * - bought 字段直接决定场景路由器匹配“售前顾问”（未购）还是“售后管家”（已购）。
 */
export interface CustomerProfile {
  /**
   * 客户姓名（群名解析或 CRM 系统档案姓名）
   */
  name?: string;

  /**
   * 脱敏后的联系电话
   * 业务边界：用于日志审计、大模型 Prompt 脱敏展示及前端界面，如 "138****1234"
   */
  phoneMasked?: string;

  /**
   * 真实联系电话
   * 业务边界：仅限后端调用 CRM 接口补全车辆档案时使用，严禁直接拼入外部大模型 Prompt
   */
  phone?: string;

  /**
   * 客户所属车型或意向车型（如 "问界M5"、"问界M7"）
   * 业务边界：用于知识库检索与价目表查询的产品过滤
   */
  vehicle?: string;

  /**
   * 当前咨询或群名称关联的产品类别（如 "整车延保"、"三电延保"）
   */
  product?: string;

  /**
   * 是否已购买涉及的产品
   * 业务边界：
   * - false: 判定为售前场景，知识范围侧重产品介绍、卖点与价目表；
   * - true: 判定为售后场景，知识范围侧重保障条款、理赔流程与保单服务。
   */
  bought?: boolean;

  orderNo?: string;

  /**
   * CRM 系统中的客户全局唯一标识（若已匹配）
   */
  crmCustomerId?: number;

  /**
   * 客户名下车辆列表快照（来自 CRM 查询）
   */
  vehicles?: VehicleProfile[];

  /**
   * 客户已购商品或延保产品快照（来自 CRM 查询）
   */
  boughtProducts?: BoughtProduct[];
}

/**
 * 客户名下车辆信息快照（§11.2）
 */
export interface VehicleProfile {
  brand?: string;
  model: string;
  vinMasked?: string;
  purchaseDate?: string;
}

/**
 * 客户已购商品快照（§11.2）
 */
export interface BoughtProduct {
  productName: string;
  boughtAt?: number;
  price?: number;
}

/**
 * 会话级实时同步计数器
 * 
 * 业务背景：
 * - 详见方案 §5.5.3 转人工判定与 §5.9 笔记本结构；
 * - 这些计数器由各处理关卡在主流水线中**同步递增或重置**，供决策层实时评估客户挫败感。
 */
export interface SessionCounters {
  /**
   * 当前会话内客户发起“纠正”的总次数
   * 业务阈值：达到平台阈值（默认 3 次）触发转人工
   */
  correctionTotal: number;

  /**
   * 当前会话内连续发生“纠正”的次数
   * 业务阈值：达到平台阈值（默认 2 次）立即触发转人工；若发生非纠正轮次则重置为 0
   */
  correctionConsecutive: number;

  /**
   * 连续低置信度轮次数
   * 业务阈值：连续多轮（默认 2 轮）检索置信度低于阈值 B 时触发知识盲区转人工
   */
  lowConfConsecutive: number;

  /**
   * 客户情绪剧烈爆发（如愤怒/激烈投诉）的累计次数
   */
  emotionBurst: number;
}

/**
 * 历史轮次简要笔记
 * 
 * 业务背景：
 * - 详见方案 §5.9。记录在笔记本中供后续轮次查看上下文脉络，每轮仅追加一行，不可篡改。
 */
export interface TurnNote {
  /**
   * 会话内第几轮（从 1 开始递增）
   */
  seq: number;

  /**
   * 客户提问简短摘要（50 字以内）
   */
  ask: string;

  /**
   * 回复概要或执行结论
   */
  reply: string;

  /**
   * 涉及的主子意图编码列表（如 ["CONSULT/价格"]）
   */
  intents: string[];

  /**
   * 本轮最终处理结论（如 "ANSWERED" 已解答 / "CORRECTED" 已纠正 / "HANDED_OFF" 已转人工）
   */
  result: string;
}

/**
 * 会话级事实卡（抽提上下文）
 * 
 * 业务背景：
 * - 详见方案 §5.9。每轮问答结束后由大模型重抽，作为下轮意图理解的核心 Prompt 背景输入。
 */
export interface FactCard {
  /**
   * 当前正在探讨的核心焦点产品或议题
   */
  inQuestion?: string;

  /**
   * 本会话中双方已达成共识或已确切解答的事实列表
   */
  answered: string[];

  /**
   * 尚未解决、客户提出异议或待跟进的要点列表
   */
  pending: string[];

  /**
   * 客户画像与身份核心摘要一句话（如 "王先生，问界M5潜客"）
   */
  customer?: string;
}

/**
 * 会话级“笔记本”（SessionBackground，§5.9）
 * 
 * 业务背景：
 * - 跨轮次持久化存储于 conversation_background 表并缓存在 Redis；
 * - 在每轮问答完全结束后由后台异步刷新（不占用 3 秒回复时延预算）。
 */
export interface SessionBackground {
  /**
   * 历史轮次笔记列表（按轮次先后排序，只增不减）
   */
  turns: TurnNote[];

  /**
   * 客户长期属性字典（如姓名、车型、重点关注点）
   */
  profile: Record<string, any>;

  /**
   * 客户情绪演变轨迹（按轮次记录识别到的情绪）
   */
  emotionTrack: EmotionType[];

  /**
   * 尚未解决的问题或遗留争议清单
   */
  unresolved: string[];

  /**
   * 实时同步计数器（用于实时转人工判定）
   */
  counters: SessionCounters;

  /**
   * 最新的事实卡快照
   */
  factCard: FactCard;
}

/**
 * 本会话上一次问答简报（LastTurnBrief，§5.2）
 * 
 * 业务背景：
 * - 供第 2 关接关验证快速对比。首轮为 undefined；
 * - 注意：当机器人从人工手里接回话筒时，上一组指人工刚回复完毕的问答（responder = 'HUMAN'），此时无意图便签。
 */
export interface LastTurnBrief {
  /**
   * 上一轮的实际回复方
   */
  responder: 'BOT' | 'HUMAN';

  /**
   * 上一轮客户发言原文
   */
  customerText: string;

  /**
   * 上一轮发出（机器人或人工）的回复文本
   */
  replyText: string;

  /**
   * 上一轮意图与处理便签
   * 业务边界：当 responder 为 HUMAN（人工轮）时，此项为 undefined
   */
  intentNote?: string;
}

/**
 * 敏感词检测命中项
 * 
 * 业务背景：
 * - 详见方案 §5.4。第 2 关通过 AC 自动机多模式匹配快速命中；
 * - P0 级严重敏感词命中直接阻断并转人工；P1 级记录审计日志并过滤。
 */
export interface SensitiveHit {
  /**
   * 命中的敏感词文本
   */
  word: string;

  /**
   * 敏感词风险等级
   */
  level: 'P0' | 'P1';

  /**
   * 敏感词类别（如政治、涉暴、涉黄、竞品攻击等）
   */
  category?: string;

  /**
   * 在 groupText 中的起止索引跨度 [start, end]
   */
  span?: [number, number];
}

/**
 * 接关关系判定结果
 * 
 * 业务背景：
 * - 详见方案 §5.4。模型在第 2 关单次结构化调用中输出，首轮为 undefined 或 relation=null。
 */
export interface RelationResult {
  /**
   * 判定的接关关系
   */
  relation: TurnRelation;

  /**
   * 关系判定生成的关系便签
   * 业务边界：承接时包含“上一组意图 + AI 执行结果一句话 + 本组追问点”；纠正时标记“上轮作废重查”
   */
  note?: string;

  /**
   * 判定来源：RULE（词典规则预判命中）还是 LLM（大模型语义理解）
   */
  by: 'RULE' | 'LLM';
}

/**
 * 拆解出的单一意图片段
 * 
 * 业务背景：
 * - 详见方案 §5.4。一段复杂的客户发言（如“在吗，问下延保多少钱，还有发动机保吗”）会被拆分为 1~3 个意图片段；
 * - 业务上限严格限制为 3 个；多于 3 个由代码按动作优先级截断合并。
 */
export interface IntentSpan {
  /**
   * 对应的客户发言原文片段
   */
  span: string;

  /**
   * 平台顶层六大主意图之一
   */
  main: MainIntent;

  /**
   * 规则包意图树对应的二级子意图编码
   * 业务边界：必须属于当前生效规则包的意图编码；若模型输出未定义的编码，代码层置为 null 并告警
   */
  sub: string | null;

  /**
   * 三级细分意图编码（可选）
   */
  l3?: string | null;

  /**
   * 该片段涉及的具体产品名称（用于知识检索阶段的过滤条件）
   */
  product?: string | null;

  /**
   * 意图判定的模型置信度
   * 业务范围：0.0 至 1.0 之间的数值
   */
  confidence: number;
}

/**
 * 转人工决策证据对象
 * 
 * 业务背景：
 * - 详见方案 §5.5.3。当决策层决定将当前轮次转人工时，结构化记录触发原因与证据。
 */
export interface HandoffDecision {
  /**
   * 触发转人工的类型
   */
  type: HandoffType;

  /**
   * 转人工具体原因说明
   */
  reason: string;

  /**
   * 触发依据（如命中的敏感词列表、超标的计数器值等）
   */
  evidence?: any;
}

/**
 * 决策路由方案（第 3 关「判」产物）
 * 
 * 业务背景：
 * - 详见方案 §5.5。纯代码确定性执行，根据所有意图片段按动作优先级铁律综合决出全局方案。
 */
export interface DecisionPlan {
  /**
   * 本轮聚合后的最高动作
   * 业务遵循优先级：投诉(HANDOFF) > 敏感信息 > 查询/办理 > 咨询(ANSWER) > 闲聊(FALLBACK)
   */
  action: ActionType;

  /**
   * 主答案检索与生成来源
   */
  source: AnswerSource;

  /**
   * 若触发转人工，则记录详细判定依据与理由；否则为 undefined
   */
  handoff?: HandoffDecision;

  /**
   * 目标业务人设场景名称（如 "售前顾问" / "售后管家"）
   */
  targetScene?: string;
}

/**
 * 各意图片段的底层执行答案（第 4 关「找」产物）
 * 
 * 业务背景：
 * - 详见方案 §5.6。针对每个 IntentSpan 并发调用对应的执行器（RAG/FAQ/TOOL/SCRIPT）获取。
 */
export interface SpanAnswer {
  /**
   * 对应的意图片段序号（0-based）
   */
  spanIndex: number;

  /**
   * 该片段实际调用的执行器来源
   */
  source: AnswerSource;

  /**
   * 执行获取到的直接回答文本或模板内容
   */
  text?: string;

  /**
   * RAG 知识检索命中的切片列表（包含得分与文档元数据）
   */
  chunks?: Array<{ text: string; score: number; docName?: string }>;

  /**
   * 工具接口（如 CRM 查询）返回的结构化事实列表
   */
  facts?: Array<{ field: string; value: string }>;

  /**
   * 该片段答案的置信度评分
   * 业务范围：0.0 至 1.0 之间的数值
   */
  confidence: number;
}

/**
 * 最终组织生成的回复（第 5 关「合」产物）
 * 
 * 业务背景：
 * - 详见方案 §5.7。由组织 LLM 或直接经由 FAQ/话术模板直接渲染生成。
 */
export interface ComposedReply {
  /**
   * 最终拟向客户发出的完整文本回复
   * 业务边界：严禁出现暴露 AI 身份的禁忌词；若触发转人工，末尾拼接转接提示语
   */
  text: string;

  /**
   * 整体回答置信度
   * 业务边界：等于所有 ANSWER 意图片段置信度的最小值；纯固定话术回复时置为 1.0
   */
  confidence: number;

  /**
   * 免责或不确定声明（置信度在 B~A 中间档位时按规则附加）
   */
  disclaimer?: string;

  /**
   * 是否直接走模板直出（未消耗大模型生成 Token）
   */
  templateUsed?: boolean;
}

/**
 * 末检判定结果（第 6 关「发」产物）
 * 
 * 业务背景：
 * - 详见方案 §5.8。在最终向渠道发出前，检测封组后是否有新进消息冲突。
 */
export interface FinalCheckResult {
  /**
   * 末检裁决结论：
   * - PASS：无冲突或新消息属于正常承接，正常发送本轮回复；
   * - CORRECT：新消息对本轮存在明确事实纠正，触发合并并重新进入「判」重新路由；
   * - NEW_TOPIC：新消息属于全新话题，本轮照发，新消息保留在缓冲池供下一组处理；
   * - VOID：话筒在此期间已被人工抢夺，本轮答案强制废弃。
   */
  verdict: 'PASS' | 'CORRECT' | 'NEW_TOPIC' | 'VOID';

  /**
   * 封组后新捕获到的消息明细列表
   */
  messages: MessageRef[];

  /**
   * 是否经历过纠正合并重算
   * 业务边界：单组最多允许合并重算 1 次，防止极端情况死循环
   */
  recomputed: boolean;
}

/**
 * 封组后进入主流水线的统一上下文（贯穿六道关的核心载体，§5.2）
 * 
 * 业务生命周期：
 * 1. 第 1 关「收」：缓冲池静默超时或条数满额时创建此对象，填充基础 ID、groupText、groupMessages 与 customer；
 * 2. 第 2 关「拆」：填充 sensitive、relation、intents；
 * 3. 第 3 关「判」：填充 decision；
 * 4. 第 4 关「找」：填充 answers；
 * 5. 第 5 关「合」：填充 reply；
 * 6. 第 6 关「发」：填充 finalCheck 与 timings，执行最终发出并归档。
 */
export interface TurnContext {
  /**
   * 全链路分布式追踪 ID
   * 业务边界：标准 UUIDv4 字符串，穿透所有内部微服务、MQ 事件与日志落盘
   */
  traceId: string;

  /**
   * 所属企业租户 ID（业务范围: > 0）
   */
  tenantId: number;

  /**
   * 关联的会话主键 ID（对应 conversation 表）
   */
  conversationId: number;

  /**
   * 当前轮次主键 ID（对应 turn 表）
   */
  turnId: number;

  /**
   * 聚合消息组主键 ID（对应 message_group 表）
   */
  groupId: number;

  /**
   * 是否为当前会话的第一轮（turn.seq === 1）
   * 业务边界：首轮强制无接关对比，跳过接关验证逻辑
   */
  isFirstTurn: boolean;

  /**
   * 封组后组内所有消息按发送时间升序拼接的完整文本
   * 业务边界：组内以中文逗号连接，图片以 [图片] 占位
   */
  groupText: string;

  /**
   * 组内引用的单条消息记录清单（单组 1 ~ 20 条）
   */
  groupMessages: MessageRef[];

  /**
   * 客户身份与 CRM 画像装配结果（TTL 内在会话层缓存复用）
   */
  customer: CustomerProfile;

  /**
   * 会话级“笔记本”（§5.9），记录历史要点、计数器与事实卡
   */
  background: SessionBackground;

  /**
   * 本会话上一次已完成问答的简要快照
   * 业务边界：首轮为 undefined；非首轮必填。人工回复轮 responder 为 'HUMAN' 且无意图便签
   */
  lastTurn?: LastTurnBrief;

  /**
   * 当前轮次生效的规则包版本号（如 "v1.0.0"），保障整轮规则、提示词与参数严格受控
   */
  rulePackVersion: string;

  /**
   * 封组时刻的时间戳（毫秒），供第 6 关末检（FinalCheck）嗅探增量消息的分界点（§5.8.1）
   */
  sealedAt?: number;

  /**
   * 末检合并重算次数（业务上限 1 次，防死循环，§5.8.1）
   */
  mergeCount?: number;

  // ---------------------------------------------------------------------------
  // 以下字段由各流水线关卡逐步处理并填充
  // ---------------------------------------------------------------------------

  /**
   * 第 2 关产物：敏感词检测命中清单（无命中时为 undefined）
   */
  sensitive?: SensitiveHit[];

  /**
   * 第 2 关产物：接关关系判定结果（首轮为 undefined）
   */
  relation?: RelationResult;

  /**
   * 第 2 关产物：意图片段拆分列表（业务上限 3 个）
   */
  intents?: IntentSpan[];

  /**
   * 第 3 关产物：确定性决策路由方案
   */
  decision?: DecisionPlan;

  /**
   * 第 4 关产物：各片段执行器执行得到的答案明细
   */
  answers?: SpanAnswer[];

  /**
   * 第 5 关产物：最终组装的回复文本与置信度
   */
  reply?: ComposedReply;

  /**
   * 第 6 关产物：末检裁决结果
   */
  finalCheck?: FinalCheckResult;

  /**
   * 流水线各环节耗时毫秒统计字典（如 { understand: 450, retrieve: 320, compose: 510 }）
   * 业务边界：落库 turn 表用于考核 SLA 履约率与时延瓶颈诊断
   */
  timings: Record<string, number>;
}
