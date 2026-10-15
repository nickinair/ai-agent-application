/**
 * @file customer-context.service.ts
 * @description 群名称正则解析器与 CRM 客户上下文预取集成服务
 * @reference 《智能体全能平台-V1.0.0-技术开发方案》 §5.3、§11.2
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import type { CustomerProfile, VehicleProfile, BoughtProduct } from '../../contracts';

export interface GroupNameParseResult {
  name?: string;
  phone?: string;
  phoneMasked?: string;
  vehicle?: string;
  product?: string;
  bought?: boolean;
}

export interface CrmCustomerContextResponse {
  customer?: {
    id: number;
    name?: string;
    gender?: string;
    phoneMasked?: string;
  };
  vehicles?: Array<{
    brand?: string;
    model?: string;
    vinMasked?: string;
    purchaseDate?: string;
  }>;
  orders?: Array<{
    orderCode: string;
    status: string;
    createdAt?: number;
    items?: Array<{
      productName: string;
      productType?: string;
      salePrice?: number;
    }>;
  }>;
  purchasedProducts?: string[];
}

@Injectable()
export class CustomerContextService {
  private readonly logger = new Logger(CustomerContextService.name);

  /**
   * 默认群名解析模板列表（按优先级由高到低匹配）
   * 精确按段数与末段特征匹配，避免贪婪或可选歧义
   */
  private readonly defaultPatterns: RegExp[] = [
    // 5 段: 姓名-手机-车型-产品-(已购|未购)
    /^(?<name>[^-]+)-(?<phone>1\d{10})-(?<vehicle>[^-]+)-(?<product>[^-]+)-(?<bought>已购|未购)$/,
    // 4 段且末段为购买状态: 姓名-手机-产品-(已购|未购) (技术方案 §5.3)
    /^(?<name>[^-]+)-(?<phone>1\d{10})-(?<product>[^-]+)-(?<bought>已购|未购)$/,
    // 4 段且末段为产品: 姓名-手机-车型-产品
    /^(?<name>[^-]+)-(?<phone>1\d{10})-(?<vehicle>[^-]+)-(?<product>[^-]+)$/,
    // 3 段且末段包含产品特征词: 姓名-手机-产品 (如: 赵女士-13900001111-整车延保)
    /^(?<name>[^-]+)-(?<phone>1\d{10})-(?<product>[^-]*(?:延保|保|险|套餐|桩|服务)[^-]*)$/,
    // 3 段: 姓名-手机-车型
    /^(?<name>[^-]+)-(?<phone>1\d{10})-(?<vehicle>[^-]+)$/,
    // 兜底提取手机号与姓名
    /^(?<name>[^-]+)-(?<phone>1\d{10})$/,
  ];

  constructor(@Inject(ENV) private readonly env: Env) {}

  /**
   * 掩码手机号（中段 4 位打码）
   */
  maskPhone(phone: string): string {
    if (!phone || phone.length < 11) return phone;
    return phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
  }

  /**
   * 正则匹配企微群名，提取客户基础属性
   * @param chatName 企微群聊原始名称
   */
  parseGroupName(chatName?: string): GroupNameParseResult {
    if (!chatName) return {};

    const trimmed = chatName.trim();
    for (const pattern of this.defaultPatterns) {
      const match = pattern.exec(trimmed);
      if (match?.groups) {
        const groups = match.groups;
        const phone = groups.phone;
        const phoneMasked = phone ? this.maskPhone(phone) : undefined;
        let bought: boolean | undefined = undefined;

        if (groups.bought === '已购') bought = true;
        if (groups.bought === '未购') bought = false;

        return {
          name: groups.name?.trim(),
          phone,
          phoneMasked,
          vehicle: groups.vehicle?.trim(),
          product: groups.product?.trim(),
          bought,
        };
      }
    }

    return {};
  }

  /**
   * 调用 CRM 开放接口预取客户详细画像（车辆、订单、已购商品）
   * 严格遵循方案 §11.2：硬超时 800ms，带 X-Agent-Token，异常降级不阻塞
   * @param phone 客户明文手机号
   */
  async fetchCrmContext(phone: string): Promise<CrmCustomerContextResponse | null> {
    if (!phone) return null;

    const url = new URL('/api/open/agent/customer-context', this.env.CRM_BASE_URL);
    url.searchParams.set('phone', phone);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.env.CRM_TIMEOUT_MS);

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'X-Agent-Token': this.env.CRM_SERVICE_TOKEN,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          `CRM 返回非 200 响应码: ${response.status} ${response.statusText} [phone=${this.maskPhone(phone)}]`,
        );
        return null;
      }

      const json = (await response.json()) as CrmCustomerContextResponse;
      return json;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this.logger.warn(`调 CRM 接口超时 (超过 ${this.env.CRM_TIMEOUT_MS}ms)，执行熔断降级`);
      } else {
        this.logger.warn(`调用 CRM 接口异常: ${err.message}`);
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 装配客户完整画像模型（CustomerProfile）
   * 结合群名解析结果与 CRM 查询快照进行交叉补全
   */
  async assembleCustomerProfile(chatName?: string): Promise<CustomerProfile> {
    const parsed = this.parseGroupName(chatName);

    let crmData: CrmCustomerContextResponse | null = null;
    if (parsed.phone) {
      crmData = await this.fetchCrmContext(parsed.phone);
    }

    const customerName = crmData?.customer?.name || parsed.name || '客户';
    const phoneMasked = crmData?.customer?.phoneMasked || parsed.phoneMasked;

    // 车辆列表构建
    const vehicles: VehicleProfile[] = [];
    if (crmData?.vehicles && crmData.vehicles.length > 0) {
      for (const v of crmData.vehicles) {
        vehicles.push({
          brand: v.brand,
          model: v.model || parsed.vehicle || '',
          vinMasked: v.vinMasked,
          purchaseDate: v.purchaseDate,
        });
      }
    } else if (parsed.vehicle) {
      vehicles.push({
        model: parsed.vehicle,
      });
    }

    // 已购商品列表构建
    const boughtProducts: BoughtProduct[] = [];
    if (crmData?.orders) {
      for (const order of crmData.orders) {
        if (order.items) {
          for (const item of order.items) {
            boughtProducts.push({
              productName: item.productName,
              boughtAt: order.createdAt,
              price: item.salePrice,
            });
          }
        }
      }
    }

    // 是否已购判定：CRM 真实保单/订单记录事实优先级最高；若 CRM 未查得再回退群名称
    let bought: boolean | undefined = undefined;
    if (boughtProducts.length > 0 || (crmData?.purchasedProducts && crmData.purchasedProducts.length > 0)) {
      bought = true;
    } else if (parsed.bought !== undefined) {
      bought = parsed.bought;
    } else {
      bought = false;
    }

    return {
      name: customerName,
      phone: parsed.phone,
      phoneMasked,
      vehicle: vehicles[0]?.model || parsed.vehicle,
      product: parsed.product,
      bought,
      vehicles: vehicles.length > 0 ? vehicles : undefined,
      boughtProducts: boughtProducts.length > 0 ? boughtProducts : undefined,
    };
  }
}
