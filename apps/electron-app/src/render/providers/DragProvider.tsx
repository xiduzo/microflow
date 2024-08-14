import {
	createContext,
	PropsWithChildren,
	useContext,
	useEffect,
	useState,
} from 'react';

const DragContext = createContext({
	dragging: '',
	setDragging: (id: string) => () => {},
	setHover: (id: string) => () => {},
});

export function DragProvider(
	props: PropsWithChildren & { swap: (id: string, afterId: string) => void },
) {
	const [dragging, internalSetDragging] = useState('');
	const [hover, internalSetHover] = useState('');

	const setDragging = (id: string) => () => {
		internalSetDragging(id);
	};

	const setHover = (id: string) => () => {
		internalSetHover(id);
	};

	useEffect(() => {
		if (dragging === '' || hover === '') {
			return;
		}

		if (dragging === hover) {
			return;
		}

		internalSetHover('');
		props.swap(dragging, hover);
	}, [dragging, hover, props.swap]);

	return (
		<DragContext.Provider
			value={{
				dragging,
				setDragging,
				setHover,
			}}
		>
			{props.children}
		</DragContext.Provider>
	);
}

export function useDrag() {
	return useContext(DragContext);
}
