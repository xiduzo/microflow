import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from '@microflow/ui';
import { HandleProps, Position, Handle as XyFlowHandle } from '@xyflow/react';

const HANDLE_SPACING = 28;
const NODER_HEADER_HEIGHT_SPACING = 16;

export function Handle(props: Props) {
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<XyFlowHandle
						{...props}
						style={{
							width: [Position.Top, Position.Bottom].includes(props.position)
								? 24
								: 12,
							height: [Position.Left, Position.Right].includes(props.position)
								? 24
								: 12,
							marginLeft: [Position.Top, Position.Bottom].includes(
								props.position,
							)
								? HANDLE_SPACING * (props.offset ?? 0)
								: 0,
							marginTop: [Position.Left, Position.Right].includes(
								props.position,
							)
								? HANDLE_SPACING * (props.offset ?? 0) +
									NODER_HEADER_HEIGHT_SPACING
								: 0,
							backgroundColor: '#737373',
							borderRadius: '16px',
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

type Props = HandleProps & {
	offset?: number;
	hint?: string;
};
