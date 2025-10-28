import { BaseEdge, getSimpleBezierPath, type EdgeProps } from '@xyflow/react';

export function AnimatedSVGEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	animated,
}: EdgeProps) {
	const [edgePath] = getSimpleBezierPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
	});

	return (
		<>
			<BaseEdge id={id} path={edgePath} />
			{animated && (
				<circle r='8' fill='#ffcc00'>
					<animateMotion dur='0.15s' repeatCount='indefinite' path={edgePath} />
				</circle>
			)}
		</>
	);
}
