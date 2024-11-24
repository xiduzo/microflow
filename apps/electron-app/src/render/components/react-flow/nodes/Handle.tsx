import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@microflow/ui';
import { HandleProps, Position, Handle as XyFlowHandle, Edge, useEdges } from '@xyflow/react';

const HANDLE_SPACING = 26;
const NODER_HEADER_HEIGHT_SPACING = 26;

export function Handle(props: Props) {
	const edges = useEdges();
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<XyFlowHandle
						{...props}
						isConnectable={props.isConnectable?.(edges) ?? true}
						style={{
							width: [Position.Top, Position.Bottom].includes(props.position) ? 20 : 10,
							height: [Position.Left, Position.Right].includes(props.position) ? 20 : 10,
							marginLeft: [Position.Top, Position.Bottom].includes(props.position)
								? HANDLE_SPACING * (props.offset ?? 0)
								: 0,
							marginTop: [Position.Left, Position.Right].includes(props.position)
								? HANDLE_SPACING * (props.offset ?? 0) + NODER_HEADER_HEIGHT_SPACING
								: 0,
							...props.style,
						}}
					/>
				</TooltipTrigger>
				<TooltipContent className="text-center">
					<p>{props.title ?? props.id}</p>
					{props.hint && <p className="text-muted-foreground">{props.hint}</p>}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

type Props = Omit<HandleProps, 'isConnectable'> & {
	offset?: number;
	hint?: string;
	isConnectable?: (edges: Edge[]) => boolean;
};
