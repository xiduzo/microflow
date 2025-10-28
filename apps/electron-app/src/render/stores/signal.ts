import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';

export type Signal = {
	id: string;
	edgeId: string;
	startTime: number;
};

export const SIGNAL_DURATION = 200;
export type SignalState = {
	signals: Map<string, Signal[]>;
	addSignal: (edgeId: string) => void;
	removeSignal: (edgeId: string, signalId: string) => void;
	getEdgeSignals: (edgeId: string) => Signal[];
	clearSignals: () => void;
	clearEdgeSignals: (edgeId: string) => void;
};

export const useSignalStore = create<SignalState>((set, get) => ({
	signals: new Map(),

	addSignal: (edgeId: string) => {
		const signal: Signal = {
			id: `${edgeId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
			edgeId,
			startTime: Date.now(),
		};

		set(state => {
			const newSignals = new Map(state.signals);
			const existingSignals = newSignals.get(edgeId) || [];
			newSignals.set(edgeId, [...existingSignals, signal]);
			return { signals: newSignals };
		});

		// Auto-cleanup after 500ms + buffer
		setTimeout(() => {
			get().removeSignal(edgeId, signal.id);
		}, SIGNAL_DURATION + 10);
	},

	removeSignal: (edgeId: string, signalId: string) => {
		set(state => {
			const newSignals = new Map(state.signals);
			const existingSignals = newSignals.get(edgeId) || [];
			const filteredSignals = existingSignals.filter(signal => signal.id !== signalId);

			if (filteredSignals.length === 0) {
				newSignals.delete(edgeId);
			} else {
				newSignals.set(edgeId, filteredSignals);
			}

			return { signals: newSignals };
		});
	},

	getEdgeSignals: (edgeId: string) => {
		return get().signals.get(edgeId) || [];
	},

	clearSignals: () => {
		set({ signals: new Map() });
	},

	clearEdgeSignals: (edgeId: string) => {
		set(state => {
			const newSignals = new Map(state.signals);
			newSignals.delete(edgeId);
			return { signals: newSignals };
		});
	},
}));

export function useEdgeSignals(edgeId: string) {
	return useSignalStore(useShallow(state => state.getEdgeSignals(edgeId)));
}

export function useSignalActions() {
	return useSignalStore(
		useShallow(state => ({
			addSignal: state.addSignal,
			removeSignal: state.removeSignal,
			clearSignals: state.clearSignals,
			clearEdgeSignals: state.clearEdgeSignals,
		}))
	);
}
