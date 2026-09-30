import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AlbumDto,
  AlbumGapDto,
  InspirationDto,
  PlanDto,
  ReminderDto,
  ReproWindowDto,
  SearchResult,
  SpotDto,
  TagDto,
  TimingDto,
} from '@flil/shared';
import { del, get, patch, post, put, upload } from './client.js';

export interface MetaResponse {
  tagDomains: { key: string; label: string }[];
  timeAnchors: { key: string; label: string }[];
  weatherPresets: { key: string; name: string; description: string; profile: Record<string, unknown> }[];
  fuzzLevels: { key: string; label: string }[];
  missReasons: { key: string; label: string }[];
}

export const useMeta = () => useQuery({ queryKey: ['meta'], queryFn: () => get<MetaResponse>('/meta') });

export const useTags = () =>
  useQuery({ queryKey: ['tags'], queryFn: () => get<{ items: TagDto[] }>('/tags') });

export const useInspirations = (params: Record<string, string | number | undefined> = {}) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  return useQuery({
    queryKey: ['inspirations', qs.toString()],
    queryFn: () => get<{ items: InspirationDto[]; total: number; page: number; size: number }>(`/inspirations?${qs}`),
  });
};

export const useInspiration = (id: string | undefined) =>
  useQuery({
    queryKey: ['inspiration', id],
    queryFn: () => get<{ item: InspirationDto }>(`/inspirations/${id}`),
    enabled: Boolean(id),
  });

export const useWindows = (id: string | undefined, days = 7) =>
  useQuery({
    queryKey: ['windows', id, days],
    queryFn: () =>
      get<{ items: ReproWindowDto[]; summary: { nextGoodAt: string | null; goodIn30d: number } }>(
        `/inspirations/${id}/windows?days=${days}`,
      ),
    enabled: Boolean(id),
  });

export const useReminders = (status?: string) =>
  useQuery({
    queryKey: ['reminders', status],
    queryFn: () => get<{ items: ReminderDto[] }>(`/reminders${status ? `?status=${status}` : ''}`),
  });

export const usePlans = (filter?: string) =>
  useQuery({
    queryKey: ['plans', filter],
    queryFn: () => get<{ items: PlanDto[] }>(`/plans${filter ? `?filter=${filter}` : ''}`),
  });

export const useAlbums = () => useQuery({ queryKey: ['albums'], queryFn: () => get<{ items: AlbumDto[] }>('/albums') });

export const useAlbum = (id: string | undefined) =>
  useQuery({
    queryKey: ['album', id],
    queryFn: () =>
      get<{ item: AlbumDto; items: InspirationDto[]; gaps: AlbumGapDto[] }>(`/albums/${id}`),
    enabled: Boolean(id),
  });

export const useSearch = (params: Record<string, string | number | undefined>, enabled = true) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  return useQuery({
    queryKey: ['search', qs.toString()],
    queryFn: () => get<SearchResult>(`/search?${qs}`),
    enabled,
  });
};

export const useSpots = () =>
  useQuery({ queryKey: ['spots'], queryFn: () => get<{ items: SpotDto[] }>('/spots') });

export const usePlaces = () =>
  useQuery({
    queryKey: ['places'],
    queryFn: () =>
      get<{ items: { id: string; name: string; city: string | null; district: string | null }[] }>('/places'),
  });

export const useTodayWindows = (lat?: number, lng?: number) =>
  useQuery({
    queryKey: ['todayWindows', lat, lng],
    queryFn: () =>
      get<{
        items: {
          windowId: string;
          inspirationId: string;
          title: string;
          startAt: string;
          endAt: string;
          verdict: string;
          distanceBand: string | null;
        }[];
      }>(`/windows/today${lat !== undefined && lng !== undefined ? `?lat=${lat}&lng=${lng}` : ''}`),
  });

// ---------------------------------------------------------------- mutations

function useInvalidate(keys: string[]) {
  const qc = useQueryClient();
  return () => keys.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
}

