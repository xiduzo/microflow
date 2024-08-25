import { Container } from './Container';

const faqs = [
	[
		{
			question: 'Is Microflow free?',
			answer: 'Yes, and we are committed to providing a free platform for all starters.',
		},
		{
			question: 'My micro-controller does not connect, why?',
			answer:
				'As of right now we support the following boards: <code>Arduino uno</code>, <code>Arduino mega</code>, <code>Arduino leonardo</code>, <code>Arduino micro</code>, <code>Arduino nano</code> and <code>Arduino yun</code>',
		},
		{
			question: 'I found a bug, what should I do?',
			answer:
				'<a class="underline" href="https://github.com/xiduzo/microflow-studio/issues" target="_blank">Create an issue</a> so we are aware of the bug, thank you.',
		},
	],
	[
		{
			question: 'My sensor is not supported, what can I do?',
			answer:
				'Bummer, to add support for it you can create a pull request on our <a class="underline" href="https://github.com/xiduzo/microflow-studio" target="_blank">GitHub repository</a> to support it.',
		},
		{
			question: 'Can Micorflow do...?',
			answer: 'Probably not, but Microflow is open-source and you can add the feature yourself!',
		},
	],
	[
		{
			question: 'How can I support this project?',
			answer:
				'Spread the word! Share Microflow with your friends and colleagues, and star our <a class="underline" href="https://github.com/xiduzo/microflow-studio" target="_blank">GitHub repository</a>.', //  If you want to support us financially, you can donate on our Open Collective page.
		},
		{
			question: 'You are awesome!',
			answer: 'Not really a question, but thank you! You are are awesome too ♥️',
		},
	],
];

export function Faqs() {
	return (
		<section
			id="faq"
			aria-labelledby="faq-title"
			className="relative overflow-hidden bg-slate-950 py-20 sm:py-32"
		>
			<Container className="relative">
				<div className="mx-auto max-w-2xl lg:mx-0">
					<h2
						id="faq-title"
						className="font-display text-3xl tracking-tight text-slate-50 sm:text-4xl"
					>
						Frequently asked questions
					</h2>
					<p className="mt-4 text-lg tracking-tight text-slate-400">
						Some of the most common questions answered for you.
					</p>
				</div>
				<ul
					role="list"
					className="mx-auto mt-16 grid max-w-2xl grid-cols-1 gap-8 lg:max-w-none lg:grid-cols-3"
				>
					{faqs.map((column, columnIndex) => (
						<li key={columnIndex}>
							<ul role="list" className="flex flex-col gap-y-8">
								{column.map((faq, faqIndex) => (
									<li key={faqIndex}>
										<h3 className="font-display text-lg leading-7 text-slate-50">{faq.question}</h3>
										<p
											className="mt-4 text-sm text-slate-400"
											dangerouslySetInnerHTML={{ __html: faq.answer }}
										/>
									</li>
								))}
							</ul>
						</li>
					))}
				</ul>
			</Container>
		</section>
	);
}
