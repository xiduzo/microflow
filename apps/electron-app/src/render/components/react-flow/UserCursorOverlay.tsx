import { useReactFlow } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { Icon } from '@microflow/ui';
import { PeerCursor, useYjsStore } from '../../stores/yjs';

const hexToRgb = (hex: string) => {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return { r, g, b };
};

const getLuminance = (color: string) => {
	const rgb = hexToRgb(color);
	return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
};

const calculateContrastColor = (color: string) => {
	const luminance = getLuminance(color);
	return luminance > 0.5 ? '#000000' : '#ffffff';
};

export function UserCursorOverlay() {
	const { getViewport, flowToScreenPosition } = useReactFlow();
	const [peerCursors, setPeerCursors] = useState<PeerCursor[]>([]);
	const [localClientId, setLocalClientId] = useState<number | null>(null);
	const yjsStore = useYjsStore();

	useEffect(() => {
		// Set up peer cursor update listener
		yjsStore.onPeerCursorsUpdate(cursors => {
			setPeerCursors(cursors);
		});

		// Get local client ID
		const ydoc = yjsStore.ydoc;
		setLocalClientId(ydoc.clientID);

		return () => {
			// Cleanup if needed
		};
	}, [yjsStore]);

	// Filter out local cursor and cursors outside viewport
	const visibleCursors = peerCursors.filter(cursor => {
		if (cursor.clientId === localClientId) return false; // Don't show local cursor

		const viewport = getViewport();
		const cursorScreenPos = flowToScreenPosition(cursor.position);

		// Check if cursor is within viewport bounds (with some padding)
		const padding = 50;
		return (
			cursorScreenPos.x >= -padding &&
			cursorScreenPos.x <= window.innerWidth + padding &&
			cursorScreenPos.y >= -padding &&
			cursorScreenPos.y <= window.innerHeight + padding
		);
	});

	return (
		<div className='absolute inset-0 pointer-events-none z-10'>
			{visibleCursors.map(cursor => {
				const screenPosition = flowToScreenPosition(cursor.position);

				return (
					<div
						key={cursor.clientId}
						className='absolute transition-all duration-100 ease-out mt-4 ml-2'
						style={{
							left: screenPosition.x,
							top: screenPosition.y,
							transform: 'translate(-50%, -50%)',
						}}
					>
						<div className='flex items-center justify-center'>
							<Icon
								icon='MousePointer2'
								fill={cursor.color}
								stroke={cursor.color}
								size={24}
								className='drop-shadow-lg'
							/>
							<div
								className='text-xs px-1.5 py-0.5 rounded-md text-white font-medium drop-shadow-lg translate-y-4'
								style={{
									backgroundColor: cursor.color,
									color: calculateContrastColor(cursor.color),
								}}
							>
								{cursor.name}
							</div>
						</div>
					</div>
				);
			})}
		</div>
	);
}
