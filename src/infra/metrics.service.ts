/**
 * @file metrics.service.ts
 * @description 智能体全能平台核心 Prometheus 指标埋点服务 (附录 C 用例 S7, Task 4.5)
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.8.1、§14 监控与运维
 */

import { Injectable, Logger } from '@nestjs/common';

export type VoidReason =
  | 'MIC_SEIZED'
  | 'RECOMPUTE_ABANDONED'
  | 'RULE_BLOCKED'
  | string;

export interface MetricLabels {
  reason?: VoidReason;
  tenant_id?: string | number;
  channel?: string;
  [key: string]: any;
}

/**
 * 轻量自研 Prometheus Counter 计数器实现
 */
export class MetricCounter {
  private readonly values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = [],
  ) {}

  private serializeLabels(labels: MetricLabels): string {
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) return '';
    return keys.map((k) => `${k}="${labels[k]}"`).join(',');
  }

  /**
   * 计数递增
   */
  inc(labels: MetricLabels = {}, value = 1): void {
    const key = this.serializeLabels(labels);
    const cur = this.values.get(key) || 0;
    this.values.set(key, cur + value);
  }

  /**
   * 读取指定标签维度的累计计数值
   */
  get(labels: MetricLabels = {}): number {
    const key = this.serializeLabels(labels);
    return this.values.get(key) || 0;
  }

  /**
   * 获取所有标签维度的数值映射
   */
  getAll(): Map<string, number> {
    return new Map(this.values);
  }

  /**
   * 重置计数器（主要用于单元测试前后隔离）
   */
  reset(): void {
    this.values.clear();
  }

  /**
   * 导出标准 Prometheus 纯文本展示格式
   */
  toPrometheusText(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [labelStr, val] of this.values.entries()) {
        if (labelStr) {
          lines.push(`${this.name}{${labelStr}} ${val}`);
        } else {
          lines.push(`${this.name} ${val}`);
        }
      }
    }
    return lines.join('\n');
  }
}

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  /**
   * 轮次生成未发出作废指标计数器 (Task 4.5)
   * 标签: reason (MIC_SEIZED / RECOMPUTE_ABANDONED / RULE_BLOCKED), tenant_id
   */
  public readonly turnVoidedTotal = new MetricCounter(
    'agent_turn_voided_total',
    'Total count of voided AI turns that generated reply but were not sent',
    ['reason', 'tenant_id'],
  );

  /**
   * 记录轮次作废指标
   * @param reason 作废原因 ('MIC_SEIZED' | 'RECOMPUTE_ABANDONED' | 'RULE_BLOCKED' | string)
   * @param tenantId 企业租户 ID
   * @param count 递增数量（默认 1）
   */
  recordTurnVoided(
    reason: VoidReason,
    tenantId: number | string = 1,
    count = 1,
  ): void {
    this.turnVoidedTotal.inc({ reason, tenant_id: String(tenantId) }, count);
    this.logger.log(
      `📊 [Metrics] 记录 turn 作废指标: reason=${reason}, tenant_id=${tenantId}, count=${count}`,
    );
  }

  /**
   * 获取所有注册的 Prometheus 指标文本内容
   */
  getMetricsAsText(): string {
    return [this.turnVoidedTotal.toPrometheusText()].join('\n\n') + '\n';
  }
}