export function useCreateInspiration() {
  const invalidate = useInvalidate(['inspirations']);
  return useMutation({
    mutationFn: (body: { title: string; note?: string | null }) => post<{ id: string }>('/inspirations', body),
    onSuccess: invalidate,
  });
}

export function useBulkTag() {
  const invalidate = useInvalidate(['inspirations', 'inspiration', 'search']);
  return useMutation({
    mutationFn: (body: { ids: string[]; addTagIds?: string[]; removeTagIds?: string[] }) =>
      post<{ added: number; removed: number }>('/inspirations/bulk-tag', body),
    onSuccess: invalidate,
  });
}

export function useBindSpot() {
  const invalidate = useInvalidate(['inspiration', 'inspirations']);
  return useMutation({
    mutationFn: ({ id, spotId }: { id: string; spotId: string | null }) =>
      post<{ status: string }>(`/inspirations/${id}/spot`, { spotId }),
    onSuccess: invalidate,
  });
}

export function useSaveTiming() {
  const invalidate = useInvalidate(['inspiration', 'inspirations', 'windows']);
  return useMutation({
    mutationFn: ({ id, timing }: { id: string; timing: TimingDto }) =>
      put<{ item: TimingDto; windows: ReproWindowDto[] }>(`/inspirations/${id}/timing`, timing),
    onSuccess: invalidate,
  });
}

export function usePreviewTiming() {
  return useMutation({
    mutationFn: ({ id, timing }: { id: string; timing: TimingDto }) =>
      post<{
        anchorLocal: string | null;
        sunEvents: Record<string, string | null>;
        notes: string[];
        satisfiability: { total: number; satisfied: number; ratio: number; advice: string | null };
      }>(`/inspirations/${id}/timing/preview`, timing),
  });
}

export function useRecomputeWindows() {
  const invalidate = useInvalidate(['windows', 'inspirations', 'todayWindows']);
  return useMutation({
    mutationFn: ({ id, days = 7 }: { id: string; days?: number }) =>
      post<{ items: ReproWindowDto[] }>(`/inspirations/${id}/windows/recompute`, { days }),
    onSuccess: invalidate,
  });
}

export function useCreatePlan() {
  const invalidate = useInvalidate(['plans', 'reminders', 'inspiration', 'inspirations', 'windows']);
  return useMutation({
    mutationFn: (body: { windowId: string; commuteMin: number; companions?: string | null; gearNote?: string | null }) =>
      post<{ id: string; plannedAt: string; leaveAt: string }>('/plans', body),
    onSuccess: invalidate,
  });
}

export function useFillResult() {
  const invalidate = useInvalidate(['plans', 'reminders', 'inspiration', 'inspirations']);
  return useMutation({
    mutationFn: ({
      planId,
      ...body
    }: {
      planId: string;
      hitLevel: 'hit' | 'partial' | 'miss';
      missReasons: string[];
      note?: string | null;
    }) =>
      post<{ resultId: string; hitRate: number; tightened: { field: string; before: unknown; after: unknown }[]; suggestions: string[] }>(
        `/plans/${planId}/result`,
        body,
      ),
    onSuccess: invalidate,
  });
}

export function useReminderAction() {
  const invalidate = useInvalidate(['reminders', 'plans', 'inspirations']);
  return useMutation({
    mutationFn: ({ id, action, payload }: { id: string; action: 'done' | 'snooze' | 'dismiss'; payload?: unknown }) =>
      post<unknown>(`/reminders/${id}/${action}`, payload ?? {}),
    onSuccess: invalidate,
  });
}

export function useCreateAlbum() {
  const invalidate = useInvalidate(['albums']);
  return useMutation({
    mutationFn: (body: { title: string; themeNote?: string | null; rules?: Record<string, unknown> }) =>
      post<{ id: string }>('/albums', body),
    onSuccess: invalidate,
  });
}

