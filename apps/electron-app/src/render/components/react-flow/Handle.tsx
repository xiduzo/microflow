import { cva, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@microflow/ui';
import {
	HandleProps,
	Position,
	Handle as XyFlowHandle,
	Edge,
	Connection,
	useEdges,
	useReactFlow,
	useNodeId,
} from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';

const HANDLE_SIZE = 14;
const HANDLE_TRANSLATE_OFFSET = HANDLE_SIZE * 0.9;

const HANDLE_SPACING_OFFSET = 12;
const HANDLE_SPACING = HANDLE_SIZE * 1.5;

export function Handle(props: Props) {
	const edges = useEdges();
	const ref = useRef<HTMLDivElement>(null);
	const { getZoom } = useReactFlow();
	const [showHandle, setShowHandle] = useState(false);

	const nodeId = useNodeId();
	const selectedEdges = useMemo(() => {
		return edges.filter(edge => edge.selected);
	}, [edges]);
	const isHandleSelectedViaEdge = useMemo(() => {
		return !!selectedEdges.find(
			edge =>
				(edge.target === nodeId && edge.targetHandle === props.id) ||
				(edge.source === nodeId && edge.sourceHandle === props.id)
		);
	}, [selectedEdges, nodeId, props.id]);

	const isConnectable = useMemo(() => {
		return typeof props.isConnectable === 'boolean'
			? props.isConnectable
			: (props.isConnectable?.(edges) ?? true);
	}, [props.isConnectable, edges]);

	const translate = useMemo(() => {
		switch (props.position) {
			case Position.Top:
				return `0 ${HANDLE_TRANSLATE_OFFSET}px`;
			case Position.Bottom:
				return `0 -${HANDLE_TRANSLATE_OFFSET}px`;
			case Position.Left:
				return `${HANDLE_TRANSLATE_OFFSET}px`;
			case Position.Right:
				return `-${HANDLE_TRANSLATE_OFFSET}px`;
		}
	}, [props.position]);

	useEffect(() => {
		function handleMouseClose(event: MouseEvent) {
			const zoom = getZoom();
			if (zoom < 0.75) {
				setShowHandle(false);
				return; // Ignore if zoomed out too much
			}

			const threshhold = zoom * 200;
			if (!ref.current) return;

			const mouseX = event.clientX;
			const mouseY = event.clientY;

			const boundingBox = ref.current.getBoundingClientRect();

			// Calculate the distance to each edge of the bounding box
			const distanceToLeft = mouseX < boundingBox.left ? boundingBox.left - mouseX : 0;
			const distanceToRight = mouseX > boundingBox.right ? mouseX - boundingBox.right : 0;
			const distanceToTop = mouseY < boundingBox.top ? boundingBox.top - mouseY : 0;
			const distanceToBottom = mouseY > boundingBox.bottom ? mouseY - boundingBox.bottom : 0;

			// Calculate the shortest distance to the bounding box
			const horizontalDistance = Math.max(distanceToLeft, distanceToRight);
			const verticalDistance = Math.max(distanceToTop, distanceToBottom);
			const distance = Math.sqrt(horizontalDistance ** 2 + verticalDistance ** 2);

			if (distance > threshhold) {
				setShowHandle(false);
				return; // Ignore if mouse is too far away
			}

			setShowHandle(true);
		}

		window.addEventListener('mousemove', handleMouseClose);

		return () => {
			window.removeEventListener('mousemove', handleMouseClose);
		};
	}, [props.id, getZoom]);

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<XyFlowHandle
						{...props}
						ref={ref}
						isConnectable={isConnectable}
						isValidConnection={edge => {
							if (props.isValidConnection) props.isValidConnection(edges, edge);

							// Can not connect to self
							if (edge.source === edge.target) return false;
							return true;
						}}
						className={handle({
							position: props.position,
							className: props.className,
							isHandleSelectedViaEdge: isHandleSelectedViaEdge,
						})}
						style={{
							width: HANDLE_SIZE,
							height: HANDLE_SIZE,
							marginLeft: [Position.Top, Position.Bottom].includes(props.position)
								? HANDLE_SPACING * 2 * (props.offset ?? 0)
								: 0,
							marginTop: [Position.Left, Position.Right].includes(props.position)
								? HANDLE_SPACING * (props.offset ?? 0) + HANDLE_SPACING_OFFSET
								: 0,
							translate,
							...props.style,
						}}
					>
						<span
							className={handleText({
								position: props.position,
								showHandle: showHandle || isHandleSelectedViaEdge,
								isHandleSelectedViaEdge: isHandleSelectedViaEdge,
							})}
						>
							{String(props.title ?? props.id).toLowerCase()}
						</span>
					</XyFlowHandle>
				</TooltipTrigger>
				{props.hint && <TooltipContent side={props.position}>{props.hint}</TooltipContent>}
			</Tooltip>
		</TooltipProvider>
	);
}

type Props = Omit<HandleProps, 'isConnectable' | 'isValidConnection'> & {
	offset?: number;
	hint?: string;
	isConnectable?: ((edges: Edge[]) => boolean) | boolean;
	isValidConnection?: (edges: Edge[], edge: Edge | Connection) => boolean;
};

const handle = cva('text-xs flex z-50 shadow-none', {
	variants: {
		position: {
			left: 'items-center justify-start',
			right: 'items-center justify-end',
			top: 'justify-center',
			bottom: 'justify-center',
		},
		isHandleSelectedViaEdge: {
			true: 'selected-via-edge',
			false: '',
		},
	},
});

const handleText = cva('pointer-events-none mb-0.5 transition-all', {
	variants: {
		position: {
			left: 'translate-x-5',
			right: '-translate-x-5',
			top: 'translate-y-5',
			bottom: '-translate-y-5',
		},
		showHandle: {
			true: 'opacity-100',
			false: 'opacity-0',
		},
		isHandleSelectedViaEdge: {
			true: 'selected-via-edge',
			false: '',
		},
	},
});
