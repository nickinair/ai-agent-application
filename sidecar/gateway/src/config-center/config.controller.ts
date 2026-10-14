import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ConfigService } from './config.service';
import type { BatchSetConfigDto, ConfigItem, SetConfigDto } from './config.types';

@Controller('api/config')
export class ConfigController {
  constructor(private readonly configService: ConfigService) {}

  /**
   * 获取所有命名空间
   */
  @Get('namespaces')
  async listNamespaces(): Promise<{ success: boolean; data: string[] }> {
    const data = await this.configService.listNamespaces();
    return { success: true, data };
  }

  /**
   * 获取某命名空间下的全量配置字典
   */
  @Get(':namespace')
  async getAll(
    @Param('namespace') namespace: string,
  ): Promise<{ success: boolean; data: Record<string, unknown> }> {
    const data = await this.configService.getAll(namespace);
    return { success: true, data };
  }

  /**
   * 获取特定配置项
   */
  @Get(':namespace/:key')
  async get(
    @Param('namespace') namespace: string,
    @Param('key') key: string,
  ): Promise<{ success: boolean; data: ConfigItem }> {
    const data = await this.configService.get(namespace, key);
    if (!data) {
      throw new NotFoundException(`配置项不存在: ${namespace}.${key}`);
    }
    return { success: true, data };
  }

  /**
   * 设置/更新单项配置
   */
  @Post(':namespace')
  @HttpCode(HttpStatus.OK)
  async set(
    @Param('namespace') namespace: string,
    @Body() dto: SetConfigDto,
  ): Promise<{ success: boolean; data: ConfigItem }> {
    const data = await this.configService.set(
      namespace,
      dto.key,
      dto.value,
      dto.comment,
    );
    return { success: true, data };
  }

  /**
   * 批量更新配置
   */
  @Post(':namespace/batch')
  @HttpCode(HttpStatus.OK)
  async batchSet(
    @Param('namespace') namespace: string,
    @Body() dto: BatchSetConfigDto,
  ): Promise<{ success: boolean; data: Record<string, unknown> }> {
    const data = await this.configService.batchSet(
      namespace,
      dto.configs,
      dto.comment,
    );
    return { success: true, data };
  }

  /**
   * 删除配置项
   */
  @Delete(':namespace/:key')
  @HttpCode(HttpStatus.OK)
  async delete(
    @Param('namespace') namespace: string,
    @Param('key') key: string,
  ): Promise<{ success: boolean }> {
    const success = await this.configService.delete(namespace, key);
    return { success };
  }
}
