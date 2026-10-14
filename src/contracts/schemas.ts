/**
 * @file schemas.ts
 * @description 大模型结构化输出的 Zod 运行时验证契约
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.4 第 2 关「拆」：理解
 */

import { z } from 'zod';
import {
  MAIN_INTENT,
  MainIntent,
  TURN_RELATION,
  TurnRelation,
  EMOTION_TYPE,
  EmotionType,
} from './enums';

const mainIntentKeys = Object.keys(MAIN_INTENT) as [MainIntent, ...MainIntent[]];
const turnRelationKeys = Object.keys(TURN_RELATION) as [TurnRelation, ...TurnRelation[]];
const emotionTypeKeys = Object.keys(EMOTION_TYPE) as [EmotionType, ...EmotionType[]];

/**
 * 单一意图片段结构校验 Schema（§5.4）
 * 
 * 业务背景：
 * - 针对大模型单次结构化输出中的 intents 数组项进行严格校验；
 * - confidence 必须限定在 [0.0, 1.0] 的数学概率区间；
 * - sub 与 l3 允许为 null，当大模型输出未知意图时业务层会自动置 null 并记录告警。
 */
export const IntentSpanSchema = z.object({
  /**
   * 原文对应的客户输入片段
   */
  span: z.string().min(1, '意图片段文本不能为空'),

  /**
   * 平台顶层六大主意图类别（绑定 MAIN_INTENT 元数据）
   */
  main: z.enum(mainIntentKeys, {
    errorMap: () => ({ message: '主意图必须属于平台锁定的六大类别之一' }),
  }),

  /**
   * 规则包意图树对应的二级子意图编码
   * 业务边界：必须为规则包定义的合法编码，未知时由大模型输出 null
   */
  sub: z.string().nullable(),

  /**
   * 三级细分意图编码（可选）
   */
  l3: z.string().nullable().optional(),

  /**
   * 该片段涉及的具体产品名称（用于下游知识检索过滤）
   */
  product: z.string().nullable().optional(),

  /**
   * 模型判定置信度
   * 业务范围：严格限制在 0.0 至 1.0 之间
   */
  confidence: z
    .number()
    .min(0, '置信度下限为 0.0')
    .max(1, '置信度上限为 1.0'),
});

export type IntentSpanDto = z.infer<typeof IntentSpanSchema>;

/**
 * 第 2 关大模型「意图理解 + 接关合并」结构化输出校验 Schema（§5.4）
 * 
 * 业务背景：
 * - 为什么接关和意图合并为一次 LLM 调用：PRD 中串行两次调用会消耗 1.5s+，合并后语义等价、时延减半；
 * - 模型在同一上下文中先判定接关关系、再结合背景做意图拆分；
 * - 首轮时 relation 为 null；
 * - intents 校验放宽到 6 条，超过 3 个片段的部分由业务代码按动作优先级截断，避免校验直接失败引发多余重试。
 */
export const UnderstandOutputSchema = z.object({
  /**
   * 判定与上一轮问答的承接关系（绑定 TURN_RELATION 元数据）
   * 业务边界：首轮时必须为 null；非首轮必填四类关系之一
   */
  relation: z.enum(turnRelationKeys).nullable(),

  /**
   * 关系便签说明
   * 业务边界：承接时为“上一组意图 + AI 执行结果一句话 + 本组追问点”；纠正时为“上轮作废重查”
   */
  relation_note: z.string().nullable().optional(),

  /**
   * 拆解出的意图片段列表
   * 业务边界：至少 1 个片段；模型输出允许最多 6 个（由下游代码截断保留前 3 个）
   */
  intents: z
    .array(IntentSpanSchema)
    .min(1, '至少拆分出 1 个意图片段')
    .max(6, '意图片段数超出最大容错上限 6'),

  /**
   * 客户情绪识别结论（绑定 EMOTION_TYPE 元数据）
   * 业务边界：V1.0.0 仅用于落库记录与写入会话“笔记本”的情绪演变轨迹，不直接驱动动作跳转
   */
  emotion: z.enum(emotionTypeKeys, {
    errorMap: () => ({ message: '情绪必须属于五类预设情感之一' }),
  }),
});

export type UnderstandOutputDto = z.infer<typeof UnderstandOutputSchema>;
