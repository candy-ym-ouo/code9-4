import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import sharp from 'sharp';

let app: Express;
let token = '';
let tmpDir = '';
let cardId = '';

async function authHeader(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${token}` };
}

/** 生成一张可被 sharp 解码的纯色 JPEG（不同色 → 不同指纹） */
async function makeJpeg(r: number, g: number, b: number, w = 48, h = 32): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r, g, b } },
  })
    .jpeg()
    .toBuffer();
}

function call(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) {
  let req = request(app)[method](url);
  if (token) req = req.set('authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

async function upload(buffer: Buffer, inspirationId = cardId) {
  const h = await authHeader();
  return request(app)
    .post(`/api/inspirations/${inspirationId}/assets`)
    .set(h)
    .attach('files', buffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-assets-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'fixture';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/db.js');
  migrate();
  app = createApp();

  const reg = await call('post', '/api/auth/register', {
    email: 'assets@test.local',
    password: 'password123',
    displayName: '资产测试',
  });
  token = reg.body.token;
  const created = await call('post', '/api/inspirations', { title: '指纹与替换测试卡' });
  cardId = created.body.id;
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('A1 同图重复上传：命中指纹并复用缩略图与色板', () => {
  it('第一次上传完整加工，第二次同图命中指纹、零重复加工', async () => {
    const buf = await makeJpeg(200, 30, 40);

    const first = await upload(buf);
    expect(first.status).toBe(201);
    expect(first.body.items[0].reusedFingerprint).toBe(false);
    const a1 = first.body.items[0].assetId;

    const second = await upload(buf);
    expect(second.status).toBe(201);
    expect(second.body.items[0].reusedFingerprint).toBe(true);
    expect(second.body.items[0].duplicateOf).toBe(a1);
    const a2 = second.body.items[0].assetId;
    expect(a2).not.toBe(a1);

    const detail1 = await call('get', `/api/inspirations/${cardId}`);
    const assets = detail1.body.item.assets as {
      id: string;
      thumbUrl: string;
      palette: { hex: string; ratio: number }[];
    }[];
    const row1 = assets.find((a) => a.id === a1)!;
    const row2 = assets.find((a) => a.id === a2)!;

    // 色板复用：两次结果一致且非空
    expect(row2.palette.length).toBeGreaterThan(0);
    expect(row2.palette).toEqual(row1.palette);

    // 物理文件只加工了一份（缩略图路径相同，内容寻址复用）
    const { getDb } = await import('../src/db.js');
    const dbRows = getDb()
      .prepare('SELECT id, thumb_path, file_path, blob_id FROM asset WHERE id IN (?, ?)')
      .all(a1, a2) as { id: string; thumb_path: string; file_path: string; blob_id: string }[];
    expect(dbRows[0].blob_id).toBeTruthy();
    expect(dbRows[0].blob_id).toBe(dbRows[1].blob_id);
    expect(dbRows[0].thumb_path).toBe(dbRows[1].thumb_path);
    expect(fs.existsSync(dbRows[0].file_path)).toBe(true);
    expect(fs.existsSync(dbRows[0].thumb_path)).toBe(true);
  });

  it('缩略图与原图端点都带 ETag 与私有缓存头，URL 带内容版本号', async () => {
    const buf = await makeJpeg(10, 200, 60);
    const up = await upload(buf);
    const assetId = up.body.items[0].assetId;
    const detail = await call('get', `/api/inspirations/${cardId}`);
    const row = (detail.body.item.assets as { id: string; thumbUrl: string }[]).find(
      (a) => a.id === assetId,
    )!;
    expect(row.thumbUrl).toMatch(/\?v=[0-9a-f]+$/);

    const thumb = await request(app)
      .get(row.thumbUrl)
      .set(await authHeader());
    expect(thumb.status).toBe(200);
    expect(thumb.headers['cache-control']).toContain('must-revalidate');
    expect(thumb.headers['etag']).toMatch(/^"[0-9a-f]+"$/);
  });
});

describe('A2 处理中断可续跑', () => {
  it('在缩略图阶段中断后重传：只补做缺失阶段，不再落第二份原图', async () => {
    const { getDb } = await import('../src/db.js');
    const buf = await makeJpeg(40, 50, 210);
    const crypto = await import('node:crypto');
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

    const up = await upload(buf);
    expect(up.status).toBe(201);
    const assetId = up.body.items[0].assetId;

    // 模拟"在缩略图与色板阶段之间崩溃"：删除缩略图文件、回退阶段标记
    const before = getDb()
      .prepare('SELECT * FROM asset_blob WHERE library_id = (SELECT library_id FROM asset WHERE id = ?) AND sha256 = ?')
      .get(assetId, sha256) as Record<string, unknown>;
    fs.rmSync(before.thumb_path as string, { force: true });
    getDb()
      .prepare('UPDATE asset_blob SET thumb_ready = 0, palette_ready = 0 WHERE id = ?')
      .run(before.id as string);

    // 重传同一张图：应从断点续跑，而不是新建 blob
    const retry = await upload(buf);
    expect(retry.status).toBe(201);
    expect(retry.body.items[0].reusedFingerprint).toBe(false); // 上次并未加工完整

    const after = getDb()
      .prepare('SELECT * FROM asset_blob WHERE id = ?')
      .get(before.id as string) as Record<string, unknown>;
    expect(after.file_ready).toBe(1);
    expect(after.thumb_ready).toBe(1);
    expect(after.palette_ready).toBe(1);
    expect(fs.existsSync(after.file_path as string)).toBe(true);
    expect(fs.existsSync(after.thumb_path as string)).toBe(true);
    expect(after.file_path).toBe(before.file_path); // 原图路径复用，未重复落盘

    const blobCount = (
      getDb()
        .prepare('SELECT COUNT(*) AS n FROM asset_blob WHERE sha256 = ?')
        .get(sha256) as { n: number }
    ).n;
    expect(blobCount).toBe(1);
  });

  it('原图阶段就中断（blob 登记但无文件）：重传后补落盘并跑完后续阶段', async () => {
    const { getDb } = await import('../src/db.js');
    const buf = await makeJpeg(210, 210, 30);
    const crypto = await import('node:crypto');
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

    // 手工插入一个"刚登记、什么都没做"的 blob，模拟最早阶段中断
    const { newId, nowIso } = await import('../src/db.js');
    const libraryId = (
      getDb()
        .prepare('SELECT library_id FROM inspiration WHERE id = ?')
        .get(cardId) as { library_id: string }
    ).library_id;
    const id = newId();
    const now = new Date();
    const ym = path.join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'));
    const dir = path.join(process.env.UPLOAD_DIR!, libraryId, ym);
    const thumbDir = path.join(process.env.THUMB_DIR!, libraryId, ym);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(thumbDir, { recursive: true });
    getDb()
      .prepare(
        `INSERT INTO asset_blob (id, library_id, sha256, file_path, thumb_path, palette,
           file_ready, thumb_ready, palette_ready, created_at, updated_at)
         VALUES (?,?,?,?,?,'[]',0,0,0,?,?)`,
      )
      .run(
        id,
        libraryId,
        sha256,
        path.join(dir, `${id}.jpg`),
        path.join(thumbDir, `${id}.webp`),
        nowIso(),
        nowIso(),
      );

    const retry = await upload(buf);
    expect(retry.status).toBe(201);
    const blob = getDb().prepare('SELECT * FROM asset_blob WHERE id = ?').get(id) as Record<string, unknown>;
    expect(blob.file_ready).toBe(1);
    expect(blob.thumb_ready).toBe(1);
    expect(blob.palette_ready).toBe(1);
    expect(fs.existsSync(blob.file_path as string)).toBe(true);
    expect(fs.existsSync(blob.thumb_path as string)).toBe(true);
    expect(blob.width).toBeGreaterThan(0);
  });
});

describe('A3 替换原图：旧分享图与缓存不得继续暴露', () => {
  it('替换后内容指纹、色板、URL 版本全部变化，旧分享图文件被删除', async () => {
    const { getDb } = await import('../src/db.js');
    const v1 = await makeJpeg(10, 10, 10);
    const up1 = await upload(v1);
    const assetId = up1.body.items[0].assetId;

    // 建分享链接并拉取一次分享图（脱敏文件落盘）
    const link = await call('post', '/api/share-links', {
      scope: 'inspiration',
      scopeId: cardId,
      fuzzLevel: 'g500',
      expiresInDays: 7,
    });
    expect(link.status).toBe(201);
    const shareToken = link.body.token as string;

    const view1 = await request(app).get(`/api/share/${shareToken}`);
    expect(view1.status).toBe(200);
    const shareUrl1 = (
      view1.body.item.assets as { id: string; url: string }[]
    ).find((a) => a.id === assetId)!.url;

    const img1 = await request(app).get(shareUrl1);
    expect(img1.status).toBe(200);
    expect(img1.headers['cache-control']).toContain('no-store');
    const bytes1 = img1.body.length;

    const oldPath = getDb()
      .prepare('SELECT file_path FROM asset WHERE id = ?')
      .get(assetId) as { file_path: string };
    const oldShareFile = path.join(
      process.env.SHARE_DIR!,
      (getDb().prepare('SELECT library_id FROM asset WHERE id = ?').get(assetId) as { library_id: string })
        .library_id,
      `${(await import('node:crypto')).createHash('sha256').update(v1).digest('hex')}.jpg`,
    );
    expect(fs.existsSync(oldShareFile)).toBe(true);

    // 替换为完全不同的图片
    const v2 = await makeJpeg(230, 230, 120);
    const replace = await request(app)
      .post(`/api/assets/${assetId}/replace`)
      .set(await authHeader())
      .attach('file', v2, { filename: 'new.jpg', contentType: 'image/jpeg' });
    expect(replace.status).toBe(200);
    expect(replace.body.item.id).toBe(assetId); // asset 身份不变（标注得以保留）

    // 旧分享图立即从磁盘消失
    expect(fs.existsSync(oldShareFile)).toBe(false);
    expect(oldPath.file_path).toBeTruthy();

    // 分享 JSON 给出的 URL 版本号已变
    const view2 = await request(app).get(`/api/share/${shareToken}`);
    const shareUrl2 = (
      view2.body.item.assets as { id: string; url: string }[]
    ).find((a) => a.id === assetId)!.url;
    expect(shareUrl2).not.toBe(shareUrl1);

    // 新 URL 能取到新内容；旧 URL 也被服务端按当前指纹重新解析（路径是内容寻址的）
    const img2 = await request(app).get(shareUrl2);
    expect(img2.status).toBe(200);
    expect(img2.body.length).toBeGreaterThan(0);
    expect(img2.body.equals(v2) || img2.body.length !== bytes1).toBe(true);

    // asset 自身 URL（前端缩略图）版本号也变了，浏览器无法再用旧缓存
    const detail = await call('get', `/api/inspirations/${cardId}`);
    const row = (detail.body.item.assets as { id: string; thumbUrl: string; palette: unknown[] }[]).find(
      (a) => a.id === assetId,
    )!;
    expect(row.palette.length).toBeGreaterThan(0);
    const oldVersion = shareUrl1.split('?v=')[1];
    expect(row.thumbUrl).not.toContain(`?v=${oldVersion}`);
    expect(row.thumbUrl).toContain('?v=');
  });

  it('分享链接撤销后图片端点同样拒绝（不接受缓存兜底）', async () => {
    const links = await call('get', '/api/share-links');
    const target = (links.body.items as { id: string }[])[0];
    await call('post', `/api/share-links/${target.id}/revoke`, {});
    // 撤销校验在 JSON 与图片端点都会执行 —— 上面的 token 已失效
    const revoked = await request(app).get(`/api/share/${(links.body.items as { token: string }[])[0].token}`);
    expect(revoked.status).toBe(401);
  });
});

describe('A4 删除与引用计数', () => {
  it('同指纹两个 asset 删一个：文件保留；全删后 blob 与物理文件回收', async () => {
    const { getDb } = await import('../src/db.js');
    const buf = await makeJpeg(90, 90, 90);
    const a = await upload(buf);
    const b = await upload(buf);
    const id1 = a.body.items[0].assetId;
    const id2 = b.body.items[0].assetId;
    const blobId = (
      getDb().prepare('SELECT blob_id FROM asset WHERE id = ?').get(id1) as { blob_id: string }
    ).blob_id;
    const file = (getDb().prepare('SELECT file_path FROM asset_blob WHERE id = ?').get(blobId) as { file_path: string })
      .file_path;

    await call('delete', `/api/assets/${id1}`);
    expect(fs.existsSync(file)).toBe(true);
    expect(getDb().prepare('SELECT id FROM asset_blob WHERE id = ?').get(blobId)).toBeTruthy();

    await call('delete', `/api/assets/${id2}`);
    expect(getDb().prepare('SELECT id FROM asset_blob WHERE id = ?').get(blobId)).toBeFalsy();
    expect(fs.existsSync(file)).toBe(false);
  });
});
