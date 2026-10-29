import { createHash } from 'crypto';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SavedMediaRef } from '../types/finance.types';

/** 按文件头识别常见图片格式；识别不了的按二进制处理 */
export function sniffImage(buf: Buffer): { mime: string; ext: string } {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return { mime: 'image/gif', ext: 'gif' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return { mime: 'image/bmp', ext: 'bmp' };
  return { mime: 'application/octet-stream', ext: 'bin' };
}

/**
 * 把媒体文件存进共享媒体卷（A3、核心服务同一目录）：{mediaDir}/fin/{yyyyMMdd}/{md5}.{ext}
 * 侧车只写 fin/ 子树（容器以 root 运行），A3 写 bot/ 子树，互不影响目录权限。
 * 同一文件 md5 相同，重复保存直接复用。
 */
export function saveMedia(mediaDir: string, buf: Buffer, now: Date = new Date()): SavedMediaRef {
  const md5 = createHash('md5').update(buf).digest('hex');
  const { mime, ext } = sniffImage(buf);
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const key = `fin/${day}/${md5}.${ext}`;
  const dir = join(mediaDir, 'fin', day);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const file = join(mediaDir, key);
  if (!existsSync(file)) writeFileSync(file, buf, { mode: 0o644 });
  return { key, md5, size: buf.length, mime };
}
