import {
  ConnectionLineComponentProps,
  getBezierPath,
  Position,
} from "@xyflow/react";

export function ConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromHandle,
  toHandle,
}: ConnectionLineComponentProps) {
  const path = toHandle
    ? getBezierPath({
        sourceX: fromX,
        sourceY: fromY,
        targetX: toX,
        targetY: toY,
        sourcePosition: fromHandle?.position ?? Position.Top,
        targetPosition: toHandle?.position ?? Position.Bottom,
      })[0]
    : generateBezierPath({ fromX, fromY, toX, toY });
  return (
    <g>
      <path
        fill="none"
        stroke="#0ea5e9"
        strokeWidth={2}
        className="animated"
        // d={`M${fromX},${fromY} C ${fromX} ${toY} ${fromX} ${toY} ${toX},${toY}`}
        d={path}
      />
      <circle cx={toX} cy={toY} fill="#fff" r={6} />
    </g>
  );
}

function generateBezierPath(
  pos: Pick<ConnectionLineComponentProps, "fromX" | "fromY" | "toX" | "toY">,
): string {
  const { fromX, fromY, toX, toY } = pos;

  // Calculate control points
  const controlX1 = fromX;
  const controlY1 = (fromY + toY) / 2;
  const controlX2 = toX;
  const controlY2 = (fromY + toY) / 2;

  // Construct the path
  const path = `M${fromX},${fromY} C${controlX1},${controlY1} ${controlX2},${controlY2} ${toX},${toY}`;
  return path;
}
