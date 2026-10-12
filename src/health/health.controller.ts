import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { MysqlService } from '../database/mysql.service';

@Controller('health')
export class HealthController {
  constructor(private readonly mysql: MysqlService) {}

  @Get()
  async check() {
    const result = { service: 'agent-app', mysql: (await this.mysql.ping()) ? 'up' : 'down' };
    if (result.mysql !== 'up') throw new ServiceUnavailableException(result);
    return result;
  }
}
