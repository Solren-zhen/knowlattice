/**
 * 桌宠角色的纯 SVG 本体：不定位、不拖拽、不读存储。
 *
 * 拆出来是因为「页面上的桌宠」和「自定义面板里的预览」必须是同一个角色；
 * 各画一份迟早会走散。表情与头顶配饰是两条独立轴，由 core/pet 的枚举决定。
 */
import type { PetAccessory, PetFace } from '../core/pet';

interface Props {
  face: PetFace;
  accessory: PetAccessory;
  /** 追加给 <svg> 的 class（尺寸交给外层容器） */
  className?: string;
}

function Eyes({ face }: { face: PetFace }) {
  if (face === 'smile') {
    return (
      <g className="pet-eyes">
        <path className="pet-eye-smile" d="M47 55 Q51 50 55 55" />
        <path className="pet-eye-smile" d="M65 55 Q69 50 73 55" />
      </g>
    );
  }
  if (face === 'star') {
    return (
      <g className="pet-eyes">
        <path className="pet-eye-star" d="M51 49 L52.6 52.4 L56 54 L52.6 55.6 L51 59 L49.4 55.6 L46 54 L49.4 52.4 Z" />
        <path className="pet-eye-star" d="M69 49 L70.6 52.4 L74 54 L70.6 55.6 L69 59 L67.4 55.6 L64 54 L67.4 52.4 Z" />
      </g>
    );
  }
  return (
    <g className="pet-eyes">
      <ellipse className="pet-eye" cx="51" cy="54" rx="3.4" ry="4.6" />
      <ellipse className="pet-eye" cx="69" cy="54" rx="3.4" ry="4.6" />
    </g>
  );
}

function Accessory({ accessory }: { accessory: PetAccessory }) {
  if (accessory === 'sprout') {
    return (
      <g className="pet-accessory pet-accessory--sprout">
        <path d="M60 12 C58 4 50 2 46 5 C49 10 55 12 60 12 Z" />
        <path d="M60 12 C62 5 69 3 73 6 C70 11 65 13 60 12 Z" />
        <path className="pet-accessory-stem" d="M60 14 L60 5" />
      </g>
    );
  }
  if (accessory === 'halo') {
    return (
      <g className="pet-accessory pet-accessory--halo">
        <ellipse cx="60" cy="7" rx="15" ry="3.4" />
      </g>
    );
  }
  return null;
}

export default function PetFigure({ face, accessory, className }: Props) {
  const classes = ['pet-svg', className].filter(Boolean).join(' ');
  return (
    <svg className={classes} viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <ellipse className="pet-shadow" cx="60" cy="114" rx="22" ry="4.5" />
      <g className="pet-body">
        <Accessory accessory={accessory} />
        <g className="pet-arm pet-arm--left">
          <path d="M31 76 L19 82 L31 88 Z" />
        </g>
        <g className="pet-arm pet-arm--right">
          <path d="M89 76 L101 82 L89 88 Z" />
        </g>
        <path className="pet-face pet-face--left" d="M60 10 L26 36 L26 86 L60 110 Z" />
        <path className="pet-face pet-face--right" d="M60 10 L94 36 L94 86 L60 110 Z" />
        <path className="pet-facet" d="M60 10 L80 26 L60 35 L40 26 Z" />
        <path className="pet-ridge" d="M60 10 L60 110" />
        <circle className="pet-core-halo" cx="60" cy="88" r="9" />
        <circle className="pet-core-dot" cx="60" cy="88" r="4.5" />
        <Eyes face={face} />
        <path className="pet-mouth" d="M54 65 Q60 70 66 65" />
      </g>
    </svg>
  );
}
