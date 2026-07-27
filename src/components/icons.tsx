import type { ReactElement, SVGProps } from "react";

/**
 * Kiriko icon set (Figma 🧩 Components → Icon/*): 24-unit grid stroke icons
 * rendered at 20px, stroked in currentColor. Decorative by default — pair
 * with an accessible name on the owning control.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 20, ...rest }: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    ...rest,
  };
}

/** Brand mark: solid cut-glass diamond, filled in currentColor. */
export function KirikoMark({ size = 20, ...rest }: IconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
      <path d="M12 1.8 22.2 12 12 22.2 1.8 12Z" />
      <path d="m12 5 7 7-7 7-7-7Z" fill="#ffffff" opacity="0.25" />
    </svg>
  );
}

export function IconChevronLeft(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function IconSearch(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

export function IconLayers(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="m12 2 9.5 5L12 12 2.5 7Z" />
      <path d="m2.5 12 9.5 5 9.5-5" />
      <path d="m2.5 17 9.5 5 9.5-5" />
    </svg>
  );
}

export function IconMessageSquare(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
      <path d="M8 9h8" />
      <path d="M8 13h5" />
    </svg>
  );
}

export function IconAlertTriangle(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M10.3 3.8 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function IconClose(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function IconPlus(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function IconMinus(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M5 12h14" />
    </svg>
  );
}

export function IconCrosshair(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 2v3" />
      <path d="M12 19v3" />
      <path d="M2 12h3" />
      <path d="M19 12h3" />
    </svg>
  );
}

export function IconEye(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconEyeOff(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M10.7 5.2A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.4 3.4" />
      <path d="M6.6 6.6C3.7 8.6 2 12 2 12s3.5 7 10 7c1.4 0 2.7-.3 3.9-.8" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="m3 3 18 18" />
    </svg>
  );
}

export function IconCursor(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M5 4l6 15 2.2-6.8L20 10Z" />
    </svg>
  );
}

export function IconPointPlus(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="15" r="3" />
      <path d="M17 4v6" />
      <path d="M14 7h6" />
    </svg>
  );
}

export function IconConnect(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8 8l8 8" />
    </svg>
  );
}

export function IconTrash(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
    </svg>
  );
}

export function IconUndo(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M7 4 3 8l4 4" />
      <path d="M3 8h10a6 6 0 1 1 0 12H8" />
    </svg>
  );
}

export function IconRedo(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M17 4l4 4-4 4" />
      <path d="M21 8H11a6 6 0 1 0 0 12h5" />
    </svg>
  );
}

export function IconMove(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M12 3v18" />
      <path d="M3 12h18" />
      <path d="M9 6l3-3 3 3" />
      <path d="M9 18l3 3 3-3" />
      <path d="M6 9l-3 3 3 3" />
      <path d="M18 9l3 3-3 3" />
    </svg>
  );
}
