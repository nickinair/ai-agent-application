/**
 * @file buffer.spec.ts
 * @description 客户消息聚合缓冲池服务单元测试 (BufferService)
 */

import { BufferService } from '../src/modules/pipeline/buffer.service';

describe('缓冲池服务测试 (BufferService)', () => {
  let service: BufferService;
  let mockRedisClient: any;
  let mockRedisService: any;

  beforeEach(() => {
    mockRedisClient = {
      eval: jest.fn(),
      hgetall: jest.fn(),
      keys: jest.fn(),
      llen: jest.fn(),
    };

    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    };

    service = new BufferService(mockRedisService);
  });

  describe('1. 原子入池 (push)', () => {
    it('缓冲池首条消息入池时应标记 isFirst 为 true 并初始化版本与 epoch', async () => {
      // Lua 脚本返回: [count, version, epoch, firstAt, isFirst]
      mockRedisClient.eval.mockResolvedValue([1, 1, 1, 1718000000000, 1]);

      const res = await service.push(101, 'sender_zhangsan', 'msg_001', 1718000000000);

      expect(res.count).toBe(1);
      expect(res.version).toBe(1);
      expect(res.epoch).toBe(1);
      expect(res.firstAt).toBe(1718000000000);
      expect(res.isFirst).toBe(true);
      expect(mockRedisClient.eval).toHaveBeenCalled();
    });

    it('同一发送人后续消息入池时 count 与 version 递增且 isFirst 为 false', async () => {
      mockRedisClient.eval.mockResolvedValue([2, 2, 1, 1718000000000, 0]);

      const res = await service.push(101, 'sender_zhangsan', 'msg_002', 1718000001000);

      expect(res.count).toBe(2);
      expect(res.version).toBe(2);
      expect(res.isFirst).toBe(false);
    });
  });

  describe('2. 原子出池 (drain)', () => {
    it('封组时提取全部消息 ID', async () => {
      mockRedisClient.eval.mockResolvedValue(['msg_001', 'msg_002']);

      const ids = await service.drain(101, 'sender_zhangsan');

      expect(ids).toEqual(['msg_001', 'msg_002']);
      expect(mockRedisClient.eval).toHaveBeenCalled();
    });
  });

  describe('3. 元数据与轮次结束版本重置', () => {
    it('getMeta 读取解析数字元数据', async () => {
      mockRedisClient.hgetall.mockResolvedValue({
        count: '3',
        version: '4',
        epoch: '2',
        firstAt: '1718000000000',
        lastAt: '1718000005000',
      });

      const meta = await service.getMeta(101, 'sender_zhangsan');

      expect(meta).not.toBeNull();
      expect(meta?.count).toBe(3);
      expect(meta?.version).toBe(4);
      expect(meta?.epoch).toBe(2);
    });

    it('bumpVersion 递增版本号用于新一轮重置静默', async () => {
      mockRedisClient.eval.mockResolvedValue([5, 1718000000000, 1]);

      const res = await service.bumpVersion(101, 'sender_zhangsan');

      expect(res.version).toBe(5);
      expect(res.count).toBe(1);
    });

    it('nonEmptySenders 扫描过滤非空发送人', async () => {
      mockRedisClient.keys.mockResolvedValue([
        'ag:buf:101:user_a',
        'ag:buf:101:user_b',
      ]);
      mockRedisClient.llen.mockImplementation(async (key: string) => {
        return key.endsWith('user_a') ? 2 : 0;
      });

      const senders = await service.nonEmptySenders(101);

      expect(senders).toEqual(['user_a']);
    });
  });
});
