-- 内容寻址的图片指纹表（文档 11.3 增强）：
-- 同一份字节（同库内 sha256 相同）只做一次"落盘 → 缩略图 → 色板"，
-- asset 行只引用 blob；处理按阶段落状态，中断后重传可从断点续跑。
CREATE TABLE IF NOT EXISTS asset_blob (
  id              TEXT PRIMARY KEY,
  library_id      TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  sha256          TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  thumb_path      TEXT,
  mime            TEXT,
  width           INTEGER NOT NULL DEFAULT 0,
  height          INTEGER NOT NULL DEFAULT 0,
  bytes           INTEGER NOT NULL DEFAULT 0,
  shot_at         TEXT,
  camera_model    TEXT,
  lens            TEXT,
  iso             INTEGER,
  aperture        TEXT,
  shutter         TEXT,
  has_gps_exif    INTEGER NOT NULL DEFAULT 0,
  palette         TEXT NOT NULL DEFAULT '[]',
  -- 处理阶段（断点续跑）：file 落盘后即可确认；thumb/palette 各自独立完成
  file_ready      INTEGER NOT NULL DEFAULT 0,
  thumb_ready     INTEGER NOT NULL DEFAULT 0,
  palette_ready   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (library_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_asset_blob_sha ON asset_blob(library_id, sha256);

-- asset 反向引用 blob；历史数据回填 blob_id 为 NULL，按旧路径逻辑继续工作
ALTER TABLE asset ADD COLUMN blob_id TEXT REFERENCES asset_blob(id) ON DELETE SET NULL;

-- 把已有带指纹的 asset 登记进 asset_blob（选最早一条作为规范行；
-- 同指纹的其他 asset 一并指向它，文件不复制、不删除）。
INSERT INTO asset_blob (
  id, library_id, sha256, file_path, thumb_path, mime, width, height, bytes,
  shot_at, camera_model, lens, iso, aperture, shutter, has_gps_exif, palette,
  file_ready, thumb_ready, palette_ready, created_at, updated_at
)
SELECT
  'b' || substr(a.id, 2),
  a.library_id,
  a.sha256,
  a.file_path,
  a.thumb_path,
  a.mime,
  a.width,
  a.height,
  a.bytes,
  a.shot_at,
  a.camera_model,
  a.lens,
  a.iso,
  a.aperture,
  a.shutter,
  a.has_gps_exif,
  a.palette,
  1,
  CASE WHEN a.thumb_path IS NOT NULL THEN 1 ELSE 0 END,
  CASE WHEN a.palette <> '[]' THEN 1 ELSE 0 END,
  a.created_at,
  a.updated_at
FROM asset a
WHERE a.sha256 IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM asset b
    WHERE b.library_id = a.library_id
      AND b.sha256 = a.sha256
      AND (b.created_at < a.created_at OR (b.created_at = a.created_at AND b.id < a.id))
  );

UPDATE asset
SET blob_id = (
  SELECT bl.id FROM asset_blob bl
  WHERE bl.library_id = asset.library_id AND bl.sha256 = asset.sha256
)
WHERE asset.sha256 IS NOT NULL;
