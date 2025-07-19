import { FigmaDeepLink } from '@/components/FigmaDeepLink';
import { Header } from '@/components/Header';

export default function Set() {
	return (
		<>
			<Header></Header>
			<main className="p-2 w-screen h-screen flex items-center justify-center flex-col">
				<FigmaDeepLink />
				<div>This page should close automatically.</div>
				<div>If not, you should open your Figma prototype from the browser.</div>
				<a
					href="/docs/microflow-hardware-bridge/variables/manipulating#updating-variables-from-within-a-prototype"
					className="underline py-2"
				>
					Read more why
				</a>
				<div className="text-muted-foreground mt-4">-xoxo- Microflow</div>
			</main>
		</>
	);
}
