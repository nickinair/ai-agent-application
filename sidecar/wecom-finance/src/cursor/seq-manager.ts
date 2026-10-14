import * as fs from 'fs';
import * as path from 'path';

export class SeqManager {
  private filePath: string;
  private currentSeq: number = 0;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.load();
  }

  /**
   * 从文件读取并初始化游标
   */
  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8').trim();
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed >= 0) {
          this.currentSeq = parsed;
          return;
        }
      }
    } catch (err: any) {
      console.warn(`[SeqManager] 读取游标文件失败 (${this.filePath})，将重置为 0: ${err.message}`);
    }
    this.currentSeq = 0;
  }

  /**
   * 获取当前拉取游标
   */
  public getSeq(): number {
    return this.currentSeq;
  }

  /**
   * 原子更新并持久化游标
   * 采用写临时文件后原子重命名 (renameSync) 机制，防止意外宕机导致文件损坏
   * @param nextSeq 新的游标数值
   */
  public updateSeq(nextSeq: number): void {
    if (nextSeq <= this.currentSeq) {
      return;
    }

    this.currentSeq = nextSeq;

    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tempFile = `${this.filePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempFile, this.currentSeq.toString(), 'utf8');
      fs.renameSync(tempFile, this.filePath);
    } catch (err: any) {
      console.error(`[SeqManager] 原子持久化游标失败 (${this.filePath}): ${err.message}`);
    }
  }

  /**
   * 重置游标（用于自测或重新全量拉取）
   */
  public reset(seq: number = 0): void {
    this.currentSeq = seq;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, seq.toString(), 'utf8');
  }
}
