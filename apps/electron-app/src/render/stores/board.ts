import { create } from 'zustand';
import { BoardCheckResult, MODES, UploadResponse } from '../../common/types';
import { useShallow } from 'zustand/shallow';

type BoardState = {
	board: BoardCheckResult;
	setBoardResult: (result: BoardCheckResult) => void;
	upload: UploadResponse;
	setUploadResult: (result: UploadResponse) => void;
};

export const useBoardStore = create<BoardState>((set, get) => {
	return {
		board: { type: 'close' },
		setBoardResult: (result: BoardCheckResult) => {
			set({ board: result });
		},
		upload: { type: 'close' },
		setUploadResult: (result: UploadResponse) => {
			set({ upload: { pins: get().upload.pins, ...result } });
		},
	};
});

export const usePins = (shouldHaveMode?: MODES[], shouldNotHaveMode?: MODES[]) =>
	useBoardStore(
		useShallow((state: BoardState) => {
			if (!state.upload.pins) return [];
			if (!shouldHaveMode?.length) return state.upload.pins;
			const pins = state.upload.pins.filter(pin =>
				shouldHaveMode.every(mode => pin.supportedModes.includes(mode))
			);

			if (!shouldNotHaveMode?.length) return pins;

			return pins.filter(pin => !shouldNotHaveMode.some(mode => pin.supportedModes.includes(mode)));
		})
	);

export const useUploadResult = () =>
	useBoardStore(useShallow((state: BoardState) => state.upload.type));

export const useBoardPort = () =>
	useBoardStore(useShallow((state: BoardState) => state.board.port));

export const useBoardCheckResult = () =>
	useBoardStore(useShallow((state: BoardState) => state.board.type));
