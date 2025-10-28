import { getSimpleBezierPath, Position } from '@xyflow/react';

/**
 * Calculate the approximate length of a Bezier curve path
 * Uses the control points to estimate the curve length
 */
export function calculatePathLength(
	sourceX: number,
	sourceY: number,
	targetX: number,
	targetY: number,
	sourcePosition: Position,
	targetPosition: Position
): number {
	const [path] = getSimpleBezierPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
	});

	// Parse the SVG path to extract control points
	// Format: M x,y C cx1,cy1 cx2,cy2 x,y
	const pathMatch = path.match(
		/M\s*([\d.-]+),([\d.-]+)\s*C\s*([\d.-]+),([\d.-]+)\s*([\d.-]+),([\d.-]+)\s*([\d.-]+),([\d.-]+)/
	);

	if (!pathMatch) {
		// Fallback to straight line distance
		return Math.sqrt(Math.pow(targetX - sourceX, 2) + Math.pow(targetY - sourceY, 2));
	}

	const [, startX, startY, cp1X, cp1Y, cp2X, cp2Y, endX, endY] = pathMatch.map(Number);

	// Approximate Bezier curve length using control points
	// This is a simplified approximation - for more accuracy, we could use numerical integration
	const dx1 = cp1X - startX;
	const dy1 = cp1Y - startY;
	const dx2 = cp2X - cp1X;
	const dy2 = cp2Y - cp1Y;
	const dx3 = endX - cp2X;
	const dy3 = endY - cp2Y;

	// Calculate approximate length using control point distances
	const length1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
	const length2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
	const length3 = Math.sqrt(dx3 * dx3 + dy3 * dy3);

	return length1 + length2 + length3;
}

/**
 * Calculate animation duration based on edge path length
 * @param pathLength - Length of the edge path in pixels
 * @param speed - Animation speed in pixels per second (default: 500)
 * @returns Duration in milliseconds
 */
export function calculateEdgeDuration(pathLength: number, speed: number = 500): number {
	return (pathLength / speed) * 1000; // Convert to milliseconds
}
