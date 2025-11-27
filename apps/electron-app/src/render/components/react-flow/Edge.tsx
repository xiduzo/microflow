import { BaseEdge, getSimpleBezierPath, type EdgeProps, Position } from '@xyflow/react';
import { Signal, SIGNAL_DURATION, useEdgeSignals } from '../../stores/signal';
import { useEffect, useMemo, useRef, useState } from 'react';

// Rate threshold: if more than this many signals per second, use lightweight mode
const SIGNAL_RATE_THRESHOLD = 10; // signals per second
const RATE_WINDOW_MS = 500; // time window to measure signal rate

// Helper function to calculate position along a Bezier curve at a given progress (0-1)
function getPointOnBezierCurve(
	path: string,
	sourceX: number,
	sourceY: number,
	targetX: number,
	targetY: number,
	progress: number
): { x: number; y: number } {
	// Parse the SVG path to extract control points
	// Format: M x,y C cx1,cy1 cx2,cy2 x,y
	const pathMatch = path.match(
		/M\s*([\d.-]+),([\d.-]+)\s*C\s*([\d.-]+),([\d.-]+)\s*([\d.-]+),([\d.-]+)\s*([\d.-]+),([\d.-]+)/
	);

	if (!pathMatch) {
		// Fallback to linear interpolation
		return {
			x: sourceX + (targetX - sourceX) * progress,
			y: sourceY + (targetY - sourceY) * progress,
		};
	}

	const [, startX, startY, cp1X, cp1Y, cp2X, cp2Y, endX, endY] = pathMatch.map(Number);

	// Calculate position along cubic Bezier curve using the formula:
	// B(t) = (1-t)³P₀ + 3(1-t)²tP₁ + 3(1-t)t²P₂ + t³P₃
	const t = progress;
	const oneMinusT = 1 - t;
	const oneMinusTSquared = oneMinusT * oneMinusT;
	const oneMinusTCubed = oneMinusTSquared * oneMinusT;
	const tSquared = t * t;
	const tCubed = tSquared * t;

	const x =
		oneMinusTCubed * startX +
		3 * oneMinusTSquared * t * cp1X +
		3 * oneMinusT * tSquared * cp2X +
		tCubed * endX;

	const y =
		oneMinusTCubed * startY +
		3 * oneMinusTSquared * t * cp1Y +
		3 * oneMinusT * tSquared * cp2Y +
		tCubed * endY;

	return { x, y };
}

export function AnimatedSVGEdge({ id, sourceX, sourceY, targetX, targetY }: EdgeProps) {
	const signals = useEdgeSignals(id);
	const signalTimestampsRef = useRef<number[]>([]);
	const [useLightweightMode, setUseLightweightMode] = useState(false);

	const [edgePath] = useMemo(() => {
		return getSimpleBezierPath({
			sourceX,
			sourceY,
			targetX,
			targetY,
		});
	}, [sourceX, sourceY, targetX, targetY]);

	// Track signal addition rate to detect continuous spamming
	// Since signals clean up after themselves (150ms duration), we track the rate
	// of signal additions over a time window to detect high-frequency activity
	useEffect(() => {
		const now = Date.now();

		// Record timestamps of active signals (they represent recent additions)
		// Use a Set to efficiently track unique timestamps
		const activeSignalTimestamps = new Set(signals.map(s => s.startTime));

		// Add new signal timestamps to our tracking array
		activeSignalTimestamps.forEach(timestamp => {
			if (!signalTimestampsRef.current.includes(timestamp)) {
				signalTimestampsRef.current.push(timestamp);
			}
		});

		// Clean up old timestamps outside the measurement window
		const cutoffTime = now - RATE_WINDOW_MS;
		signalTimestampsRef.current = signalTimestampsRef.current.filter(ts => ts >= cutoffTime);

		// Calculate signal rate (signals per second)
		// If we see many unique signal start times within the window, we're in high-traffic mode
		const signalsInWindow = signalTimestampsRef.current.length;
		const rate = (signalsInWindow / RATE_WINDOW_MS) * 1000; // signals per second

		// Switch to lightweight mode if rate exceeds threshold
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
	const positions = useMemo(() => {
		return { sourceX, sourceY, targetX, targetY };
	}, [edgePath, sourceX, sourceY, targetX, targetY]);

	const [signalPositions, setSignalPositions] = useState<Map<string, { x: number; y: number }>>(
		new Map()
	);

	useEffect(() => {
		const interval = setInterval(() => {
			const now = Date.now();
			const newPositions = new Map<string, { x: number; y: number }>();

			signals.forEach(signal => {
				const elapsed = now - signal.startTime;
				const progress = Math.max(0, Math.min(1, elapsed / SIGNAL_DURATION));

				// Calculate position along the Bezier curve path
				const position = getPointOnBezierCurve(
					edgePath,
					positions.sourceX,
					positions.sourceY,
					positions.targetX,
					positions.targetY,
					progress
				);

				newPositions.set(signal.id, position);
			});

			setSignalPositions(newPositions);
		}, 16); // ~60fps

		return () => clearInterval(interval);
	}, [signals, edgePath, positions]);

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
		<g data-animated-edge={hasSignals ? 'true' : undefined}>
			<BaseEdge id={id} path={edgePath} />
		</g>
	);
}
