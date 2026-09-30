import { Router } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import { createAlbumSchema, type FuzzLevel } from '@flil/shared';
import { getDb, newId, nowIso, toJson } from '../db.js';
import { ah, ok } from '../http/respond.js';
import { authenticate, requireOwner } from '../http/middleware.js';
import { ctxOf } from '../http/context.js';
import { errors } from '../http/errors.js';
import {
  addItem,
  albumItemsDetailed,
  autoMatch,
  coverAsset,
  createAlbum,
  getSnapshot,
  listAlbums,
  listGaps,
  normalizeRules,
  publishAlbum,
  regenerateGaps,
  removeItem,
  reorderItems,
  requireAlbum,
  scoreCandidates,
  waiveGap,
} from '../services/albums.js';
import { toAlbumDto } from '../services/serialization.js';
import { createShareLink } from '../services/share.js';
import { assetVersion } from '../services/assets.js';
import { sendImage } from '../http/sendImage.js';

export const albumRouter = Router();
albumRouter.use(authenticate());

albumRouter.get(
  '/albums',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, { items: listAlbums(ctx.libraryId) });
  }),
);

albumRouter.post(
  '/albums',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = createAlbumSchema.parse(req.body);
    const id = createAlbum({
      libraryId: ctx.libraryId,
      title: input.title,
      themeNote: input.themeNote ?? null,
      rules: normalizeRules(input.rules),
    });
    regenerateGaps(id, ctx.libraryId);
    ok(res, { id }, 201);
  }),
);

albumRouter.get(
  '/albums/:id',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const album = requireAlbum(req.params.id, ctx.libraryId);
    ok(res, {
      item: toAlbumDto(album),
      rules: normalizeRules(album.rules),
      items: albumItemsDetailed(req.params.id, ctx),
      gaps: listGaps(req.params.id),
    });
  }),
);

albumRouter.patch(
  '/albums/:id',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    requireAlbum(req.params.id, ctx.libraryId);
    const input = z
      .object({
        title: z.string().min(1).max(120).optional(),
        themeNote: z.string().max(2000).nullable().optional(),
        rules: z.record(z.unknown()).optional(),
      })
      .parse(req.body);
    const db = getDb();
    if (input.title) db.prepare('UPDATE album SET title = ?, updated_at = ? WHERE id = ?').run(input.title, nowIso(), req.params.id);
    if (input.themeNote !== undefined) {
      db.prepare('UPDATE album SET theme_note = ?, updated_at = ? WHERE id = ?').run(input.themeNote, nowIso(), req.params.id);
    }
    if (input.rules) {
      db.prepare('UPDATE album SET rules = ?, updated_at = ? WHERE id = ?').run(
        toJson(normalizeRules(input.rules)),
        nowIso(),
        req.params.id,
      );
    }
    // 先重算缺口再构建 DTO，否则返回的是重算前的陈旧状态
    const gaps = regenerateGaps(req.params.id, ctx.libraryId);
    const album = requireAlbum(req.params.id, ctx.libraryId);
    ok(res, { item: toAlbumDto(album), gaps });
  }),
);

albumRouter.post(
  '/albums/:id/auto-match',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const result = autoMatch(req.params.id, ctx.libraryId);
    const album = requireAlbum(req.params.id, ctx.libraryId);
    ok(res, { ...result, item: toAlbumDto(album), gaps: listGaps(req.params.id) });
  }),
);

/** 推荐候选：必须同时给出"为什么推荐这张"（文档 14.3） */
albumRouter.get(
  '/albums/:id/recommend',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const album = requireAlbum(req.params.id, ctx.libraryId);
    const rules = normalizeRules(album.rules);
    const candidates = scoreCandidates(ctx.libraryId, rules, req.params.id).slice(0, 20);
    ok(res, {
      items: candidates.map((c) => ({
        inspirationId: c.inspirationId,
        score: c.score,
        reasons: c.reasons,
      })),
    });
  }),
);

