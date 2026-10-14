import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { RegistryService } from './registry.service';
import type { HeartbeatDto, RegisterInstanceDto, ServiceInstance } from './registry.types';

@Controller('api/registry')
export class RegistryController {
  constructor(private readonly registryService: RegistryService) {}

  /**
   * 注册服务实例
   */
  @Post('register')
  @HttpCode(HttpStatus.OK)
  async register(@Body() dto: RegisterInstanceDto): Promise<{ success: boolean; data: ServiceInstance }> {
    const data = await this.registryService.register(dto);
    return { success: true, data };
  }

  /**
   * 心跳续约
   */
  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  async heartbeat(@Body() dto: HeartbeatDto): Promise<{ success: boolean; data?: ServiceInstance }> {
    const res = await this.registryService.heartbeat(dto);
    return {
      success: res.success,
      data: res.instance,
    };
  }

  /**
   * 主动注销服务实例
   */
  @Post('deregister')
  @HttpCode(HttpStatus.OK)
  async deregister(
    @Body() body: { instanceId: string; serviceName?: string },
  ): Promise<{ success: boolean }> {
    const success = await this.registryService.deregister(body.instanceId, body.serviceName);
    return { success };
  }

  /**
   * 获取所有存活服务名称
   */
  @Get('services')
  async getServices(): Promise<{ success: boolean; data: string[] }> {
    const data = await this.registryService.getServices();
    return { success: true, data };
  }

  /**
   * 获取某服务下的所有可用实例
   */
  @Get('instances/:serviceName')
  async getInstances(
    @Param('serviceName') serviceName: string,
  ): Promise<{ success: boolean; data: ServiceInstance[] }> {
    const data = await this.registryService.getInstances(serviceName);
    return { success: true, data };
  }

  /**
   * 获取单个实例详情
   */
  @Get('instance/:instanceId')
  async getInstance(
    @Param('instanceId') instanceId: string,
  ): Promise<{ success: boolean; data: ServiceInstance }> {
    const data = await this.registryService.getInstance(instanceId);
    if (!data) {
      throw new NotFoundException(`实例 ${instanceId} 不存在或已过期下线`);
    }
    return { success: true, data };
  }
}
