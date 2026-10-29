/**
 * @file media-store.ts
 * @description 共享媒体卷存储（图片识别 P1）。A3 写 bot/ 子树，会话存档侧车写 fin/ 子树，核心服务只读。
 * message.media_url 记为 media://{key}，key 相对 MEDIA_DIR。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MEDIA_SCHEME = 'media://';

export interface SavedMedia {
  key: string;
  url: string;
  md5: string;
  size: number;
  mime: string;
}

/** 按文件头识别常见图片格式；识别不了的按二进制处理 */
export function sniffImage(buf: Buffer): { mime: string; ext: string } {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return { mime: 'image/gif', ext: 'gif' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return { mime: 'image/bmp', ext: 'bmp' };
  return { mime: 'application/octet-stream', ext: 'bin' };
}

/** 存入 {mediaDir}/bot/{yyyyMMdd}/{md5}.{ext}；同一文件重复保存直接复用 */
export function saveMedia(mediaDir: string, buf: Buffer, now: Date = new Date()): SavedMedia {
  const md5 = createHash('md5').update(buf).digest('hex');
  const { mime, ext } = sniffImage(buf);
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const key = `bot/${day}/${md5}.${ext}`;
  mkdirSync(join(mediaDir, 'bot', day), { recursive: true, mode: 0o755 });
  const file = join(mediaDir, key);
  if (!existsSync(file)) writeFileSync(file, buf, { mode: 0o644 });
  return { key, url: `${MEDIA_SCHEME}${key}`, md5, size: buf.length, mime };
}