albumRouter.post(
  '/albums/:id/items',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = z
      .object({ inspirationId: z.string().min(1), caption: z.string().max(300).nullable().optional() })
      .parse(req.body);
    addItem(req.params.id, input.inspirationId, ctx.libraryId, input.caption ?? null);
    ok(res, { gaps: listGaps(req.params.id) }, 201);
  }),
);

albumRouter.delete(
  '/albums/:id/items/:inspirationId',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    removeItem(req.params.id, req.params.inspirationId, ctx.libraryId);
    ok(res, { gaps: listGaps(req.params.id) });
  }),
);

albumRouter.put(
  '/albums/:id/items/order',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = z.object({ orderedIds: z.array(z.string()).min(1) }).parse(req.body);
    reorderItems(req.params.id, ctx.libraryId, input.orderedIds);
    ok(res, { ordered: input.orderedIds.length });
  }),
);

albumRouter.get(
  '/albums/:id/gaps',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    requireAlbum(req.params.id, ctx.libraryId);
    ok(res, { items: regenerateGaps(req.params.id, ctx.libraryId) });
  }),
);

albumRouter.post(
  '/albums/:id/gaps/:gapId/waive',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const { reason } = z.object({ reason: z.string().min(1).max(300) }).parse(req.body);
    waiveGap(req.params.id, req.params.gapId, ctx.libraryId, reason);
    ok(res, { waived: true, gaps: listGaps(req.params.id) });
  }),
);

/**
 * 发布：存在必需缺口则 409；发布生成不可变快照，并可同时创建对外分享链接。
 * 分享级别强制不低于 g500（安全底线）。
 */
albumRouter.post(
  '/albums/:id/publish',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    requireAlbum(req.params.id, ctx.libraryId);
    const input = z
      .object({
        createShare: z.boolean().default(false),
        fuzzLevel: z
          .enum(['exact', 'g100', 'g500', 'g1k', 'neighborhood', 'district'])
          .default('g500'),
        expiresInDays: z.number().int().min(1).max(365).default(7),
        password: z.string().min(4).max(64).nullable().optional(),
      })
      .parse(req.body ?? {});

    let share: { token: string } | null = null;
    if (input.createShare) {
      const link = createShareLink({
        libraryId: ctx.libraryId,
        scope: 'album',
        scopeId: req.params.id,
        fuzzLevel: input.fuzzLevel as FuzzLevel,
        expiresInDays: input.expiresInDays,
        password: input.password ?? null,
        userId: req.auth!.id,
      });
      share = { token: link.token };
    }

    const result = publishAlbum(req.params.id, ctx.libraryId, ctx, share);
    const album = requireAlbum(req.params.id, ctx.libraryId);
    ok(res, { ...result, item: toAlbumDto(album) }, 201);
  }),
);

albumRouter.get(
  '/albums/:id/snapshots',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    requireAlbum(req.params.id, ctx.libraryId);
    const rows = getDb()
      .prepare('SELECT id, version, payload_hash, created_at FROM album_snapshot WHERE album_id = ? ORDER BY version DESC')
      .all(req.params.id);
    ok(res, { items: rows, latest: getSnapshot(req.params.id) });
  }),
);

albumRouter.get(
  '/albums/:id/cover',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    requireAlbum(req.params.id, ctx.libraryId);
    const asset = coverAsset(req.params.id);
    if (!asset) throw errors.notFound('封面图');
    const thumbExists = Boolean(asset.thumb_path && fs.existsSync(asset.thumb_path));
    const target = thumbExists ? asset.thumb_path! : asset.file_path;
    sendImage(req, res, target, thumbExists ? 'image/webp' : asset.mime ?? 'image/jpeg', assetVersion(asset));
  }),
);

albumRouter.post(
  '/albums/:id/archive',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    requireOwner(req);
    requireAlbum(req.params.id, ctx.libraryId);
    getDb().prepare("UPDATE album SET status = 'archived', updated_at = ? WHERE id = ?").run(nowIso(), req.params.id);
    ok(res, { status: 'archived' });
  }),
);

export { newId };
