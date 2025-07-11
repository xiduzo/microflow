import { create } from 'zustand';
import { BoardCheckResult, UploadResponse } from '../../common/types';
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

export const usePins = () =>
	useBoardStore(useShallow((state: BoardState) => state.upload.pins ?? []));

export const useUploadResult = () =>
	useBoardStore(useShallow((state: BoardState) => state.upload.type));

export const useBoardPort = () =>
	useBoardStore(useShallow((state: BoardState) => state.board.port));

export const useBoardCheckResult = () =>
	useBoardStore(useShallow((state: BoardState) => state.board.type));
