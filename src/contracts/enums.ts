/**
 * @file enums.ts
 * @description 智能体全能平台核心业务元数据字典与联合类型定义
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.2、§5.4、§5.5、§6.1、§6.2、§11.3
 */

// =============================================================================
// 1. 渠道与身份
// =============================================================================

/**
 * 渠道类型元数据常量字典
 */
export const CHANNEL_TYPE = {
  /** 企微外部客户群 */
  wecom_group: {
    label: '企微外部群',
    desc: '企业微信外部客户群，主要服务场景，支持全量消息感知与会话存档',
  },
  /** 企微单聊客服 */
  wecom_single: {
    label: '企微单聊',
    desc: '企业微信一对一客服单聊场景',
  },
  /** 仿真模拟器 */
  simulator: {
    label: '仿真模拟器',
    desc: '开发与仿真测试模拟渠道',
  },
  /** 测试注入接口 */
  test: {
    label: '测试注入',
    desc: '自动化测试与测试注入接口专用',
  },
} as const;

/**
 * 入站消息来源渠道类型
 * @see CHANNEL_TYPE
 */
export type ChannelType = keyof typeof CHANNEL_TYPE;

/**
 * 群成员身份角色元数据常量字典（四层识别机制，§11.3）
 */
export const MEMBER_ROLE = {
  /** 外部客户 */
  CUSTOMER: {
    label: '外部客户',
    desc: '群内微信或企微外部联系人客户，发言进入消息缓冲池并触发机器人问答',
  },
  /** 专职客服 */
  STAFF_CS: {
    label: '专职客服',
    desc: '群内企业专职客服人员，发言触发话筒抢夺与转人工流程',
  },
  /** 内部其他人员 */
  STAFF_OTHER: {
    label: '内部其他人员',
    desc: '群内企业非客服岗位员工（如销售、技术支持、管理员等）',
  },
  /** 生态伙伴 */
  PARTNER: {
    label: '生态伙伴',
    desc: '外部第三方合作伙伴或供应商成员',
  },
  /** 智能体机器人 */
  BOT: {
    label: '智能体机器人',
    desc: '本系统接入的智能客服机器人自身',
  },
} as const;

/**
 * 群成员身份角色类型
 * @see MEMBER_ROLE
 */
export type MemberRole = keyof typeof MEMBER_ROLE;

/**
 * 消息物理内容类型元数据常量字典
 */
export const MESSAGE_TYPE = {
  /** 纯文本 */
  text: {
    label: '文本',
    desc: '纯文本消息',
  },
  /** 图片 */
  image: {
    label: '图片',
    desc: '图片富媒体消息，封组时占位或走多模态理解',
  },
  /** 语音 */
  voice: {
    label: '语音',
    desc: '语音音频消息，经语音识别转写为文字',
  },
  /** 文件 */
  file: {
    label: '文件',
    desc: '文档、表格或附件文件',
  },
  /** 未分类其他 */
  other: {
    label: '其他',
    desc: '位置、小程序卡片等未分类富媒体消息',
  },
} as const;

/**
 * 消息物理内容类型
 * @see MESSAGE_TYPE
 */
export type MessageType = keyof typeof MESSAGE_TYPE;

/**
 * 会话发言权话筒归属元数据常量字典（§6.2）
 */
export const MIC_HOLDER = {
  /** 机器人持有话筒 */
  BOT: {
    label: '机器人持有',
    desc: '话筒在机器人手中，客户消息由 AI 聚合处理并自动应答',
  },
  /** 人工客服持有话筒 */
  HUMAN: {
    label: '人工持有',
    desc: '话筒在人工客服手中，AI 停止自动回复并作废在途答案',
  },
} as const;

/**
 * 会话话筒归属方类型
 * @see MIC_HOLDER
 */
export type MicHolder = keyof typeof MIC_HOLDER;

// =============================================================================
// 2. 流水线核心处理关卡（拆、判、找、合）
// =============================================================================

/**
 * 问答接关关系元数据常量字典（第 2 关「拆」，§5.4）
 */
export const TURN_RELATION = {
  /** 承接追问 */
  CONTINUE: {
    label: '承接',
    desc: '对上一轮话题的追问或补充，继承上一轮意图与关系便签',
  },
  /** 事实纠正 */
  CORRECT: {
    label: '纠正',
    desc: '明确否定上轮答案或指出理解偏差，累计挫败计数并标记上轮作废重查',
  },
  /** 切换话题 */
  NEW_TOPIC: {
    label: '换题',
    desc: '发起全新的独立话题，清空关系便签，仅保留会话级长期事实卡',
  },
  /** 礼貌收尾 */
  CLOSE: {
    label: '收尾',
    desc: '客户发送致谢或结束语，直接回复固定收尾语完结本轮',
  },
} as const;

