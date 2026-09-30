import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {
  azimuthAt,
  elevationAt,
  utcToZonedParts,
  zonedTimeToUtc,
  type AssetRole,
  type PaletteColor,
} from '@flil/shared';
import { config } from '../config.js';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { parseExif } from './exif.js';
import { extractPalette } from './paletteExtract.js';
import { emitEvent } from './events.js';
import { logger } from '../logger.js';

export interface AssetRow {
  id: string;
  library_id: string;
  inspiration_id: string;
  role: AssetRole;
  file_path: string;
  thumb_path: string | null;
  mime: string | null;
  width: number;
  height: number;
  bytes: number;
  sha256: string | null;
  blob_id: string | null;
  shot_at: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  aperture: string | null;
  shutter: string | null;
  has_gps_exif: number;
  palette: string;
  sun_elevation: number | null;
  sun_azimuth: number | null;
  weather_snapshot: string | null;
  created_at: string;
  updated_at: string;
}

export interface BlobRow {
  id: string;
  library_id: string;
  sha256: string;
  file_path: string;
  thumb_path: string | null;
  mime: string | null;
  width: number;
  height: number;
  bytes: number;
  shot_at: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  aperture: string | null;
  shutter: string | null;
  has_gps_exif: number;
  palette: string;
  file_ready: number;
  thumb_ready: number;
  palette_ready: number;
  created_at: string;
  updated_at: string;
}

