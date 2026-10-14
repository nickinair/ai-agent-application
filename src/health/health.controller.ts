import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/tenant-context';
import { MysqlService } from '../database/mysql.service';

@Public()
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
