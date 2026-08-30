import { cn } from "@/lib/utils";
import { SIGNAL_DURATION, useEdgeSignals, type Signal } from "@/stores/signal";
import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";

const SIGNAL_RATE_THRESHOLD = 10;
const RATE_WINDOW_MS = 500;

/** Shared identity for "this edge is showing nothing", so an idle edge's state
 *  update is a no-op rather than a re-render with a fresh empty Map. */
const EMPTY_POSITIONS = new Map<string, { x: number; y: number }>();

export function AnimatedEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = props;
  const signals = useEdgeSignals(id);
  const signalTimestampsRef = useRef<Set<number>>(new Set());
  const [useLightweightMode, setUseLightweightMode] = useState(false);

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

  useEffect(() => {
    const now = Date.now();
    const cutoffTime = now - RATE_WINDOW_MS;

    signals.forEach((signal) => {
      signalTimestampsRef.current.add(signal.startTime);
    });

    const validTimestamps = new Set<number>();
    signalTimestampsRef.current.forEach((timestamp) => {
      if (timestamp < cutoffTime) return;
      validTimestamps.add(timestamp);
    });
    signalTimestampsRef.current = validTimestamps;

    const signalsInWindow = signalTimestampsRef.current.size;
    const rate = (signalsInWindow / RATE_WINDOW_MS) * 1000;

    setUseLightweightMode(rate >= SIGNAL_RATE_THRESHOLD);
  }, [signals]);

  // Switch to lightweight AnimatedEdge when signal rate is high
  if (useLightweightMode) {
    return <AnimatedBaseEdge id={id} edgePath={edgePath} hasSignals={signals.length > 0} />;
  }

  return (
    <EdgeWithSignals
      id={id}
      sourceX={sourceX}
      sourceY={sourceY}
      targetX={targetX}
      targetY={targetY}
      signals={signals}
      edgePath={edgePath}
    />
  );
}

function EdgeWithSignals(
  props: Pick<EdgeProps, "id" | "sourceX" | "sourceY" | "targetX" | "targetY"> & {
    signals: Signal[];
    edgePath: string;
  },
) {
  const { id, sourceX, sourceY, targetX, targetY, signals, edgePath } = props;
  // Parse the path once and cache the control points
  const bezierPoints = useMemo(() => {
    return parseBezierPath(edgePath, sourceX, sourceY, targetX, targetY);
  }, [edgePath, sourceX, sourceY, targetX, targetY]);

  const [signalPositions, setSignalPositions] =
    useState<Map<string, { x: number; y: number }>>(EMPTY_POSITIONS);

  // Animate only while this edge actually carries signals. The previous
  // `setInterval(…, 16)` ran unconditionally, so an idle canvas woke one timer
  // per edge 60 times a second and re-rendered every edge with a freshly-built
  // position Map — the dominant idle cost on any flow of a few dozen wires.
  // Signals are also short-lived (`SIGNAL_DURATION`), so this stops on its own
  // once the last one expires. `requestAnimationFrame` additionally pauses in a
  // background tab, which `setInterval` does not.
  useEffect(() => {
    if (signals.length === 0) {
      // Only publish the empty Map if we are not already showing it, so an idle
      // edge settles at exactly one render rather than looping.
      setSignalPositions((prev) => (prev.size === 0 ? prev : EMPTY_POSITIONS));
      return;
    }

    let frame = requestAnimationFrame(function step() {
      const now = Date.now();
      const newPositions = new Map<string, { x: number; y: number }>();
      for (const signal of signals) {
        const progress = Math.max(0, Math.min(1, (now - signal.startTime) / SIGNAL_DURATION));
        newPositions.set(signal.id, getPointOnBezierCurve(bezierPoints, progress));
      }
      setSignalPositions(newPositions);
      frame = requestAnimationFrame(step);
    });

    return () => cancelAnimationFrame(frame);
  }, [signals, bezierPoints]);

  return (
    <>
      <BaseEdge id={id} path={edgePath} />
      {signals.map((signal) => {
        const position = signalPositions.get(signal.id);
        if (!position) return null;

        return <circle key={signal.id} r="8" fill="#ffcc00" cx={position.x} cy={position.y} />;
      })}
    </>
  );
}

function AnimatedBaseEdge({
  id,
  edgePath,
  hasSignals,
}: Pick<EdgeProps, "id"> & {
  edgePath: string;
  hasSignals: boolean;
}) {
  return <BaseEdge id={id} path={edgePath} className={cn({ animated: hasSignals })} />;
}

type BezierPoints = {
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
function parseBezierPath(
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
