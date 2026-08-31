import { SIGNAL_DURATION, useEdgeSignals, type Signal } from "@/stores/signal";
import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useMemo } from "react";

/**
 * An edge plus the signal dots travelling along it. The store's shared clock
 * decides when this re-renders — an edge with no live signal is woken by
 * nothing and draws a plain path.
 */
export function AnimatedEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = props;
  const { signals, now } = useEdgeSignals(id);

  const [edgePath] = useMemo(() => {
    return getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
  }, [sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition]);

  // Parse the path once and cache the control points
  const bezierPoints = useMemo(() => {
    return parseBezierPath(edgePath, sourceX, sourceY, targetX, targetY);
  }, [edgePath, sourceX, sourceY, targetX, targetY]);

  return (
    <>
      <BaseEdge id={id} path={edgePath} />
      {signalPositions(signals, now, bezierPoints).map((position) => (
        <circle
          key={position.id}
          r="8"
          // #ffcc00 washes out on the light canvas; amber-600 holds up there, the
          // original yellow stays for dark.
          className="fill-amber-600 dark:fill-[#ffcc00]"
          cx={position.x}
          cy={position.y}
        />
      ))}
    </>
  );
}

/**
 * Where each signal sits at `now` — a pure function of the frame the store
 * handed out, so it can be checked without rendering an edge.
 */
export function signalPositions(
  signals: readonly Signal[],
  now: number,
  points: BezierPoints,
): Array<{ id: string; x: number; y: number }> {
  return signals.map((signal) => {
    const elapsed = now - signal.startTime;
    const progress = Math.max(0, Math.min(1, elapsed / SIGNAL_DURATION));
    const { x, y } = getPointOnBezierCurve(points, progress);
    return { id: signal.id, x, y };
  });
}

export type BezierPoints = {
  startX: number;
  startY: number;
  cp1X: number;
  cp1Y: number;
  cp2X: number;
  cp2Y: number;
  endX: number;
  endY: number;
  isLinear: boolean;
};

/**
 * Parse SVG path string once and extract control points.
 * This is called only when the path changes, not on every animation frame.
 */
export function parseBezierPath(
  path: string,
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): BezierPoints {
  // Parse the SVG path to extract control points
  // Format: M x,y C cx1,cy1 cx2,cy2 x,y
  const pathMatch = path.match(
    /M\s*([\d.-]+),([\d.-]+)\s*C\s*([\d.-]+),([\d.-]+)\s*([\d.-]+),([\d.-]+)\s*([\d.-]+),([\d.-]+)/,
  );

  if (!pathMatch) {
    // Fallback to linear interpolation - return a flag to indicate this
    return {
      startX: sourceX,
      startY: sourceY,
      cp1X: sourceX,
      cp1Y: sourceY,
      cp2X: targetX,
      cp2Y: targetY,
      endX: targetX,
      endY: targetY,
      isLinear: true,
    };
  }

  const [, startX, startY, cp1X, cp1Y, cp2X, cp2Y, endX, endY] = pathMatch.map(Number);

  return {
    startX,
    startY,
    cp1X,
    cp1Y,
    cp2X,
    cp2Y,
    endX,
    endY,
    isLinear: false,
  };
}

/**
 * Calculate position along cubic Bezier curve using the formula:
 * B(t) = (1-t)³P₀ + 3(1-t)²tP₁ + 3(1-t)t²P₂ + t³P₃
 */
function getPointOnBezierCurve(points: BezierPoints, progress: number): { x: number; y: number } {
  if (points.isLinear) {
    // Fast path for linear interpolation
    return {
      x: points.startX + (points.endX - points.startX) * progress,
      y: points.startY + (points.endY - points.startY) * progress,
    };
  }

  const t = progress;
  const oneMinusT = 1 - t;
  const oneMinusTSquared = oneMinusT * oneMinusT;
  const oneMinusTCubed = oneMinusTSquared * oneMinusT;
  const tSquared = t * t;
  const tCubed = tSquared * t;

  const x =
    oneMinusTCubed * points.startX +
    3 * oneMinusTSquared * t * points.cp1X +
    3 * oneMinusT * tSquared * points.cp2X +
    tCubed * points.endX;

  const y =
    oneMinusTCubed * points.startY +
    3 * oneMinusTSquared * t * points.cp1Y +
    3 * oneMinusT * tSquared * points.cp2Y +
    tCubed * points.endY;

  return { x, y };
}
