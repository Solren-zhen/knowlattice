/**
 * 自定义桌宠：名字、主色、体型、表情、头顶配饰。
 *
 * 只改外观，不动显隐与停靠位置（那是外壳的事）。预览与页面上的角色共用
 * views/PetFigure.tsx，改一项两边同时变；每次点击立即写盘，不需要「保存」。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import PanelOverlay from './PanelOverlay';
import DialogSurface from './DialogSurface';
import PetFigure from './PetFigure';
import { useEsc, escThenClose } from './useEsc';
import { clearPetImage, loadPetImage, savePetImage, shrinkPetImage } from '../core/petImage';
import {
  PET_ACCESSORIES, PET_ACCESSORY_LABELS, PET_COLORS, PET_FACES, PET_FACE_LABELS,
  PET_LOOK_DEFAULT, PET_NAME_MAX, PET_SIZES, PET_SIZE_LABELS,
  loadPet, resetPetLook, subscribePet, updatePetLook,
  type PetAccessory, type PetFace, type PetLook, type PetSize,
} from '../core/pet';

function lookOf(): PetLook {
  const pet = loadPet();
  return {
    name: pet.name,
    color: pet.color,
    size: pet.size,
    face: pet.face,
    accessory: pet.accessory,
    image: pet.image,
  };
}

export default function PetCustomizer({ onClose }: { onClose: () => void }) {
  useEsc(escThenClose(onClose));
  const [look, setLook] = useState<PetLook>(lookOf);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgError, setImgError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // 别处（例如恢复默认按钮在另一处）改了外观，这里跟上
  useEffect(() => subscribePet(() => setLook(lookOf())), []);

  // 预览用的图片 objectURL：开关变化或卸载时回收
  useEffect(() => {
    let disposed = false;
    let url: string | null = null;
    void (look.image
      ? loadPetImage().then((blob) => {
          if (disposed || !blob) return;
          url = URL.createObjectURL(blob);
          setPreviewUrl(url);
        }).catch(() => { /* 预览读不到就还画晶体 */ })
      : Promise.resolve().then(() => { if (!disposed) setPreviewUrl(null); }));
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [look.image]);

  const patch = (next: Partial<PetLook>) => {
    setLook((current) => ({ ...current, ...next }));
    updatePetLook(next);
  };

  const reset = () => {
    resetPetLook();
    setLook(PET_LOOK_DEFAULT);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { setImgError('请选择图片文件'); return; }
    setImgBusy(true);
    setImgError('');
    try {
      const blob = await shrinkPetImage(file);
      await savePetImage(blob);
      updatePetLook({ image: true });
      setLook((current) => ({ ...current, image: true }));
    } catch (error) {
      setImgError(error instanceof Error ? error.message : '图片处理失败');
    } finally {
      setImgBusy(false);
    }
  };

  const removeImage = async () => {
    try {
      await clearPetImage();
    } finally {
      updatePetLook({ image: false });
      setLook((current) => ({ ...current, image: false }));
    }
  };

  return (
    <PanelOverlay tone="plain" onClose={onClose}>
      <DialogSurface className="panel pet-custom-panel" label="自定义桌宠" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head">
          <span className="panel__title">自定义桌宠</span>
          <button className="btn-small" onClick={onClose}>关闭</button>
        </div>

        <div className="pet-custom-body">
          <div
            className={`pet-custom-preview pet--${look.size}`}
            style={look.color ? ({ '--pet-accent': look.color } as CSSProperties & Record<string, string>) : undefined}
            aria-hidden="true"
          >
            {look.image && previewUrl
              ? <img className="pet-img" src={previewUrl} alt="" draggable={false} />
              : <PetFigure face={look.face} accessory={look.accessory} />}
          </div>

          <div className="settings-row">
            <span className="settings-row__label">形象</span>
            <div className="settings-chips" role="group" aria-label="桌宠形象">
              <button
                type="button"
                className={`chip${!look.image ? ' on' : ''}`}
                aria-pressed={!look.image}
                onClick={() => { if (look.image) void removeImage(); }}
              >
                晶灵
              </button>
              <button
                type="button"
                className={`chip${look.image ? ' on' : ''}`}
                aria-pressed={look.image}
                disabled={imgBusy}
                onClick={() => fileRef.current?.click()}
              >
                {imgBusy ? '处理中…' : '上传图片…'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                aria-label="选择桌宠图片文件"
                hidden
                onChange={(event) => { void onFile(event.target.files?.[0]); event.target.value = ''; }}
              />
            </div>
          </div>
          {imgError && <p className="settings-note" role="alert">{imgError}（会自动缩到 256px、转透明底 PNG）</p>}

          <div className="settings-row">
            <span className="settings-row__label">名字</span>
            <input
              className="pet-name-input"
              value={look.name}
              maxLength={PET_NAME_MAX}
              aria-label="桌宠名字"
              placeholder={PET_LOOK_DEFAULT.name}
              onChange={(event) => patch({ name: event.target.value })}
              onBlur={() => { if (!look.name.trim()) patch({ name: PET_LOOK_DEFAULT.name }); }}
            />
          </div>

          <div className="settings-row">
            <span className="settings-row__label">主色</span>
            <div className="pet-swatches" role="group" aria-label="桌宠主色">
              {PET_COLORS.map((option) => {
                const active = option.value === look.color;
                return (
                  <button
                    key={option.value ?? 'theme'}
                    type="button"
                    className={`pet-swatch${option.value ? '' : ' pet-swatch--theme'}${active ? ' on' : ''}`}
                    style={option.value ? { background: option.value } : undefined}
                    aria-label={`主色：${option.label}`}
                    aria-pressed={active}
                    title={option.label}
                    onClick={() => patch({ color: option.value })}
                  />
                );
              })}
            </div>
          </div>

          <div className="settings-row">
            <span className="settings-row__label">体型</span>
            <div className="settings-chips" role="group" aria-label="桌宠体型">
              {PET_SIZES.map((size: PetSize) => (
                <button
                  key={size}
                  type="button"
                  className={`chip${look.size === size ? ' on' : ''}`}
                  aria-pressed={look.size === size}
                  onClick={() => patch({ size })}
                >
                  {PET_SIZE_LABELS[size]}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-row">
            <span className="settings-row__label">表情</span>
            <div className="settings-chips" role="group" aria-label="桌宠表情">
              {PET_FACES.map((face: PetFace) => (
                <button
                  key={face}
                  type="button"
                  className={`chip${look.face === face ? ' on' : ''}`}
                  aria-pressed={look.face === face}
                  onClick={() => patch({ face })}
                >
                  {PET_FACE_LABELS[face]}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-row">
            <span className="settings-row__label">头顶</span>
            <div className="settings-chips" role="group" aria-label="桌宠配饰">
              {PET_ACCESSORIES.map((accessory: PetAccessory) => (
                <button
                  key={accessory}
                  type="button"
                  className={`chip${look.accessory === accessory ? ' on' : ''}`}
                  aria-pressed={look.accessory === accessory}
                  onClick={() => patch({ accessory })}
                >
                  {PET_ACCESSORY_LABELS[accessory]}
                </button>
              ))}
            </div>
          </div>

          <div className="pet-custom-foot">
            <p className="settings-note">
              改完立即生效。名字会用在鼠标悬停与读屏标签上；主色只影响桌宠本身，不改界面主题。
            </p>
            <button type="button" className="btn-small" onClick={reset}>恢复默认</button>
          </div>
        </div>
      </DialogSurface>
    </PanelOverlay>
  );
}