/**
 * 问答接关关系类型
 * @see TURN_RELATION
 */
export type TurnRelation = keyof typeof TURN_RELATION;

/**
 * 平台六大核心主意图元数据常量字典（§5.4、§5.5.1）
 */
export const MAIN_INTENT = {
  /** 业务咨询 */
  CONSULT: {
    label: '咨询',
    desc: '产品功能、价格与条款咨询，主走知识库 RAG 问答',
    defaultAction: 'ANSWER',
    defaultSource: 'RAG',
  },
  /** 信息查询 */
  QUERY: {
    label: '查询',
    desc: '订单、保单状态与权益查询，主走 CRM 工具，答后转人工',
    defaultAction: 'ANSWER',
    defaultSource: 'TOOL',
  },
  /** 业务办理 */
  HANDLE: {
    label: '办理',
    desc: '退保、理赔与业务办理诉求，回复固定引导话术并转人工',
    defaultAction: 'GUIDE',
    defaultSource: 'SCRIPT',
  },
  /** 客户投诉 */
  COMPLAINT: {
    label: '投诉',
    desc: '客户情绪激化与投诉，立即触发安抚话术并强转人工',
    defaultAction: 'HANDOFF',
    defaultSource: 'SCRIPT',
  },
  /** 异议处理 */
  OBJECTION: {
    label: '异议',
    desc: '对价格或条款产生异议，走异议处理标准 FAQ',
    defaultAction: 'ANSWER',
    defaultSource: 'FAQ',
  },
  /** 寒暄闲聊 */
  CHITCHAT: {
    label: '闲聊',
    desc: '寒暄与无关闲聊，走闲聊兜底话术，不消耗检索资源',
    defaultAction: 'FALLBACK',
    defaultSource: 'SCRIPT',
  },
} as const;

/**
 * 平台六大核心主意图类型
 * @see MAIN_INTENT
 */
export type MainIntent = keyof typeof MAIN_INTENT;

/**
 * 平台决策动作类型元数据常量字典（第 3 关「判」，§5.5.1）
 */
export const ACTION_TYPE = {
  /** 直接回答 */
  ANSWER: {
    label: '直接回答',
    desc: '由 RAG/FAQ/TOOL 执行器给出答案内容',
    priority: 2,
  },
  /** 引导办理 */
  GUIDE: {
    label: '引导办理',
    desc: '输出固定引导话术，指导客户下一步操作',
    priority: 3,
  },
  /** 转接人工 */
  HANDOFF: {
    label: '转接人工',
    desc: '触发转人工流程，由客服坐席接管',
    priority: 5,
  },
  /** 闲聊兜底 */
  FALLBACK: {
    label: '闲聊兜底',
    desc: '输出通用礼貌或闲聊兜底话术',
    priority: 1,
  },
} as const;

/**
 * 平台决策动作类型
 * @see ACTION_TYPE
 */
export type ActionType = keyof typeof ACTION_TYPE;

/**
 * 答案与知识执行来源元数据常量字典（第 4 关「找」，§5.5.1、§5.6）
 */
export const ANSWER_SOURCE = {
  /** RAG 知识检索 */
  RAG: {
    label: '知识库检索',
    desc: '通过分块检索与 Rerank 获取文档内容',
  },
  /** 标准 FAQ 匹配 */
  FAQ: {
    label: '问答对匹配',
    desc: '标准问答对精确/语义匹配直出',
  },
  /** 确定性固定话术 */
  SCRIPT: {
    label: '固定话术',
    desc: '规则包配置的确定性固定话术（支持变量渲染）',
  },
  /** 业务系统工具 */
  TOOL: {
    label: '业务系统工具',
    desc: '调用外部系统 API（如 CRM 客户/订单数据）',
  },
  /** 价目表矩阵 */
  PRICE_LIST: {
    label: '价目表',
    desc: '产品、车型、年限价格矩阵查询',
  },
  /** 多轮任务流 */
  FLOW: {
    label: '多轮任务流',
    desc: '预留多轮复杂任务流编排引擎',
  },
} as const;

/**
 * 答案与知识执行来源类型
 * @see ANSWER_SOURCE
 */
export type AnswerSource = keyof typeof ANSWER_SOURCE;

/**
 * 转人工触发原因类型元数据常量字典（§5.5.3）
 */