function subdir(date = new Date()): string {
  return path.join(String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'));
}

export interface IngestResult {
  assetId: string;
  duplicateOf: string | null;
  /** true = 命中指纹，缩略图与色板直接复用，未重复加工 */
  reusedFingerprint: boolean;
  hasGpsExif: boolean;
  shotAt: string | null;
  width: number;
  height: number;
}

/** 同进程内对同一指纹的加工互斥，避免并发同图重复落盘/加工 */
const inflight = new Map<string, Promise<BlobRow>>();

function blobKey(libraryId: string, sha256: string): string {
  return `${libraryId}:${sha256}`;
}

function blobDirs(libraryId: string): { dir: string; thumbDir: string } {
  const dir = path.join(config.uploadDir, libraryId, subdir());
  const thumbDir = path.join(config.thumbDir, libraryId, subdir());
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(thumbDir, { recursive: true });
  return { dir, thumbDir };
}

function imageExt(format: string | undefined): string {
  if (format === 'png') return 'png';
  if (format === 'webp') return 'webp';
  return 'jpg';
}

/**
 * 内容寻址的图片加工管线（文档 11.3），三阶段幂等：
 *   file_ready → thumb_ready → palette_ready。
 * 任意阶段崩溃后，带着同一字节重传/重试只会补做未完成阶段 —— 可中断续跑。
 * 同库同指纹只存在一个 asset_blob，asset 行复用其缩略图与色板。
 */
async function processBlob(params: {
  libraryId: string;
  sha256: string;
  buffer: Buffer;
}): Promise<BlobRow> {
  const { libraryId, sha256, buffer } = params;
  const db = getDb();
  const ts = nowIso();

  let blob = db
    .prepare('SELECT * FROM asset_blob WHERE library_id = ? AND sha256 = ?')
    .get(libraryId, sha256) as BlobRow | undefined;

  if (!blob) {
    const { dir, thumbDir } = blobDirs(libraryId);
    const id = newId();
    const ext = imageExt((await sharp(buffer, { failOn: 'none' }).metadata()).format ?? undefined);
    blob = {
      id,
      library_id: libraryId,
      sha256,
      file_path: path.join(dir, `${id}.${ext}`),
      thumb_path: path.join(thumbDir, `${id}.webp`),
      mime: null,
      width: 0,
      height: 0,
      bytes: buffer.byteLength,
      shot_at: null,
      camera_model: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      has_gps_exif: 0,
      palette: '[]',
      file_ready: 0,
      thumb_ready: 0,
      palette_ready: 0,
      created_at: ts,
      updated_at: ts,
    };
    db.prepare(
      `INSERT INTO asset_blob (id, library_id, sha256, file_path, thumb_path, mime, width, height, bytes,
         shot_at, camera_model, lens, iso, aperture, shutter, has_gps_exif, palette,
         file_ready, thumb_ready, palette_ready, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(...blobColumnArgs(blob));
  }

  // 阶段 1：原图落盘 + 元数据/EXIF（原子推进；文件缺失也重做，兼容磁盘丢失）
  if (!blob.file_ready || !fs.existsSync(blob.file_path)) {
    const filePath = blob.file_path;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await sharp(buffer, { failOn: 'none' })
      .rotate()
      .toFile(filePath)
      .catch(() => {
        fs.writeFileSync(filePath, buffer);
      });

    const metadata = await sharp(buffer, { failOn: 'none' }).metadata();
    const exif = parseExif(metadata.exif as Buffer | undefined);
    blob = {
      ...blob,
      mime: metadata.format ? `image/${metadata.format}` : 'image/jpeg',
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      bytes: buffer.byteLength,
      shot_at: exif.shotAt ? exif.shotAt.toISOString() : null,
      camera_model: exif.cameraModel,
      lens: exif.lens,
      iso: exif.iso,
      aperture: exif.aperture,
      shutter: exif.shutter,
      has_gps_exif: exif.hasGps ? 1 : 0,
      file_ready: 1,
      updated_at: nowIso(),
    };
    persistBlob(db, blob);
  }

  // 阶段 2：缩略图（与内容绑定；命中指纹时直接复用，不重复缩放）
  if (!blob.thumb_ready || !blob.thumb_path || !fs.existsSync(blob.thumb_path)) {
    fs.mkdirSync(path.dirname(blob.thumb_path!), { recursive: true });
    await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(blob.thumb_path!)
      .catch(() => undefined);
    blob = { ...blob, thumb_ready: 1, updated_at: nowIso() };
    persistBlob(db, blob);
  }

  // 阶段 3：主色板
  if (!blob.palette_ready) {
    let palette: PaletteColor[] = [];
    try {
      palette = await extractPalette(blob.file_path);
    } catch (err) {
      logger.warn('palette 提取失败', { blobId: blob.id, error: String(err) });
    }
    blob = { ...blob, palette: toJson(palette), palette_ready: 1, updated_at: nowIso() };
    persistBlob(db, blob);
  }

  return blob;
}

function persistBlob(db: ReturnType<typeof getDb>, blob: BlobRow): void {
  db.prepare(
    `UPDATE asset_blob SET file_path=?, thumb_path=?, mime=?, width=?, height=?, bytes=?,
       shot_at=?, camera_model=?, lens=?, iso=?, aperture=?, shutter=?, has_gps_exif=?, palette=?,
       file_ready=?, thumb_ready=?, palette_ready=?, updated_at=? WHERE id=?`,
  ).run(
    blob.file_path,
    blob.thumb_path,
    blob.mime,
    blob.width,
    blob.height,
    blob.bytes,
    blob.shot_at,
    blob.camera_model,
    blob.lens,
    blob.iso,
    blob.aperture,
    blob.shutter,
    blob.has_gps_exif,
    blob.palette,
    blob.file_ready,
    blob.thumb_ready,
    blob.palette_ready,
    blob.updated_at,
    blob.id,
  );
}

function blobColumnArgs(b: BlobRow): unknown[] {
  return [
    b.id,
    b.library_id,
    b.sha256,
    b.file_path,
    b.thumb_path,
    b.mime,
    b.width,
    b.height,
    b.bytes,
    b.shot_at,
    b.camera_model,
    b.lens,
    b.iso,
    b.aperture,
    b.shutter,
    b.has_gps_exif,
    b.palette,
    b.file_ready,
    b.thumb_ready,
    b.palette_ready,
    b.created_at,
    b.updated_at,
  ];
}

/** 同指纹并发加工去重：第二个请求等同一个 Promise，不重复跑管线 */
async function processBlobWithLock(libraryId: string, sha256: string, buffer: Buffer): Promise<BlobRow> {
  const key = blobKey(libraryId, sha256);
  const running = inflight.get(key);
  if (running) return running;
  const task = processBlob({ libraryId, sha256, buffer }).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

/** 用拍摄时刻 + 机位坐标计算太阳位置（EXIF 时间按机位时区解释） */
function sunPosition(
  exifShotAt: string | null,
  spot: { lat: number; lng: number; tz: string } | null,
): { elevation: number | null; azimuth: number | null } {
  if (!exifShotAt || !spot) return { elevation: null, azimuth: null };
  const asUtc = new Date(exifShotAt);
  const parts = utcToZonedParts(asUtc, 'UTC');
  const instant = zonedTimeToUtc(spot.tz, parts.year, parts.month, parts.day, parts.hour, parts.minute);
  return { elevation: elevationAt(instant, spot.lat, spot.lng), azimuth: azimuthAt(instant, spot.lat, spot.lng) };
}

/**
 * 单张图片入库（文档 11.3）：指纹 → 内容寻址加工（缩略图/色板可复用、可续跑）→ asset 行。
 * 注意：EXIF 中的 GPS **默认不落库**，只记录布尔位并提示用户。
 */
export async function ingestAsset(params: {
  libraryId: string;
  inspirationId: string;
  role: AssetRole;
  filename: string;
  buffer: Buffer;
  /** 若已知机位坐标，则用拍摄时刻计算当时太阳位置 */
  spot?: { lat: number; lng: number; tz: string } | null;
}): Promise<IngestResult> {
  const db = getDb();
  const { libraryId, inspirationId, role, buffer, spot } = params;

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const previous = db
    .prepare('SELECT id FROM asset WHERE library_id = ? AND sha256 = ? ORDER BY created_at ASC LIMIT 1')
    .get(libraryId, sha256) as { id: string } | undefined;

  // 命中指纹：三阶段全部已完成 → 直接复用，不做任何重复加工
  const existingBlob = db
    .prepare('SELECT * FROM asset_blob WHERE library_id = ? AND sha256 = ?')
    .get(libraryId, sha256) as BlobRow | undefined;
  const reused = Boolean(
    existingBlob && existingBlob.file_ready && existingBlob.thumb_ready && existingBlob.palette_ready,
  );

  const blob = await processBlobWithLock(libraryId, sha256, buffer);
  const { elevation, azimuth } = sunPosition(blob.shot_at, spot ?? null);

  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO asset (id, library_id, inspiration_id, role, file_path, thumb_path, mime, width, height, bytes,
       sha256, blob_id, shot_at, camera_model, lens, iso, aperture, shutter, has_gps_exif, palette,
       sun_elevation, sun_azimuth, weather_snapshot, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    libraryId,
    inspirationId,
    role,
    blob.file_path,
    blob.thumb_path,
    blob.mime,
    blob.width,
    blob.height,
    blob.bytes,
    sha256,
    blob.id,
    blob.shot_at,
    blob.camera_model,
    blob.lens,
    blob.iso,
    blob.aperture,
    blob.shutter,
    blob.has_gps_exif,
    blob.palette,
    elevation,
    azimuth,
    null,
    ts,
    ts,
  );

  emitEvent({
    type: 'asset_processed',
    libraryId,
    payload: {
      assetId: id,
      inspirationId,
      width: blob.width,
      height: blob.height,
      reusedFingerprint: reused,
    },
  });

  return {
    assetId: id,
    duplicateOf: previous?.id ?? null,
    reusedFingerprint: reused,
    hasGpsExif: blob.has_gps_exif === 1,
    shotAt: blob.shot_at,
    width: blob.width,
    height: blob.height,
  };
}

export function assetAbsolutePath(row: AssetRow, kind: 'file' | 'thumb'): string | null {
  const p = kind === 'file' ? row.file_path : row.thumb_path;
  if (!p) return null;
  return p;
}

export function paletteOf(row: AssetRow): PaletteColor[] {
  return parseJson<PaletteColor[]>(row.palette, []);
}

/** 分享图：另存一份并剥离全部 EXIF（文档 11.3 / 13.4）。
 *  路径按**内容指纹**命名而不是 asset id：替换原图后旧文件必然失效，不会被继续暴露。 */
export async function shareImageFor(row: AssetRow, libraryId: string): Promise<string> {
  const fingerprint = row.sha256 ?? crypto.createHash('sha256').update(row.id).digest('hex').slice(0, 32);
  const target = path.join(config.shareDir, libraryId, `${fingerprint}.jpg`);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await sharp(row.file_path, { failOn: 'none' })
    .rotate()
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toFile(target);
  return target;
}

/** 某指纹对应的分享图路径（无论是否已生成） */
function shareImagePath(libraryId: string, sha256: string | null, assetId: string): string {
  const fingerprint = sha256 ?? crypto.createHash('sha256').update(assetId).digest('hex').slice(0, 32);
  return path.join(config.shareDir, libraryId, `${fingerprint}.jpg`);
}

/**
 * 替换 asset 原图（文档 11.3）：
 * 新指纹加工 → 切换 asset 引用 → 旧分享图立即删除 → 释放无引用旧 blob。
 * 标注（composition_note）挂在 asset 上，继续保留。
 */
export async function replaceAssetOriginal(params: {
  row: AssetRow;
  buffer: Buffer;
  spot?: { lat: number; lng: number; tz: string } | null;
}): Promise<IngestResult> {
  const db = getDb();
  const { row, buffer, spot } = params;
  const oldBlobId = row.blob_id;
  const oldSharePath = shareImagePath(row.library_id, row.sha256, row.id);

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (row.sha256 === sha256) {
    // 新旧内容一致：无需替换
    return {
      assetId: row.id,
      duplicateOf: null,
      reusedFingerprint: true,
      hasGpsExif: row.has_gps_exif === 1,
      shotAt: row.shot_at,
      width: row.width,
      height: row.height,
    };
  }

  const blob = await processBlobWithLock(row.library_id, sha256, buffer);
  const { elevation, azimuth } = sunPosition(blob.shot_at, spot ?? null);
  const ts = nowIso();

  const switchRow = db.transaction(() => {
    db.prepare(
      `UPDATE asset SET file_path=?, thumb_path=?, mime=?, width=?, height=?, bytes=?, sha256=?, blob_id=?,
         shot_at=?, camera_model=?, lens=?, iso=?, aperture=?, shutter=?, has_gps_exif=?, palette=?,
         sun_elevation=?, sun_azimuth=?, updated_at=? WHERE id=?`,
    ).run(
      blob.file_path,
      blob.thumb_path,
      blob.mime,
      blob.width,
      blob.height,
      blob.bytes,
      sha256,
      blob.id,
      blob.shot_at,
      blob.camera_model,
      blob.lens,
      blob.iso,
      blob.aperture,
      blob.shutter,
      blob.has_gps_exif,
      blob.palette,
      elevation,
      azimuth,
      ts,
      row.id,
    );
    // 旧分享图必须立即消失（撤销"文件还在磁盘上、链接仍能命中"的暴露面）
    try {
      fs.rmSync(oldSharePath, { force: true });
    } catch {
      /* 删除失败不阻断替换 */
    }
  });
  switchRow();

  if (oldBlobId) releaseBlob(oldBlobId);
  else {
    // 极少数迁移前且无指纹的历史行：旧文件不属于任何 blob，替换后直接回收
    for (const p of [row.file_path, row.thumb_path]) {
      if (!p || p === blob.file_path || p === blob.thumb_path) continue;
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* 忽略文件删除失败 */
      }
    }
  }

  emitEvent({
    type: 'asset_processed',
    libraryId: row.library_id,
    payload: { assetId: row.id, inspirationId: row.inspiration_id, width: blob.width, height: blob.height, replaced: true },
  });

  return {
    assetId: row.id,
    duplicateOf: null,
    reusedFingerprint: false,
    hasGpsExif: blob.has_gps_exif === 1,
    shotAt: blob.shot_at,
    width: blob.width,
    height: blob.height,
  };
}

/** 释放无引用 blob（引用计数归零才删文件）；历史 blob_id 为空的行只删自己的旧文件 */
function releaseBlob(blobId: string): void {
  const db = getDb();
  const refs = (
    db.prepare('SELECT COUNT(*) AS n FROM asset WHERE blob_id = ?').get(blobId) as { n: number }
  ).n;
  if (refs > 0) return;
  const blob = db.prepare('SELECT * FROM asset_blob WHERE id = ?').get(blobId) as BlobRow | undefined;
  if (!blob) return;
  db.prepare('DELETE FROM asset_blob WHERE id = ?').run(blobId);
  for (const p of [blob.file_path, blob.thumb_path, shareImagePath(blob.library_id, blob.sha256, '')]) {
    if (!p) continue;
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* 忽略文件删除失败 */
    }
  }
}

/**
 * 删除 asset：blob 行先解绑，再按引用计数回收物理文件；
 * 该指纹的分享图在最后一个引用消失时一并删除。
 */
export function deleteAssetFiles(row: AssetRow): void {
  if (!row.blob_id) {
    // 历史数据（迁移前的 asset，无 blob 归属）：直接删自己名下文件
    for (const p of [row.file_path, row.thumb_path]) {
      if (!p) continue;
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* 忽略文件删除失败 */
      }
    }
    return;
  }
  releaseBlob(row.blob_id);
}

/** 资源版本号：内容变了版本就变，用于 URL 缓存击穿（替换原图后浏览器不可能再用旧缓存）。
 *  入参兼容 AssetRow（snake_case）与 AssetDto（camelCase）。 */
export function assetVersion(row: {
  sha256?: string | null;
  updated_at?: string | null;
  updatedAt?: string | null;
}): string {
  return (row.sha256 ?? row.updated_at ?? row.updatedAt ?? '').slice(0, 16);
}
