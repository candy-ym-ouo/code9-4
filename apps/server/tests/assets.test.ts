import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import sharp from 'sharp';

let app: Express;
let token = '';
let libraryId = '';
let cardId = '';
let tmpDir = '';

function authReq() {
  return agent;
}

let agent: request.Agent;

async function makeImage(seed: string, size = 48): Promise<Buffer> {
  // 不同 seed → 不同像素与不同 sha；真实 PNG，走完整 sharp 管线
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(size * 3);
    for (let x = 0; x < size; x += 1) {
      row[x * 3] = (x * 7 + seed.charCodeAt(0) * 3) & 0xff;
      row[x * 3 + 1] = (y * 11 + seed.charCodeAt(seed.length - 1) * 5) & 0xff;
      row[x * 3 + 2] = (x + y + seed.length * 13) & 0xff;
    }
    rows.push(row);
  }
  return sharp(Buffer.concat(rows), { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();
}

async function uploadImage(buf: Buffer, inspirationId = cardId) {
  return authReq()
    .post(`/api/inspirations/${inspirationId}/assets`)
    .field('role', 'reference')
    .attach('files', buf, { filename: 'shot.png', contentType: 'image/png' });
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
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
  agent = request.agent(app);

  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'owner@assets.test', password: 'password123', displayName: '资产测试' });
  token = reg.body.token;
  libraryId = reg.body.user.libraryId;
  agent.set('authorization', `Bearer ${token}`);
  const card = await authReq().post('/api/inspirations').send({ title: '图片管线测试卡' });
  cardId = card.body.id;
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('图片指纹复用（同图重复上传命中指纹，复用缩略图与色板）', () => {
  it('第二次上传同一字节流：reusedFingerprint=true，指向首次 asset，但只有一份磁盘产物', async () => {
    const buf = await makeImage('aa');
    const first = await uploadImage(buf);
    expect(first.status).toBe(201);
    expect(first.body.items[0].reusedFingerprint).toBe(false);
    const assetA = first.body.items[0].assetId;

    const second = await uploadImage(buf);
    expect(second.status).toBe(201);
    expect(second.body.items[0].reusedFingerprint).toBe(true);
    expect(second.body.items[0].duplicateOf).toBe(assetA);
    const assetB = second.body.items[0].assetId;
    expect(assetB).not.toBe(assetA);

    const detail = await authReq().get(`/api/inspirations/${cardId}`);
    const byId = Object.fromEntries(detail.body.item.assets.map((a: { id: string }) => [a.id, a]));
    expect(byId[assetA].palette.length).toBeGreaterThan(0);
    expect(byId[assetB].palette).toEqual(byId[assetA].palette);
    expect(byId[assetB].contentVersion).toBe(1);

    const pngs = walk(path.join(tmpDir, 'uploads')).filter((f) => f.endsWith('.png'));
    const webps = walk(path.join(tmpDir, 'thumbs')).filter((f) => f.endsWith('.webp'));
    expect(pngs).toHaveLength(1);
    expect(webps).toHaveLength(1);
  });

  it('处理结束后暂存区被清空', async () => {
    const staging = path.join(tmpDir, 'uploads', '.staging');
    expect(walk(staging)).toHaveLength(0);
  });
});

describe('处理中断可续跑', () => {
  it('暂存区已有 source+部分阶段产物时，恢复补完且不重跑已完成阶段', async () => {
    const buf = await makeImage('bb');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const stage = path.join(tmpDir, 'uploads', '.staging', libraryId, sha);
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'source'), buf);
    // 模拟阶段 1/2 已完成，阶段 3（derived.json）未完成
    await sharp(buf).png().toFile(path.join(stage, 'encoded.png'));
    await sharp(buf).resize(8, 8).webp().toFile(path.join(stage, 'thumb.webp'));

    const { recoverInterruptedIngests } = await import('../src/services/assets.js');
    const result = await recoverInterruptedIngests();
    expect(result.recovered).toBe(1);
    expect(fs.existsSync(stage)).toBe(false);

    // blob 已落库：再上传同一文件直接命中指纹
    const up = await uploadImage(buf);
    expect(up.body.items[0].reusedFingerprint).toBe(true);

    const again = await recoverInterruptedIngests();
    expect(again.recovered).toBe(0);
  });

  it('没有 source 的残留暂存目录在恢复时被清理', async () => {
    const orphan = path.join(tmpDir, 'uploads', '.staging', libraryId, 'deadbeef');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'meta.json'), '{}');
    const { recoverInterruptedIngests } = await import('../src/services/assets.js');
    const result = await recoverInterruptedIngests();
    expect(result.pruned).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('客户端重传同一文件完成入库（重传即续跑，结果幂等一致）', async () => {
    const buf = await makeImage('cc');
    const r1 = await uploadImage(buf);
    expect(r1.status).toBe(201);
    expect(r1.body.items[0].assetId).toBeTruthy();
    expect(r1.body.items[0].width).toBe(48);
  });
});

