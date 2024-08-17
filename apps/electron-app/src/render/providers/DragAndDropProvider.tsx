import {
    createContext,
    PropsWithChildren,
    useContext,
    useEffect,
    useState,
} from 'react';

const DragAndDropContext = createContext({
	dragging: '',
	setDragging: (id: string) => () => {},
	setHover: (id: string) => () => {},
});

type Actions = {
	swap?: (id: string, hoveredId: string) => void;
	onDragDone?: () => void;
};

export function DragAndDropProvider(props: PropsWithChildren & Actions) {
	const [dragging, internalSetDragging] = useState('');
	const [hover, internalSetHover] = useState('');

	const setDragging = (id: string) => () => {
		internalSetDragging(id);

		if(id === ''){
      props.onDragDone?.();
    }
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
		props.swap?.(dragging, hover);
	}, [dragging, hover, props.swap, props.onDragDone]);

	return (
		<DragAndDropContext.Provider
			value={{
				dragging,
				setDragging,
				setHover,
			}}
		>
			{props.children}
		</DragAndDropContext.Provider>
	);
}

export function useDragAndDrop() {
	return useContext(DragAndDropContext);
}
