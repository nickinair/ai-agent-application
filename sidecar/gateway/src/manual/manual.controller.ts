import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { ManualService } from './manual.service';
import type { ApiCatalogResponse, ApiManualItem } from './manual.types';

@Controller('api')
export class ManualController {
  constructor(private readonly manualService: ManualService) {}

  /**
   * 网关根 API 入口
   * 1. 无参请求返回全量接口目录
   * 2. 携带 ?index= 返回目标接口的出入参详尽规范
   */
  @Get()
  async getRoot(
    @Query('index') index?: string,
  ): Promise<{ success: boolean; data: ApiCatalogResponse | ApiManualItem }> {
    if (index !== undefined && index.trim() !== '') {
      return this.handleItemQuery(index.trim());
    }
    return {
      success: true,
      data: this.manualService.getCatalog(),
    };
  }

  /**
   * 网关接口手册标准入口
   * 支持 ?index= 过滤
   */
  @Get('manual')
  async getManual(
    @Query('index') index?: string,
  ): Promise<{ success: boolean; data: ApiCatalogResponse | ApiManualItem }> {
    if (index !== undefined && index.trim() !== '') {
      return this.handleItemQuery(index.trim());
    }
    return {
      success: true,
      data: this.manualService.getCatalog(),
    };
  }

  /**
   * 路径参数化查询单接口手册
   * 如: GET /api/manual/1 或 GET /api/manual/register
   */
  @Get('manual/:index')
  async getManualByIndex(
    @Param('index') index: string,
  ): Promise<{ success: boolean; data: ApiManualItem }> {
    return this.handleItemQuery(index.trim());
  }

  /**
   * 处理单接口查询与 404 容错
   */
  private handleItemQuery(
    indexQuery: string,
  ): { success: boolean; data: ApiManualItem } {
    const item = this.manualService.getItemByIndex(indexQuery);
    if (!item) {
      const catalog = this.manualService.getCatalog();
      throw new NotFoundException(
        `未找到索引或标识为 [${indexQuery}] 的接口手册。可先访问 GET /api 查看有效接口清单 (序号范围: 1 ~ ${catalog.total})`,
      );
    }

    return {
      success: true,
      data: item,
    };
  }
}
