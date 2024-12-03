import { create } from 'zustand';
import { BoardResult, UploadResult } from '../../common/types';
import { useShallow } from 'zustand/react/shallow';

type BoardState = {
	board: BoardResult;
	setBoardResult: (result: BoardResult) => void;
	upload: UploadResult;
	setUploadResult: (result: UploadResult) => void;
};

export const useBoardStore = create<BoardState>(set => {
	return {
		board: { type: 'close' },
		setBoardResult: (result: BoardResult) => {
			set({ board: result });
		},
		upload: { type: 'close' },
		setUploadResult: (result: UploadResult) => {
			set({ upload: result });
		},
	};
});

export const usePins = () =>
	useBoardStore(useShallow((state: BoardState) => state.board.pins ?? []));

export const useUploadResult = () =>
	useBoardStore(useShallow((state: BoardState) => state.upload.type));

export const useBoardPort = () =>
	useBoardStore(useShallow((state: BoardState) => state.board.port));

export const useBoardResult = () =>
	useBoardStore(useShallow((state: BoardState) => state.board.type));
