import { useRef } from 'react';
import { Image, Space, Tag, Tooltip, Typography, message } from 'antd';
import type { AssetDto } from '@flil/shared';
import { authedImageUrl } from '../api/client.js';
import { useReplaceAsset } from '../api/hooks.js';
import { fmtDateTime } from '../lib/format.js';

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const replaceTargetRef = useRef<AssetDto | null>(null);

  function triggerReplace(asset: AssetDto) {
    replaceTargetRef.current = asset;
    fileInputRef.current?.click();
  }

  async function onReplaceChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    const target = replaceTargetRef.current;
    if (!file || !target) return;
    try {
      await replaceAsset.mutateAsync({ assetId: target.id, file });
      message.success('原图已替换：缩略图与色板已重算，旧分享链接里的旧图立即失效');
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  if (!assets.length) {
    return <Typography.Text type="secondary">还没有图片。上传后系统会自动生成缩略图并提取主色。</Typography.Text>;
  }
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => void onReplaceChosen(e)}
      />
      <Space wrap size={12}>
        {assets.map((a) => (
          <div key={a.id} style={{ width: 160 }} onClick={() => onPick?.(a)}>
            <Image src={authedImageUrl(a.thumbUrl)} width={160} height={110} style={{ objectFit: 'cover', borderRadius: 8 }} />
            <div style={{ marginTop: 4 }}>
              <Space size={4} wrap>
                <Tag color={a.role === 'result' ? 'purple' : 'blue'}>{ROLE_LABEL[a.role] ?? a.role}</Tag>
                {a.hasGpsExif ? <Tag color="orange">含 GPS（未入库）</Tag> : null}
                <Tooltip title="用新文件替换这张原图：重新生成缩略图与色板，旧分享图立即失效；标注保留">
                  <Typography.Link
                    style={{ fontSize: 11 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      triggerReplace(a);
                    }}
                  >
                    替换原图
                  </Typography.Link>
                </Tooltip>
              </Space>
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
          </div>
        ))}
      </Space>
    </>
  );
}
