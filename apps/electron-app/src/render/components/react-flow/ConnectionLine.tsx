import {
  ConnectionLineComponentProps,
  getBezierPath,
  Position,
} from "@xyflow/react";
import { useMemo } from "react";

function getTargetPosition({
  toHandle,
  fromY,
  toY,
  fromX,
  toX,
}: Pick<
  ConnectionLineComponentProps,
  "fromX" | "fromY" | "toX" | "toY" | "toHandle"
>) {
  if (toHandle?.position) {
    return toHandle.position;
  }

  const xDiff = Math.abs(fromX - toX);
  const yDiff = Math.abs(fromY - toY);

  if (xDiff > yDiff) {
    if (fromX > toX) {
      return Position.Right;
    }

    return Position.Left;
  }

  if (fromY > toY) {
    return Position.Bottom;
  }

  return Position.Top;
}

export function ConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromHandle,
  toHandle,
  connectionStatus,
}: ConnectionLineComponentProps) {
  const targetPosition = getTargetPosition({
    fromX,
    fromY,
    toX,
    toY,
    toHandle,
  });

  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    targetX: toX,
    targetY: toY,
    sourcePosition: fromHandle?.position ?? Position.Top,
    targetPosition: targetPosition,
  });

  const stroke = useMemo(() => {
    if (connectionStatus) {
      return connectionStatus === "valid" ? "#0ea5e9" : "#ef4444";
    }

    return "#71717a";
  }, [connectionStatus]);

  return (
    <g>
      <path
        fill="none"
        stroke={stroke}
        strokeWidth={4}
        className="animated"
        d={path}
      />
      <circle cx={toX} cy={toY} fill="#fff" r={6} />
    </g>
  );
}