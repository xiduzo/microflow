import { BaseEdge, getSimpleBezierPath, type EdgeProps, Position } from '@xyflow/react';
import { SIGNAL_DURATION, useEdgeSignals } from '../../stores/signal';
import { useEffect, useMemo, useState } from 'react';

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

export function AnimatedSVGEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
}: EdgeProps) {
	const [edgePath] = getSimpleBezierPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
	});

	const positions = useMemo(() => {
		return { sourceX, sourceY, targetX, targetY };
	}, [edgePath, sourceX, sourceY, targetX, targetY]);

	const signals = useEdgeSignals(id);
	const [signalPositions, setSignalPositions] = useState<Map<string, { x: number; y: number }>>(
		new Map()
	);

	useEffect(() => {
		const interval = setInterval(() => {
			const now = Date.now();
			const newPositions = new Map<string, { x: number; y: number }>();

			signals.forEach(signal => {
				const elapsed = now - signal.startTime;
				const progress = Math.max(0, Math.min(1, elapsed / SIGNAL_DURATION)); // Fixed 500ms duration

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
