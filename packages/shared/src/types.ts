import type {
  AlbumStatus,
  AnnotationKind,
  AssetRole,
  FuzzLevel,
  GapStatus,
  HitLevel,
  InspirationStatus,
  MissReason,
  PlanStatus,
  ReminderActionKind,
  ReminderStatus,
  TagDomain,
  TagSource,
  TimeAnchor,
  WeatherPhenomenon,
  WindowVerdict,
} from './enums.js';
import type { PaletteColor } from './palette.js';

export interface WeatherProfile {
  cloudCoverPct?: { min: number; max: number };
  precipProbPctMax?: number;
  visibilityKmMin?: number;
  windSpeedMax?: number;
  tempC?: { min: number; max: number };
  phenomena?: WeatherPhenomenon[];
  hardRequirements?: string[];
}

export interface TimingDto {
  timeAnchor: TimeAnchor;
  anchorOffsetMin: number;
  elevationRange: number[];
  azimuthRange: number[] | null;
  azimuthTolerance: number;
  windowToleranceMin: number;
  weatherProfile: WeatherProfile;
  seasonWindow: { fromMonth: number; toMonth: number } | null;
  notes: string | null;
}

export interface WindowReasonDto {
  code: string;
  level: 'ok' | 'warn' | 'bad' | 'info';
  text: string;
}

export interface ReproWindowDto {
  id: string | null;
  inspirationId: string;
  date: string;
  startAt: string;
  endAt: string;
  anchorAt: string;
  sunElevation: number | null;
  sunAzimuth: number | null;
  verdict: WindowVerdict;
  reasons: WindowReasonDto[];
  weatherDegraded: boolean;
  stale: boolean;
  computedAt: string | null;
}

export interface TagDto {
  id: string;
  domain: TagDomain;
  parentId: string | null;
  name: string;
  slug: string;
  isBuiltin: boolean;
  disabled: boolean;
  sortOrder: number;
  usageCount: number;
  children?: TagDto[];
}

export interface PaletteDto extends PaletteColor {}

export interface AssetDto {
  id: string;
  inspirationId: string;
  role: AssetRole;
  /** 内容版本：替换原图后自增，URL 携带该值用于击穿缓存 */
  contentVersion: number;
  width: number;
  height: number;
  shotAt: string | null;
  cameraModel: string | null;
  lens: string | null;
  iso: number | null;
  aperture: string | null;
  shutter: string | null;
  hasGpsExif: boolean;
  palette: PaletteColor[];
  sunElevation: number | null;
  sunAzimuth: number | null;
  weatherSnapshot: Record<string, unknown> | null;
  fileUrl: string;
  thumbUrl: string;
  createdAt: string;
}

export interface AnnotationDto {
  id: string;
  assetId: string;
  kind: AnnotationKind;
  geometry: Record<string, unknown>;
  label: string | null;
}

export interface FuzzResult {
  fuzzLevel: FuzzLevel;
  lat: number | null;
  lng: number | null;
  geohash: string;
  label: string;
}

export interface SpotDto {
  id: string;
  placeId: string;
  placeName: string;
  city: string | null;
  district: string | null;
  tz: string;
  cameraBearing: number;
  elevationM: number | null;
  accessNote: string | null;
  bestTimeNote: string | null;
  visibility: 'private' | 'fuzzy_shared';
  /** 精确坐标：仅 owner 且仅在编辑场景返回 */
  precise: { lat: number; lng: number } | null;
  fuzz: FuzzResult;
}

export interface InspirationDto {
  id: string;
  title: string;
  note: string | null;
  status: InspirationStatus;
  seasonTags: number[];
  hitCount: number;
  partialCount: number;
  missCount: number;
  hitRate: number;
  archivedReason: string | null;
  createdAt: string;
  updatedAt: string;
  tags: { id: string; domain: TagDomain; name: string; slug: string; source: TagSource }[];
  assets: AssetDto[];
  spot: SpotDto | null;
  timing: TimingDto | null;
  windowSummary: { nextGoodAt: string | null; goodIn30d: number } | null;
}

export interface ReminderDto {
  id: string;
  subjectType: string;
  subjectId: string;
  ruleCode: string | null;
  title: string;
  body: string | null;
  actionKind: ReminderActionKind;
  actionPayload: Record<string, unknown> | null;
  status: ReminderStatus;
  dueAt: string;
  expireAt: string | null;
  createdAt: string;
}

export interface PlanDto {
  id: string;
  inspirationId: string;
  inspirationTitle: string;
  windowId: string | null;
  plannedAt: string;
  leaveAt: string | null;
  commuteMin: number;
  companions: string | null;
  gearNote: string | null;
  status: PlanStatus;
  cancelReason: string | null;
  result: {
    id: string;
    hitLevel: HitLevel;
    missReasons: MissReason[];
    note: string | null;
    filledAt: string;
  } | null;
}

export interface AlbumGapDto {
  id: string;
  kind: 'tag' | 'anchor' | 'weather' | 'count' | 'result';
  requirement: Record<string, unknown>;
  currentCount: number;
  requiredCount: number;
  isRequired: boolean;
  status: GapStatus;
  waiveReason: string | null;
  actionLabel: string;
  actionHref: string;
}

export interface AlbumDto {
  id: string;
  title: string;
  themeNote: string | null;
  status: AlbumStatus;
  rules: Record<string, unknown>;
  itemCount: number;
  openRequiredGaps: number;
  coverThumbUrl: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface SearchRelaxation {
  field: string;
  from: string;
  to: string;
  note: string;
}

export interface SearchResult {
  items: InspirationDto[];
  total: number;
  relaxed: SearchRelaxation[];
  suggestions?: { tagIds: string[]; tagNames: string[]; message: string } | null;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  libraryId: string;
  role: 'owner' | 'member';
}
