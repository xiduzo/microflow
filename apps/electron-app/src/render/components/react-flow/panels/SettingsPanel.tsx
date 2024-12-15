import { useAutoAnimate } from '@ui/index';

export function SettingsPanel() {
	const [animationRef] = useAutoAnimate({
		duration: 100,
	});

	return (
		<section id="settings-panels" className="flex flex-col space-y-2" ref={animationRef}>
			{/* Filled by settings */}
		</section>
	);
}
