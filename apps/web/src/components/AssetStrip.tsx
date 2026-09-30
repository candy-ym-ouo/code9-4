import { Image, Space, Tag, Typography, Upload, message } from 'antd';
import type { AssetDto } from '@flil/shared';
import { authedImageUrl } from '../api/client.js';
import { fmtDateTime } from '../lib/format.js';
import { useReplaceAsset } from '../api/hooks.js';

interface Props {
  assets: AssetDto[];
  tz: string;
  onPick?: (asset: AssetDto) => void;
}

const ROLE_LABEL: Record<string, string> = {
  reference: '参考',
  detail: '细节',
  panorama: '全景',
  result: '实拍',
};

export function AssetStrip({ assets, tz, onPick }: Props) {
  const replaceAsset = useReplaceAsset();

  if (!assets.length) {
    return <Typography.Text type="secondary">还没有图片。上传后系统会自动生成缩略图并提取主色。</Typography.Text>;
  }
  return (
    <Space wrap size={12}>
      {assets.map((a) => (
        <div key={a.id} style={{ width: 160 }} onClick={() => onPick?.(a)}>
          <Image
            src={authedImageUrl(a.thumbUrl)}
            width={160}
            height={110}
            style={{ objectFit: 'cover', borderRadius: 8 }}
          />
          <div style={{ marginTop: 4 }}>
            <Tag color={a.role === 'result' ? 'purple' : 'blue'}>{ROLE_LABEL[a.role] ?? a.role}</Tag>
            {a.hasGpsExif ? <Tag color="orange">含 GPS（未入库）</Tag> : null}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {a.shotAt ? fmtDateTime(a.shotAt, tz) : '无拍摄时间'}
            {a.sunElevation !== null ? ` · 仰角 ${a.sunElevation.toFixed(1)}°` : ''}
          </Typography.Text>
          {a.palette.length ? (
            <div style={{ display: 'flex', marginTop: 3, height: 8, borderRadius: 4, overflow: 'hidden' }}>
              {a.palette.map((c) => (
                <div key={c.hex} style={{ background: c.hex, flexGrow: c.ratio, flexBasis: 0 }} />
              ))}
            </div>
          ) : null}
          <Upload
            accept="image/*"
            showUploadList={false}
            customRequest={async ({ file, onSuccess, onError }) => {
              try {
                const res = await replaceAsset.mutateAsync({ assetId: a.id, file: file as File });
                if (!res.changed) {
                  message.info('新图与原图指纹相同，未做替换');
                } else if (res.reusedFingerprint) {
                  message.success('已替换，并命中已有图片指纹（缩略图与色板直接复用）');
                } else {
                  message.success('已替换原图，旧分享图与缓存已失效');
                }
                onSuccess?.(res);
              } catch (err) {
                message.error((err as Error).message);
                onError?.(err as Error);
              }
            }}
          >
            <Typography.Link style={{ fontSize: 11 }} onClick={(e) => e.stopPropagation()}>
              替换原图
            </Typography.Link>
          </Upload>
        </div>
      ))}
    </Space>
  );
}
