import { BaseEdge, getSimpleBezierPath, type EdgeProps } from '@xyflow/react';
import { Signal, SIGNAL_DURATION, useEdgeSignals } from '../../stores/signal';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@microflow/ui';

const SIGNAL_RATE_THRESHOLD = 10;
const RATE_WINDOW_MS = 500;

export function AnimatedSVGEdge({ id, sourceX, sourceY, targetX, targetY }: EdgeProps) {
	const signals = useEdgeSignals(id);
	const signalTimestampsRef = useRef<Set<number>>(new Set());
	const [useLightweightMode, setUseLightweightMode] = useState(false);

	const [edgePath] = useMemo(() => {
		return getSimpleBezierPath({
			sourceX,
			sourceY,
			targetX,
			targetY,
		});
	}, [sourceX, sourceY, targetX, targetY]);

	useEffect(() => {
		const now = Date.now();
		const cutoffTime = now - RATE_WINDOW_MS;

		signals.forEach(signal => {
			signalTimestampsRef.current.add(signal.startTime);
		});

		const validTimestamps = new Set<number>();
		signalTimestampsRef.current.forEach(timestamp => {
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
		return <AnimatedEdge id={id} edgePath={edgePath} hasSignals={signals.length > 0} />;
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

function EdgeWithSignals({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	signals,
	edgePath,
}: Pick<EdgeProps, 'id' | 'sourceX' | 'sourceY' | 'targetX' | 'targetY'> & {
	signals: Signal[];
	edgePath: string;
}) {
	// Parse the path once and cache the control points
	const bezierPoints = useMemo(() => {
		return parseBezierPath(edgePath, sourceX, sourceY, targetX, targetY);
	}, [edgePath, sourceX, sourceY, targetX, targetY]);

	const [signalPositions, setSignalPositions] = useState<Map<string, { x: number; y: number }>>(
		new Map()
	);
	const isMountedRef = useRef(true);

	// Clean up signalPositions when signals are removed
	useEffect(() => {
		const signalIds = new Set(signals.map(s => s.id));
		setSignalPositions(prev => {
			const filtered = new Map<string, { x: number; y: number }>();
			prev.forEach((position, signalId) => {
				if (signalIds.has(signalId)) {
					filtered.set(signalId, position);
				}
			});
			return filtered;
		});
	}, [signals]);

	useEffect(() => {
		isMountedRef.current = true;
		const interval = setInterval(() => {
			if (!isMountedRef.current) return;

			const now = Date.now();
			const newPositions = new Map<string, { x: number; y: number }>();

			signals.forEach(signal => {
				const elapsed = now - signal.startTime;
				const progress = Math.max(0, Math.min(1, elapsed / SIGNAL_DURATION));

				// Calculate position along the Bezier curve path
				const position = getPointOnBezierCurve(bezierPoints, progress);

				newPositions.set(signal.id, position);
			});

			// Only update if component is still mounted
			if (isMountedRef.current) {
				setSignalPositions(newPositions);
			}
		}, 16); // ~60fps

		return () => {
			isMountedRef.current = false;
			clearInterval(interval);
		};
	}, [signals, bezierPoints]);

	return (
		<>
			<BaseEdge id={id} path={edgePath} />
			{signals.map(signal => {
				const position = signalPositions.get(signal.id);
				if (!position) return null;

				return <circle key={signal.id} r='8' fill='#ffcc00' cx={position.x} cy={position.y} />;
			})}
		</>
	);
}

function AnimatedEdge({
	id,
	edgePath,
	hasSignals,
}: Pick<EdgeProps, 'id'> & {
	edgePath: string;
	hasSignals: boolean;
}) {
	return (
		<BaseEdge
			id={id}
			path={edgePath}
			className={cn({
				animated: hasSignals,
			})}
		/>
	);
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
	targetY: number
): BezierPoints {
	// Parse the SVG path to extract control points
	// Format: M x,y C cx1,cy1 cx2,cy2 x,y
	const pathMatch = path.match(
		/M\s*([\d.-]+),([\d.-]+)\s*C\s*([\d.-]+),([\d.-]+)\s*([\d.-]+),([\d.-]+)\s*([\d.-]+),([\d.-]+)/
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