export function useAlbumActions() {
  const invalidate = useInvalidate(['album', 'albums', 'search']);
  return {
    autoMatch: useMutation({
      mutationFn: (id: string) => post<{ added: number; scanned: number }>(`/albums/${id}/auto-match`, {}),
      onSuccess: invalidate,
    }),
    addItem: useMutation({
      mutationFn: ({ id, inspirationId }: { id: string; inspirationId: string }) =>
        post<unknown>(`/albums/${id}/items`, { inspirationId }),
      onSuccess: invalidate,
    }),
    removeItem: useMutation({
      mutationFn: ({ id, inspirationId }: { id: string; inspirationId: string }) =>
        del<unknown>(`/albums/${id}/items/${inspirationId}`),
      onSuccess: invalidate,
    }),
    waiveGap: useMutation({
      mutationFn: ({ id, gapId, reason }: { id: string; gapId: string; reason: string }) =>
        post<unknown>(`/albums/${id}/gaps/${gapId}/waive`, { reason }),
      onSuccess: invalidate,
    }),
    publish: useMutation({
      mutationFn: ({
        id,
        ...body
      }: {
        id: string;
        createShare: boolean;
        fuzzLevel?: string;
        expiresInDays?: number;
        password?: string | null;
      }) => post<{ version: number; shareToken: string | null; payloadHash: string }>(`/albums/${id}/publish`, body),
      onSuccess: invalidate,
    }),
    updateRules: useMutation({
      mutationFn: ({ id, rules, title, themeNote }: { id: string; rules?: Record<string, unknown>; title?: string; themeNote?: string | null }) =>
        patch<unknown>(`/albums/${id}`, { rules, title, themeNote }),
      onSuccess: invalidate,
    }),
  };
}

export function useUploadAssets() {
  const invalidate = useInvalidate(['inspiration', 'inspirations']);
  return useMutation({
    mutationFn: ({ id, files, role }: { id: string; files: File[]; role: string }) =>
      upload<{ items: { assetId: string; hasGpsExif: boolean; shotAt: string | null }[] }>(
        `/inspirations/${id}/assets`,
        files,
        { role },
      ),
    onSuccess: invalidate,
  });
}

export interface ReplaceAssetResult {
  changed: boolean;
  sha256: string;
  reusedFingerprint: boolean;
  item: import('@flil/shared').AssetDto;
}

export function useReplaceAsset() {
  const invalidate = useInvalidate(['inspiration', 'inspirations']);
  return useMutation({
    mutationFn: ({ assetId, file }: { assetId: string; file: File }) =>
      upload<ReplaceAssetResult>(`/assets/${assetId}/replace`, [file]),
    onSuccess: invalidate,
  });
}

export function useSaveAnnotations() {
  const invalidate = useInvalidate(['inspiration']);
  return useMutation({
    mutationFn: ({ assetId, items }: { assetId: string; items: { kind: string; geometry: Record<string, unknown> }[] }) =>
      put<unknown>(`/assets/${assetId}/annotations`, { items }),
    onSuccess: invalidate,
  });
}

export function useRecomputeSun() {
  const invalidate = useInvalidate(['inspiration']);
  return useMutation({
    mutationFn: (assetId: string) =>
      post<{
        sunElevation: number;
        sunAzimuth: number;
        suggestedLightBearing: number;
        suggestedExpectedAzimuth: number;
        shotAt: string;
      }>(`/assets/${assetId}/recompute-sun`, {}),
    onSuccess: invalidate,
  });
}

export function useShareLinks() {
  return useQuery({
    queryKey: ['shareLinks'],
    queryFn: () =>
      get<{
        items: {
          id: string;
          scope: string;
          token: string;
          fuzzLevel: string;
          status: string;
          expiresAt: string;
          viewCount: number;
          hasPassword: boolean;
        }[];
      }>('/share-links'),
  });
}

export function useRevokeShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<unknown>(`/share-links/${id}/revoke`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['shareLinks'] }),
  });
}
