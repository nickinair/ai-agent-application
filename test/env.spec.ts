import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initEnvFiles, loadEnv } from '../src/config/env';

describe('环境变量配置模块 (env)', () => {
  describe('loadEnv 参数校验与默认值', () => {
    it('空入参时应产生正确的默认配置', () => {
      const env = loadEnv({});
      expect(env.PORT).toBe(3002);
      expect(env.MYSQL_URL).toBe('mysql://agent:agent@localhost:3306/agent_platform');
      expect(env.WECOM_BOT_ENABLED).toBe(true);
      expect(env.WECOM_BOT_ID).toBeUndefined();
      expect(env.WECOM_BOT_SECRET).toBeUndefined();
    });

    it('合法入参时应正确解析', () => {
      const env = loadEnv({
        PORT: '8080',
        WECOM_BOT_ID: 'bot_test_123',
        WECOM_BOT_SECRET: 'secret_test_456',
        WECOM_BOT_ENABLED: 'false',
      });

      expect(env.PORT).toBe(8080);
      expect(env.WECOM_BOT_ID).toBe('bot_test_123');
      expect(env.WECOM_BOT_SECRET).toBe('secret_test_456');
      expect(env.WECOM_BOT_ENABLED).toBe(false);
    });

    it('非法 PORT 时应报错抛出异常', () => {
      expect(() => loadEnv({ PORT: 'not-a-number' })).toThrow('环境变量校验失败');
    });
  });

  describe('initEnvFiles 环境文件优先级加载', () => {
    let tempDir: string;
    const originalEnv = { ...process.env };

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'agent-env-test-'));
      // 清空可能影响测试的变量
      delete process.env.TEST_VAR_A;
      delete process.env.TEST_VAR_B;
      delete process.env.TEST_VAR_C;
      delete process.env.ENV_FILE;
    });

    afterEach(() => {
      process.env = { ...originalEnv };
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('.env.local 优先级应高于 .env', () => {
      writeFileSync(join(tempDir, '.env'), 'TEST_VAR_A=from_env\nTEST_VAR_B=from_env\n');
      writeFileSync(join(tempDir, '.env.local'), 'TEST_VAR_A=from_local\nTEST_VAR_C=only_local\n');

      initEnvFiles(tempDir);

      expect(process.env.TEST_VAR_A).toBe('from_local');
      expect(process.env.TEST_VAR_B).toBe('from_env');
      expect(process.env.TEST_VAR_C).toBe('only_local');
    });

    it('指定 ENV_FILE 时应优先加载指定文件', () => {
      writeFileSync(join(tempDir, '.env.custom'), 'TEST_VAR_A=from_custom\n');
      process.env.ENV_FILE = join(tempDir, '.env.custom');

      initEnvFiles(tempDir);

      expect(process.env.TEST_VAR_A).toBe('from_custom');
    });

    it('环境文件不存在时应静默跳过而不崩溃', () => {
      expect(() => initEnvFiles(tempDir)).not.toThrow();
    });
  });
});
