import { ShareDeepLink } from '@/components/ShareDeepLink';
import { Header } from '@/components/Header';

export default function Set() {
	return (
		<>
			<Header></Header>
			<main className="p-2 w-screen h-screen flex items-center justify-center flex-col">
				<div>Microflow studio should automatically open.</div>
				<div>If not, your machine might not accept deeplinks.</div>
				<ShareDeepLink />
				<div className="text-muted-foreground mt-4">-xoxo- Microflow</div>
			</main>
		</>
	);
}
