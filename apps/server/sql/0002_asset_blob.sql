-- 图片内容寻址指纹表（文档 11.3）：
-- 同一张图（sha256 相同）在同一库内只做一次重编码 / 缩略图 / 主色提取，
-- asset 行只引用 blob，重复上传直接复用产物。
CREATE TABLE IF NOT EXISTS asset_blob (
  id           TEXT PRIMARY KEY,
  library_id   TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  sha256       TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  thumb_path   TEXT,
  mime         TEXT,
  width        INTEGER NOT NULL DEFAULT 0,
  height       INTEGER NOT NULL DEFAULT 0,
  bytes        INTEGER NOT NULL DEFAULT 0,
  palette      TEXT NOT NULL DEFAULT '[]',
  shot_at      TEXT,
  camera_model TEXT,
  lens         TEXT,
  iso          INTEGER,
  aperture     TEXT,
  shutter      TEXT,
  has_gps_exif INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  UNIQUE (library_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_asset_blob_sha ON asset_blob(library_id, sha256);

-- asset 关联到 blob；content_version 在替换原图后自增，用于让旧分享图与浏览器缓存失效
ALTER TABLE asset ADD COLUMN blob_id TEXT REFERENCES asset_blob(id) ON DELETE SET NULL;
ALTER TABLE asset ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- 回填：把存量 asset 的文件登记为 blob，重复 sha 合并到同一条 blob。
-- 1) 每个 (library_id, sha256) 选最早的 asset 作为代表，创建 blob；
-- 2) 无 sha 的存量 asset 用占位指纹（old:<assetId>）各自成 blob；
-- 3) 重复 asset 的路径改指代表行的产物（缩略图/主色随之复用）。
INSERT INTO asset_blob (id, library_id, sha256, file_path, thumb_path, mime, width, height, bytes, palette,
  shot_at, camera_model, lens, iso, aperture, shutter, has_gps_exif, created_at)
SELECT
  'b_' || a.id,
  a.library_id,
  COALESCE(a.sha256, 'old:' || a.id),
  a.file_path,
  a.thumb_path,
  a.mime,
  a.width,
  a.height,
  a.bytes,
  a.palette,
  a.shot_at,
  a.camera_model,
  a.lens,
  a.iso,
  a.aperture,
  a.shutter,
  a.has_gps_exif,
  a.created_at
FROM asset a
WHERE a.id IN (
  SELECT MIN(id) FROM asset GROUP BY library_id, COALESCE(sha256, 'old:' || id)
);

UPDATE asset
SET blob_id = (
  SELECT b.id FROM asset_blob b
  WHERE b.library_id = asset.library_id
    AND b.sha256 = COALESCE(asset.sha256, 'old:' || asset.id)
);

-- 重复指纹的 asset 改用代表 blob 的文件路径，磁盘上的旧文件由巡检清理（保留不影响正确性）
UPDATE asset
SET file_path = (
  SELECT b.file_path FROM asset_blob b WHERE b.id = asset.blob_id
),
thumb_path = (
  SELECT b.thumb_path FROM asset_blob b WHERE b.id = asset.blob_id
);

CREATE INDEX IF NOT EXISTS idx_asset_blob_id ON asset(blob_id);
