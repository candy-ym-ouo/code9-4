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
import { parseExif, type ExifInfo } from './exif.js';
import { extractPalette } from './paletteExtract.js';
import { emitEvent } from './events.js';
import { logger } from '../logger.js';

export interface AssetRow {
  id: string;
  library_id: string;
  inspiration_id: string;
  role: AssetRole;
  blob_id: string | null;
  content_version: number;
  file_path: string;
  thumb_path: string | null;
  mime: string | null;
  width: number;
  height: number;
  bytes: number;
  sha256: string | null;
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

export interface AssetBlobRow {
  id: string;
  library_id: string;
  sha256: string;
  file_path: string;
  thumb_path: string | null;
  mime: string | null;
  width: number;
  height: number;
  bytes: number;
  palette: string;
  shot_at: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  aperture: string | null;
  shutter: string | null;
  has_gps_exif: number;
  created_at: string;
}

function subdir(date = new Date()): string {
  return path.join(String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'));
}

export interface IngestResult {
  assetId: string;
  duplicateOf: string | null;
  reusedFingerprint: boolean;
  resumed: boolean;
  hasGpsExif: boolean;
  shotAt: string | null;
  width: number;
  height: number;
}

interface DerivedInfo {
  file_path: string;
  thumb_path: string | null;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  palette: PaletteColor[];
  shot_at: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  aperture: string | null;
  shutter: string | null;
  has_gps_exif: boolean;
}

interface StageMeta {
  libraryId: string;
  sha256: string;
  sourceBytes: number;
  ext: string;
}

// ---------------------------------------------------------------------------
// 断点续跑：落盘阶段产物都在 <uploads>/.staging/<library>/<sha>/ 下，阶段已存在即跳过。
// 同一 (library, sha) 串行化，避免两个并发请求重复跑 sharp。
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<{ blob: AssetBlobRow; resumed: boolean }>>();

function stageDir(libraryId: string, sha256: string): string {
  return path.join(config.uploadDir, '.staging', libraryId, sha256);
}

function readStageMeta(dir: string): StageMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as StageMeta;
  } catch {
    return null;
  }
}

/**
 * 阶段 4 的移动：覆盖"上次崩溃在移动之后、落库之前"的中间态——
 * 目标已存在时直接复用；源已不存在（已被上次移动）也视为成功。
 */
function moveIntoPlace(src: string, target: string): void {
  if (fs.existsSync(target)) {
    if (fs.existsSync(src)) {
      try {
        fs.rmSync(src, { force: true });
      } catch {
        /* 忽略 */
      }
    }
    return;
  }
  if (!fs.existsSync(src)) return; // 等下次重传 source 后重建本阶段
  fs.renameSync(src, target);
}

function findBlob(libraryId: string, sha256: string): AssetBlobRow | undefined {
  return getDb()
    .prepare('SELECT * FROM asset_blob WHERE library_id = ? AND sha256 = ?')
    .get(libraryId, sha256) as AssetBlobRow | undefined;
}

/**
 * 找/建内容指纹 blob。命中即复用原图、缩略图与色板，不再跑任何重编码；
 * 未命中则走可续跑暂存管线。同一指纹并发时只跑一次。
 */
async function getOrCreateBlob(
  libraryId: string,
  sha256: string,
  buffer: Buffer,
): Promise<{ blob: AssetBlobRow; reused: boolean; resumed: boolean }> {
  const key = `${libraryId}/${sha256}`;
  const running = inflight.get(key);
  if (running) {
    const result = await running;
    return { blob: result.blob, reused: true, resumed: result.resumed };
  }
  const task = createBlob(libraryId, sha256, buffer);
  const promise = task
    .then((result) => ({ blob: result.blob, resumed: result.resumed }))
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return task;
}

/**
 * 阶段化管线（文档 11.3）：
 * meta+source → 原图重编码 → 缩略图 → 元数据/EXIF/主色 → 原子发布落库。
 * 每个阶段产物存在即跳过，因此中断后重传同一文件可续跑，启动恢复也走这里。
 */
