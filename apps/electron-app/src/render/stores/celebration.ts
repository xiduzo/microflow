import { create } from 'zustand';
import { toast } from '@microflow/ui';
import { Container, type ISourceOptions } from '@tsparticles/engine';
import { initParticlesEngine } from '@tsparticles/react';
import { loadFull } from 'tsparticles';
import React, { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/shallow';

type CelebrationState = {
	container: Container | undefined;
	init: boolean;
	setContainer: (container: Container | undefined) => void;
	setInit: (init: boolean) => void;
	celebrate: (message?: string) => Promise<void>;
};

export const useCelebrationStore = create<CelebrationState>((set, get) => ({
	container: undefined,
	init: false,
	setContainer: (container: Container | undefined) => set({ container }),
	setInit: (init: boolean) => set({ init }),
	celebrate: async (message?: string) => {
		const { container } = get();

		if (!container) return;

		try {
			await container.refresh();
			container.play();
		} catch (error) {
			console.error('❌ Error playing particles:', error);
		}

		if (!message) return;

		toast.success(message, {
			icon: '🚀',
			duration: 10000,
		});
	},
}));

export const useCelebration = () => useCelebrationStore(useShallow(state => state.celebrate));

export const useParticles = () => {
	const { init, setContainer } = useCelebrationStore(
		useShallow(state => ({
			init: state.init,
			setContainer: state.setContainer,
		}))
	);
	const initializedRef = useRef(false);

	// Initialize particles on mount only once
	useEffect(() => {
		if (init || initializedRef.current) return;

		initializedRef.current = true;

		const initializeParticles = async () => {
			try {
				await initParticlesEngine(async engine => {
					await loadFull(engine);
				});
				useCelebrationStore.getState().setInit(true);
			} catch (error) {
				console.error('❌ Failed to initialize particles engine:', error);
			}
		};

		initializeParticles();
	}, [init]);

	return {
		init,
		setContainer,
	};
};
