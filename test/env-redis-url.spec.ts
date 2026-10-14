import { loadEnv, withRedisFromUrl } from '../src/config/env';

describe('REDIS_URL 拆给运行时用（与核心服务共用一个 Redis）', () => {
  it('只配 REDIS_URL：拆出主机、端口、密码、库号', () => {
    const env = loadEnv({ REDIS_URL: 'redis://:p%40ss@10.0.0.5:6380/2' });
    expect(env).toMatchObject({ REDIS_HOST: '10.0.0.5', REDIS_PORT: 6380, REDIS_PASSWORD: 'p@ss', REDIS_DB: 2 });
  });
  it('单独配了 REDIS_HOST 时以它为准', () => {
    expect(withRedisFromUrl({ REDIS_URL: 'redis://a:6379', REDIS_HOST: 'b' }).REDIS_HOST).toBe('b');
  });
  it('没有密码、库号时用默认', () => {
    expect(loadEnv({ REDIS_URL: 'redis://redis:6379' })).toMatchObject({ REDIS_HOST: 'redis', REDIS_PORT: 6379, REDIS_DB: 0 });
  });
});