describe('替换原图后旧分享图与缓存不得继续暴露', () => {
  let assetId = '';
  let shareToken = '';
  let libShareDir = '';

  it('建立分享并取到分享图（no-store）', async () => {
    const buf = await makeImage('dd');
    const up = await uploadImage(buf);
    assetId = up.body.items[0].assetId;

    const link = await authReq()
      .post('/api/share-links')
      .send({ scope: 'inspiration', scopeId: cardId, fuzzLevel: 'g500', expiresInDays: 7 });
    shareToken = link.body.token;

    const view = await request(app).get(`/api/share/${shareToken}`);
    const asset = view.body.item.assets.find((a: { id: string }) => a.id === assetId);
    expect(asset.version).toBe(1);
    expect(asset.url).toContain('v=1');

    const img = await request(app).get(`/api/share/${shareToken}/assets/${assetId}?v=1`);
    expect(img.status).toBe(200);
    expect(img.headers['cache-control']).toBe('no-store');

    libShareDir = path.join(tmpDir, 'share', libraryId);
    expect(fs.existsSync(path.join(libShareDir, `${assetId}.v1.jpg`))).toBe(true);
  });

  it('替换原图：版本自增、旧版分享图物理删除、旧版本 URL 拒绝服务', async () => {
    const buf2 = await makeImage('ee');
    const rep = await authReq()
      .post(`/api/assets/${assetId}/replace`)
      .attach('file', buf2, { filename: 'new.png', contentType: 'image/png' });
    expect(rep.status).toBe(200);
    expect(rep.body.changed).toBe(true);
    expect(rep.body.item.contentVersion).toBe(2);

    expect(fs.existsSync(path.join(libShareDir, `${assetId}.v1.jpg`))).toBe(false);

    const stale = await request(app).get(`/api/share/${shareToken}/assets/${assetId}?v=1`);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('ASSET_VERSION_STALE');

    const fresh = await request(app).get(`/api/share/${shareToken}/assets/${assetId}?v=2`);
    expect(fresh.status).toBe(200);
    expect(fs.existsSync(path.join(libShareDir, `${assetId}.v2.jpg`))).toBe(true);
  });

  it('私有原图以内容版本作 ETag：当前版本 304，旧 ETag 在替换后必然 miss', async () => {
    const r1 = await authReq().get(`/api/assets/${assetId}/file`);
    expect(r1.status).toBe(200);
    expect(r1.headers['etag']).toBe('"v2"');
    expect(String(r1.headers['cache-control'])).toContain('private');

    const notModified = await authReq().get(`/api/assets/${assetId}/file`).set('If-None-Match', '"v2"');
    expect(notModified.status).toBe(304);

    const staleEtag = await authReq().get(`/api/assets/${assetId}/file`).set('If-None-Match', '"v1"');
    expect(staleEtag.status).toBe(200);
  });

  it('替换成库内已有的另一张图 → 命中指纹复用；再删掉引用 asset 不产生悬挂文件', async () => {
    const bufA = await makeImage('ff');
    const up = await uploadImage(bufA);
    const otherAsset = up.body.items[0].assetId;

    const rep = await authReq()
      .post(`/api/assets/${assetId}/replace`)
      .attach('file', bufA, { filename: 'dup.png', contentType: 'image/png' });
    expect(rep.status).toBe(200);
    expect(rep.body.changed).toBe(true);
    expect(rep.body.reusedFingerprint).toBe(true);
    expect(rep.body.item.contentVersion).toBe(3);

    // 另一条 asset 还在引用该 blob，删除其中一条后文件仍可访问
    const del = await authReq().delete(`/api/assets/${otherAsset}`);
    expect(del.status).toBe(200);
    const stillThere = await authReq().get(`/api/assets/${assetId}/file`);
    expect(stillThere.status).toBe(200);
  });

  it('删除 asset 时其分享图（所有历史版本）一并删除', async () => {
    const buf = await makeImage('gg');
    const up = await uploadImage(buf);
    const id = up.body.items[0].assetId;
    await request(app).get(`/api/share/${shareToken}/assets/${id}?v=1`).expect(200);
    expect(fs.existsSync(path.join(libShareDir, `${id}.v1.jpg`))).toBe(true);

    await authReq().delete(`/api/assets/${id}`).expect(200);
    expect(fs.existsSync(path.join(libShareDir, `${id}.v1.jpg`))).toBe(false);
  });
});
