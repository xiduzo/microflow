import { Container, ISourceOptions } from '@tsparticles/engine';
import Particles from '@tsparticles/react';
import { useParticles } from '../stores/celebration';
import { useCallback, memo } from 'react';

export const CelebrationParticles = memo(function CelebrationParticles() {
	const { init, setContainer } = useParticles();

	const particlesLoaded = useCallback(
		async (loadedContainer: Container | undefined) => {
			setContainer(loadedContainer);
		},
		[setContainer]
	);

	if (!init) return null;

	return (
		<Particles
			className='z-50 pointer-events-none fixed inset-0'
			id='tsparticles'
			particlesLoaded={particlesLoaded}
			options={PARTICLE_OPTIONS}
		/>
	);
});

const PARTICLE_OPTIONS: ISourceOptions = {
	autoPlay: false,
	fpsLimit: 120,
	pauseOnBlur: false,
	pauseOnOutsideViewport: false,
	emitters: {
		life: {
			count: 20,
			duration: 0.05,
			delay: 0.2,
		},
		position: {
			x: 50,
			y: 100,
		},
		rate: {
			quantity: 12,
			delay: 0.15,
		},
	},
	particles: {
		color: {
			value: ['#eab308', '#3b82f6'],
		},
		move: {
			decay: 0.05,
			direction: 'top',
			enable: true,
			gravity: {
				enable: true,
			},
			outModes: {
				top: 'none',
				default: 'destroy',
			},
			speed: {
				min: 50,
				max: 100,
			},
		},
		number: {
			value: 0,
		},
		opacity: {
			value: 1,
		},
		rotate: {
			value: {
				min: 0,
				max: 360,
			},
			direction: 'random',
			animation: {
				enable: true,
				speed: 30,
			},
		},
		tilt: {
			direction: 'random',
			enable: true,
			value: {
				min: 0,
				max: 360,
			},
			animation: {
				enable: true,
				speed: 30,
			},
		},
		size: {
			value: 3,
			animation: {
				enable: true,
				startValue: 'min',
				count: 1,
				speed: 16,
				sync: true,
			},
		},
		roll: {
			darken: {
				enable: true,
				value: 25,
			},
			enlighten: {
				enable: true,
				value: 25,
			},
			enable: true,
			speed: {
				min: 5,
				max: 15,
			},
		},
		wobble: {
			distance: 30,
			enable: true,
			speed: {
				min: -7,
				max: 7,
			},
		},
		shape: {
			type: ['circle', 'square', 'polygon'],
			options: {
				polygon: [
					{
						sides: 5,
					},
					{
						sides: 6,
					},
				],
			},
		},
	},
	detectRetina: true,
};
