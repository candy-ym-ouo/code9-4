import fs from 'node:fs';
import type { Request, Response } from 'express';
import { errors } from './errors.js';

/**
 * 图片输出统一入口。
 * 不用 res.sendFile：其底层的 send 会强制 `Cache-Control: public, max-age=0`，
 * 覆盖按内容版本制定的缓存策略，替换原图后无法保证旧缓存失效。
 * ETag/If-None-Match 支持条件请求。
 */
export function sendImage(
  req: Request,
  res: Response,
  filePath: string,
  contentType: string,
  version: string,
  opts: { cacheControl?: string } = {},
): void {
  const etag = `"${version}"`;
  res.setHeader('Content-Type', contentType);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', opts.cacheControl ?? 'private, max-age=300, must-revalidate');
  if (req.header('if-none-match') === etag) {
    res.status(304).end();
    return;
  }
  if (!fs.existsSync(filePath)) throw errors.notFound('图片文件');
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
}