async function createBlob(
  libraryId: string,
  sha256: string,
  buffer: Buffer | null,
): Promise<{ blob: AssetBlobRow; reused: boolean; resumed: boolean }> {
  const db = getDb();
  const existing = findBlob(libraryId, sha256);
  if (existing) return { blob: existing, reused: true, resumed: false };

  const dir = stageDir(libraryId, sha256);
  const hadStagedSource = fs.existsSync(path.join(dir, 'source'));
  fs.mkdirSync(dir, { recursive: true });

  // 阶段 0：原始字节。崩溃发生在此之后都无需重跑前面阶段。
  const sourcePath = path.join(dir, 'source');
  if (!fs.existsSync(sourcePath)) {
    if (!buffer) throw Object.assign(new Error('stage_source_missing'), { code: 'STAGE_SOURCE_MISSING' });
    fs.writeFileSync(sourcePath, buffer);
  }
  const source = buffer ?? fs.readFileSync(sourcePath);

  let meta = readStageMeta(dir);
  if (!meta) {
    const probe = await sharp(source, { failOn: 'none' }).metadata();
    const ext = probe.format === 'png' ? 'png' : probe.format === 'webp' ? 'webp' : 'jpg';
    meta = { libraryId, sha256, sourceBytes: source.byteLength, ext };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  }

  // 阶段 1：原图（按 EXIF 方向摆正后重编码）
  const encodedPath = path.join(dir, `encoded.${meta.ext}`);
  if (!fs.existsSync(encodedPath)) {
    try {
      await sharp(source, { failOn: 'none' }).rotate().toFile(encodedPath);
    } catch {
      fs.writeFileSync(encodedPath, source);
    }
  }

  // 阶段 2：缩略图
  const thumbStagePath = path.join(dir, 'thumb.webp');
  if (!fs.existsSync(thumbStagePath)) {
    await sharp(source, { failOn: 'none' })
      .rotate()
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(thumbStagePath)
      .catch(() => undefined);
  }

  // 阶段 3：EXIF + 主色（产物写 derived.json，崩溃后本阶段整体跳过）
  const derivedPath = path.join(dir, 'derived.json');
  let derived: DerivedInfo;
  if (fs.existsSync(derivedPath)) {
    derived = JSON.parse(fs.readFileSync(derivedPath, 'utf8')) as DerivedInfo;
  } else {
    const metadata = await sharp(source, { failOn: 'none' }).metadata();
    const exif: ExifInfo = parseExif(metadata.exif as Buffer | undefined);

    let palette: PaletteColor[] = [];
    try {
      palette = await extractPalette(encodedPath);
    } catch (err) {
      logger.warn('palette 提取失败', { sha256, error: String(err) });
    }

    const monthDir = subdir();
    const thumbExists = fs.existsSync(thumbStagePath);
    derived = {
      file_path: path.join(config.uploadDir, libraryId, monthDir, `${sha256}.${meta.ext}`),
      thumb_path: thumbExists ? path.join(config.thumbDir, libraryId, monthDir, `${sha256}.webp`) : null,
      mime: metadata.format ? `image/${metadata.format}` : 'image/jpeg',
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      bytes: meta.sourceBytes,
      palette,
      shot_at: exif.shotAt ? exif.shotAt.toISOString() : null,
      camera_model: exif.cameraModel,
      lens: exif.lens,
      iso: exif.iso,
      aperture: exif.aperture,
      shutter: exif.shutter,
      has_gps_exif: exif.hasGps,
    };
    fs.writeFileSync(derivedPath, JSON.stringify(derived));
  }

  // 阶段 4：发布到最终目录 + 落库（事务，防止半成品行；并发同指纹时赢家只有一个）
  fs.mkdirSync(path.dirname(derived.file_path), { recursive: true });
  moveIntoPlace(encodedPath, derived.file_path);
  if (derived.thumb_path) {
    fs.mkdirSync(path.dirname(derived.thumb_path), { recursive: true });
    moveIntoPlace(thumbStagePath, derived.thumb_path);
  }

  let blob: AssetBlobRow | undefined;
  let lostRace = false;
  const commit = db.transaction(() => {
    const concurrent = findBlob(libraryId, sha256);
    if (concurrent) {
      blob = concurrent;
      lostRace = true;
      return;
    }
    const id = newId();
    db.prepare(
      `INSERT INTO asset_blob
         (id, library_id, sha256, file_path, thumb_path, mime, width, height, bytes, palette,
          shot_at, camera_model, lens, iso, aperture, shutter, has_gps_exif, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      libraryId,
      sha256,
      derived.file_path,
      derived.thumb_path,
      derived.mime,
      derived.width,
      derived.height,
      derived.bytes,
      toJson(derived.palette),
      derived.shot_at,
      derived.camera_model,
      derived.lens,
      derived.iso,
      derived.aperture,
      derived.shutter,
      derived.has_gps_exif ? 1 : 0,
      nowIso(),
    );
    blob = db.prepare('SELECT * FROM asset_blob WHERE id = ?').get(id) as AssetBlobRow;
  });
  commit();

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 暂存清理失败不影响正确性 */
  }

  // 抢跑（另一并发请求刚落库同一指纹）算复用；否则 resumed 表示接管了中断暂存
  return { blob: blob!, reused: lostRace, resumed: !lostRace && hadStagedSource };
}

function sunPosition(
  shotAt: string | null,
  spot: { lat: number; lng: number; tz: string } | null,
): { elevation: number | null; azimuth: number | null } {
  if (!shotAt || !spot) return { elevation: null, azimuth: null };
  const parts = utcToZonedParts(new Date(shotAt), 'UTC'); // EXIF 是"相机本地时间"
  const instant = zonedTimeToUtc(spot.tz, parts.year, parts.month, parts.day, parts.hour, parts.minute);
  return { elevation: elevationAt(instant, spot.lat, spot.lng), azimuth: azimuthAt(instant, spot.lat, spot.lng) };
}

/** EXIF 中的 GPS **默认不落库**，只记录布尔位并提示用户。 */
function insertAssetRow(params: {
  blob: AssetBlobRow;
  libraryId: string;
  inspirationId: string;
  role: AssetRole;
  spot: { lat: number; lng: number; tz: string } | null;
}): string {
  const { blob, libraryId, inspirationId, role, spot } = params;
  const sun = sunPosition(blob.shot_at, spot);
  const id = newId();
  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO asset (id, library_id, inspiration_id, role, blob_id, content_version, file_path, thumb_path, mime,
         width, height, bytes, sha256, shot_at, camera_model, lens, iso, aperture, shutter, has_gps_exif, palette,
         sun_elevation, sun_azimuth, weather_snapshot, created_at, updated_at)
       VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      libraryId,
      inspirationId,
      role,
      blob.id,
      blob.file_path,
      blob.thumb_path,
      blob.mime,
      blob.width,
      blob.height,
      blob.bytes,
      blob.sha256,
      blob.shot_at,
      blob.camera_model,
      blob.lens,
      blob.iso,
      blob.aperture,
      blob.shutter,
      blob.has_gps_exif,
      blob.palette,
      sun.elevation,
      sun.azimuth,
      null,
      ts,
      ts,
    );
  return id;
}

/**
 * 单张图片入库管线（文档 11.3）：
 * 算指纹 → 命中 blob 则复用原图/缩略图/色板与 EXIF → 否则走可续跑的暂存管线。
 */
export async function ingestAsset(params: {
  libraryId: string;
  inspirationId: string;
  role: AssetRole;
  buffer: Buffer;
  /** 若已知机位坐标，则用拍摄时刻计算当时太阳位置 */
  spot?: { lat: number; lng: number; tz: string } | null;
}): Promise<IngestResult> {
  const { libraryId, inspirationId, role, buffer, spot } = params;

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = getDb()
    .prepare('SELECT id FROM asset WHERE library_id = ? AND sha256 = ? ORDER BY created_at LIMIT 1')
    .get(libraryId, sha256) as { id: string } | undefined;

  const { blob, reused, resumed } = await getOrCreateBlob(libraryId, sha256, buffer);
  const assetId = insertAssetRow({ blob, libraryId, inspirationId, role, spot: spot ?? null });

  emitEvent({
    type: 'asset_processed',
    libraryId,
    payload: { assetId, inspirationId, width: blob.width, height: blob.height, reusedFingerprint: reused },
  });

  return {
    assetId,
    duplicateOf: existing?.id ?? null,
    reusedFingerprint: reused,
    resumed,
    hasGpsExif: blob.has_gps_exif === 1,
    shotAt: blob.shot_at,
    width: blob.width,
    height: blob.height,
  };
}

/**
 * 启动恢复：把暂存区里有 source 但尚未落 blob 的任务补完。
 * 缺 source 的残留目录直接清掉（客户端重传即续跑）。
 */
export async function recoverInterruptedIngests(): Promise<{ recovered: number; pruned: number }> {
  const root = path.join(config.uploadDir, '.staging');
  let recovered = 0;
  let pruned = 0;
  if (!fs.existsSync(root)) return { recovered, pruned };

  for (const libraryId of fs.readdirSync(root)) {
    const libDir = path.join(root, libraryId);
    for (const sha256 of fs.readdirSync(libDir)) {
      const dir = path.join(libDir, sha256);
      if (!fs.existsSync(path.join(dir, 'source'))) {
        fs.rmSync(dir, { recursive: true, force: true });
        pruned += 1;
        continue;
      }
      // blob 已存在却还留着暂存（上次清理失败）：直接回收暂存目录
      if (findBlob(libraryId, sha256)) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      try {
        const { reused } = await createBlob(libraryId, sha256, null);
        if (!reused) recovered += 1;
      } catch (err) {
        logger.warn('恢复中断的图片处理失败，等待客户端重传续跑', {
          libraryId,
          sha256,
          error: String(err),
        });
      }
    }
  }
  if (recovered || pruned) logger.info('图片处理暂存区已恢复', { recovered, pruned });
  return { recovered, pruned };
}

export function assetAbsolutePath(row: AssetRow, kind: 'file' | 'thumb'): string | null {
  const p = kind === 'file' ? row.file_path : row.thumb_path;
  if (!p) return null;
  return p;
}

export function paletteOf(row: AssetRow): PaletteColor[] {
  return parseJson<PaletteColor[]>(row.palette, []);
}

// ---------------------------------------------------------------------------
// 分享图：另存一份并剥离全部 EXIF（文档 11.3 / 13.4）。
// 文件名带内容版本 → 替换原图后旧分享图物理上不可能再被命中，并被主动删除。
// ---------------------------------------------------------------------------

function shareImagePath(row: AssetRow, libraryId: string): string {
  return path.join(config.shareDir, libraryId, `${row.id}.v${row.content_version}.jpg`);
}

function shareImageGenerations(libraryId: string, assetId: string): string[] {
  const dir = path.join(config.shareDir, libraryId);
  if (!fs.existsSync(dir)) return [];
  const prefix = `${assetId}.v`;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.jpg'))
    .map((f) => path.join(dir, f));
  // 迁移前的旧版分享图（<id>.jpg）也视为过期代际
  const legacy = path.join(dir, `${assetId}.jpg`);
  if (fs.existsSync(legacy)) files.push(legacy);
  return files;
}

export async function shareImageFor(row: AssetRow, libraryId: string): Promise<string> {
  const target = shareImagePath(row, libraryId);
  if (fs.existsSync(target)) return target;
  // 顺手清掉历史版本（正常情况下替换原图时已删，这里是兜底）
  for (const old of shareImageGenerations(libraryId, row.id)) {
    if (old !== target) {
      try {
        fs.rmSync(old, { force: true });
      } catch {
        /* 忽略清理失败 */
      }
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await sharp(row.file_path, { failOn: 'none' })
    .rotate()
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toFile(target);
  return target;
}

/** 删除 asset 对应的分享图（全部历史版本），撤销/删除时调用 */
export function deleteShareImages(libraryId: string, assetId: string): void {
  for (const p of shareImageGenerations(libraryId, assetId)) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* 忽略文件删除失败 */
    }
  }
}

/**
 * 替换原图：新指纹走同一套内容寻址管线（可能直接命中别的图的 blob）；
 * asset 行改指新 blob 并自增 content_version，旧分享图立即删除；
 * 旧 blob 无引用时回收其原图与缩略图。
 */
export async function replaceAssetImage(params: {
  row: AssetRow;
  buffer: Buffer;
  spot?: { lat: number; lng: number; tz: string } | null;
}): Promise<{ changed: boolean; sha256: string; reusedFingerprint: boolean; resumed: boolean }> {
  const { row, buffer, spot } = params;
  const db = getDb();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (row.sha256 === sha256) {
    return { changed: false, sha256, reusedFingerprint: true, resumed: false };
  }

  const { blob, reused, resumed } = await getOrCreateBlob(row.library_id, sha256, buffer);
  const sun = sunPosition(blob.shot_at, spot ?? null);
  const oldBlobId = row.blob_id;
  const version = row.content_version + 1;

  const commit = db.transaction(() => {
    db.prepare(
      `UPDATE asset SET blob_id = ?, file_path = ?, thumb_path = ?, mime = ?, width = ?, height = ?, bytes = ?,
         sha256 = ?, shot_at = ?, camera_model = ?, lens = ?, iso = ?, aperture = ?, shutter = ?,
         has_gps_exif = ?, palette = ?, sun_elevation = ?, sun_azimuth = ?, weather_snapshot = NULL,
         content_version = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      blob.id,
      blob.file_path,
      blob.thumb_path,
      blob.mime,
      blob.width,
      blob.height,
      blob.bytes,
      sha256,
      blob.shot_at,
      blob.camera_model,
      blob.lens,
      blob.iso,
      blob.aperture,
      blob.shutter,
      blob.has_gps_exif,
      blob.palette,
      sun.elevation,
      sun.azimuth,
      version,
      nowIso(),
      row.id,
    );
  });
  commit();

  // 旧分享图与缓存：物理删除 + 版本化路径，确保不会继续暴露
  deleteShareImages(row.library_id, row.id);
  if (oldBlobId) releaseBlobIfOrphan(oldBlobId);

  emitEvent({
    type: 'asset_processed',
    libraryId: row.library_id,
    payload: { assetId: row.id, inspirationId: row.inspiration_id, width: blob.width, height: blob.height, replaced: true },
  });

  return { changed: true, sha256, reusedFingerprint: reused, resumed };
}

/** 旧 blob 无任何 asset 引用时，删除其原图与缩略图文件并移除指纹行 */
export function releaseBlobIfOrphan(blobId: string): void {
  const db = getDb();
  const refs = (db.prepare('SELECT COUNT(*) AS n FROM asset WHERE blob_id = ?').get(blobId) as { n: number }).n;
  if (refs > 0) return;
  const blob = db.prepare('SELECT * FROM asset_blob WHERE id = ?').get(blobId) as AssetBlobRow | undefined;
  if (!blob) return;
  for (const p of [blob.file_path, blob.thumb_path]) {
    if (!p) continue;
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* 忽略文件删除失败 */
    }
  }
  db.prepare('DELETE FROM asset_blob WHERE id = ?').run(blobId);
}
