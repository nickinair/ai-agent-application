import { EncryptedChatData } from '../types/finance.types';

/**
 * 会话存档底层驱动通用抽象接口
 * 支持 Native (C 动态库) 与 Mock (开发测试模拟器) 两种驱动实现无缝插拔
 */
export interface IFinanceDriver {
  /**
   * 初始化驱动资源
   */
  init(): Promise<void>;

  /**
   * 拉取加密聊天数据
   * @param seq 起始拉取游标（从上次成功拉取的最新 seq 开始）
   * @param limit 本批次拉取最大数量（企微最大支持 1000 条）
   * @param timeout 拉取超时时间（秒）
   */
  fetchChatData(seq: number, limit: number, timeout?: number): Promise<EncryptedChatData[]>;

  /**
   * 销毁释放驱动资源
   */
  destroy(): Promise<void>;
}
