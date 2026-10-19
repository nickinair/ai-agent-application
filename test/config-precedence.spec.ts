/**
 * 配置中心两套命名空间合并后的边界：机器人开关按机器定、凭证只在 wecom 命名空间时发送端照样工作
 */
import { WecomBotService } from '../src/modules/wecom/wecom-bot.service';
import { ReplyDispatcherService } from '../src/modules/reply/reply-dispatcher.service';

const resolve = (env: Record<string, unknown>, wecom: Record<string, unknown>) => {
  const gatewayConfig = { get: (ns: string, key: string) => (ns === 'wecom' ? wecom[key] : undefined) };
  const svc = new WecomBotService(env as any, {} as any, gatewayConfig as any);
  return (svc as any).resolveConfig() as { botId?: string; botEnabled: boolean };
};

describe('企微机器人开关', () => {
  it('本机 WECOM_BOT_ENABLED=false 时，配置中心打开也不连（一个机器人只能一条长连接）', () => {
    expect(resolve({ WECOM_BOT_ENABLED: false }, { botId: 'b', botSecret: 's', botEnabled: true }).botEnabled).toBe(false);
  });
  it('配置中心可以整体关掉；字符串 "false" 也算关', () => {
    expect(resolve({ WECOM_BOT_ENABLED: true }, { botEnabled: false }).botEnabled).toBe(false);
    expect(resolve({ WECOM_BOT_ENABLED: true }, { botEnabled: 'false' }).botEnabled).toBe(false);
    expect(resolve({ WECOM_BOT_ENABLED: true }, { botEnabled: '0' }).botEnabled).toBe(false);
  });
  it('配置中心没写 botEnabled 时按本机开关；凭证取 wecom 命名空间', () => {
    expect(resolve({ WECOM_BOT_ENABLED: true }, { botId: 'from-cc' })).toMatchObject({ botEnabled: true, botId: 'from-cc' });
  });
});

describe('发送端消费回复队列', () => {
  const make = (env: Record<string, unknown>) => {
    const queues = { createWorker: jest.fn(), getQueue: jest.fn() };
    const svc = new ReplyDispatcherService(env as any, queues as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    svc.onModuleInit();
    return queues.createWorker;
  };
  it('凭证只在配置中心（环境变量没有 WECOM_BOT_ID）时照样消费', () => {
    expect(make({ WECOM_BOT_ENABLED: true })).toHaveBeenCalled();
  });
  it('本机不持有机器人、也没开测试注入时不消费（交给持有机器人的那台）', () => {
    expect(make({ WECOM_BOT_ENABLED: false })).not.toHaveBeenCalled();
    expect(make({ WECOM_BOT_ENABLED: false, TEST_INJECT_ENABLED: true })).toHaveBeenCalled();
  });
});
