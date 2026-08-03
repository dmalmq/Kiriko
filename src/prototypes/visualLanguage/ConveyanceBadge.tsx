import { markerIconFor } from "../../map/markerIcons";

export type ConveyanceCategory = "elevator" | "escalator" | "stairs" | "ramp";

export interface ConveyanceBadgeProps {
  readonly category: ConveyanceCategory;
  readonly label: string;
  readonly selected: boolean;
  readonly screenPosition: {
    readonly x: number;
    readonly y: number;
  };
}

export function ConveyanceBadge({
  category,
  label,
  selected,
  screenPosition,
}: ConveyanceBadgeProps) {
  const icon = markerIconFor(category);
  const className = [
    "vl-conveyance-badge",
    `vl-conveyance-badge--${category}`,
    selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <g
      className={className}
      role="img"
      aria-label={label}
      transform={`translate(${screenPosition.x} ${screenPosition.y})`}
    >
      <rect className="vl-conveyance-badge__backplate" x={-16} y={-16} width={32} height={32} rx={6} />
      {icon !== undefined ? (
        <foreignObject className="vl-conveyance-badge__foreign-object" x={-12} y={-12} width={24} height={24}>
          <div
            className="vl-conveyance-badge__icon"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: icon }}
          />
        </foreignObject>
      ) : category === "ramp" ? (
        <g className="vl-conveyance-badge__ramp" aria-hidden="true">
          <path className="vl-conveyance-badge__ramp-plane" d="M -10 8 L 10 8 L 10 -7 Z" />
          <path className="vl-conveyance-badge__ramp-chevron" d="M -3 4 L 2 0 L 6 0" />
        </g>
      ) : null}
    </g>
  );
}
