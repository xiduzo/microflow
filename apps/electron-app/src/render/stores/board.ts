import { create } from 'zustand';
import { Board, MODES } from '../../common/types';
import { useShallow } from 'zustand/shallow';

type BoardState = {
	board: Board;
	setBoard: (board: Board) => void;
};

export const useBoardStore = create<BoardState>((set, get) => {
	return {
		board: { type: 'close' },
		setBoard: (board: Board) => {
			set({ board: board });
		},
	};
});

export const usePins = (shouldHaveMode?: MODES[], shouldNotHaveMode?: MODES[]) =>
	useBoardStore(
		useShallow((state: BoardState) => {
			if (!state.board.pins) return [];
			if (!shouldHaveMode?.length) return state.board.pins;
			const pins = state.board.pins.filter(pin =>
				shouldHaveMode.every(mode => pin.supportedModes.includes(mode))
			);

			if (!shouldNotHaveMode?.length) return pins;

			return pins.filter(pin => !shouldNotHaveMode.some(mode => pin.supportedModes.includes(mode)));
		})
	);

export const useBoardPort = () => useBoardStore(useShallow(({ board }) => board.port));

export const useBoardCheckResult = () => useBoardStore(useShallow(({ board }) => board.type));

export const useBoard = () => useBoardStore(useShallow(({ board }) => board));