export const HANDOFF_TYPE = {
  /** 严重敏感词 */
  SENSITIVE: {
    label: '敏感信息',
    desc: '命中 P0 级严重敏感词，直接阻断并转人工',
  },
  /** 业务意图触发 */
  INTENT: {
    label: '业务意图',
    desc: '识别到投诉、办理或查询类转人工意图',
  },
  /** 客户挫败累计 */
  FRUSTRATION: {
    label: '客户挫败',
    desc: '会话内纠正次数达到挫败阈值（总纠正≥3 或 连续纠正≥2）',
  },
  /** 知识盲区 */
  BLIND_SPOT: {
    label: '知识盲区',
    desc: '连续多轮检索置信度过低（低于阈值 B）',
  },
} as const;

/**
 * 转人工触发原因类型
 * @see HANDOFF_TYPE
 */
export type HandoffType = keyof typeof HANDOFF_TYPE;

// =============================================================================
// 3. 状态机与情感感知（§6.1、§5.4）
// =============================================================================

/**
 * 会话级生命周期状态元数据常量字典（§6.1 第一层）
 */
export const CONVERSATION_STATUS = {
  /** 排队等待中 */
  QUEUED: {
    label: '排队中',
    desc: '客户发起会话且达到企业并发接待上限时排队等待',
  },
  /** 进行中 */
  ACTIVE: {
    label: '进行中',
    desc: '获得接待名额，正在进行正常多轮问答',
  },
  /** 已结束 */
  ENDED: {
    label: '已结束',
    desc: '所有轮次完结且因空闲超时或人工主动关闭而结束',
  },
} as const;

/**
 * 会话级生命周期状态
 * @see CONVERSATION_STATUS
 */
export type ConversationStatus = keyof typeof CONVERSATION_STATUS;

/**
 * 问答轮次生命周期状态元数据常量字典（§6.1 第二层）
 */
export const TURN_STATUS = {
  /** 处理中 */
  IN_PROGRESS: {
    label: '进行中',
    desc: '本轮消息正在流水线中处理',
  },
  /** 已完成 */
  DONE: {
    label: '已完成',
    desc: '本轮回复已发出或由人工处理完毕',
  },
} as const;

/**
 * 问答轮次生命周期状态
 * @see TURN_STATUS
 */
export type TurnStatus = keyof typeof TURN_STATUS;

/**
 * 消息聚合组处理流转状态元数据常量字典（§6.1 第三层）
 */
export const GROUP_STATUS = {
  /** 缓冲池收集中 */
  COLLECTING: {
    label: '收集中',
    desc: '缓冲池收集中，等待静默超时（3s）或条数满额封组',
  },
  /** 流水线理解中 */
  UNDERSTANDING: {
    label: '理解中',
    desc: '封组完毕，流水线执行意图拆分、检索与组织',
  },
  /** 末检查核中 */
  FINAL_CHECKING: {
    label: '末检中',
    desc: '发送前最后检查是否有新消息或关键冲突',
  },
  /** 已推送出站 */
  SENT: {
    label: '已发出',
    desc: '通过末检与话筒校验，已成功推送出站',
  },
  /** 人工处理归档 */
  ARCHIVED: {
    label: '已归档',
    desc: '话筒在人工手中且人工已在群内回复，组自动归档',
  },
  /** 在途答案作废 */
  VOIDED: {
    label: '已作废',
    desc: '话筒在发出瞬间被人工抢走，生成的答案作废不发',
  },
} as const;

/**
 * 消息聚合组处理流转状态
 * @see GROUP_STATUS
 */
export type GroupStatus = keyof typeof GROUP_STATUS;

/**
 * 客户情绪类型元数据常量字典（§5.4、§5.9）
 */
export const EMOTION_TYPE = {
  /** 平静 */
  calm: {
    label: '平静',
    desc: '语气平和，正常咨询',
  },
  /** 困惑 */
  confused: {
    label: '困惑',
    desc: '对业务条款或解释存在疑问',
  },
  /** 焦虑 */
  anxious: {
    label: '焦虑',
    desc: '急切想得到解答或解决问题',
  },
  /** 不满 */
  dissatisfied: {
    label: '不满',
    desc: '表达抱怨、质疑或异议',
  },
  /** 愤怒 */
  angry: {
    label: '愤怒',
    desc: '强烈不满，投诉甚至情绪爆发',
  },
} as const;

/**
 * 客户情绪类型
 * @see EMOTION_TYPE
 */
export type EmotionType = keyof typeof EMOTION_TYPE;
