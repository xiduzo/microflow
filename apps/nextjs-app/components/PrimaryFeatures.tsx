'use client';
import Image from 'next/image';

import { Container } from '@/components/Container';

import figmaImage from '@/images/features/figma.png';
import hardwareImage from '@/images/features/hardware.png';
import mqttImage from '@/images/features/mqtt.png';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@microflow/ui';

const features = [
	{
		title: 'Hardware',
		description:
			'Connect sensors, lights, and other components to your device. Build interactions visually without writing code.',
		image: hardwareImage,
	},
	{
		title: 'MQTT',
		description:
			'Connect your device to the internet. Control it remotely or send data to other apps and services.',
		image: mqttImage,
	},
	{
		title: 'Figma',
		description:
			'Bring your Figma designs to life. Control them with real hardware to test and refine your prototypes.',
		image: figmaImage,
	},
];

export function PrimaryFeatures() {
	return (
		<section
			id='features'
			aria-label='Features for rapid prototyping'
			className='relative overflow-hidden bg-gradient-to-br from-blue-600 to-blue-500 pb-28 pt-20 sm:py-32'
		>
			<Container className='relative'>
				<div className='max-w-2xl md:mx-auto md:text-center xl:max-w-none'>
					<h2 className='font-display text-3xl tracking-tight text-white sm:text-4xl md:text-5xl'>
						Rapid prototyping
					</h2>
					<p className='mt-6 text-lg tracking-tight text-blue-100'>
						Don&apos;t worry about low-level coding, or coding at all for that matter!
					</p>
					<p className='mt-1 text-lg tracking-tight text-blue-100'>
						Focus on creating engaging interactions and bringing your ideas to life quickly.
					</p>
				</div>
				<Tabs defaultValue={features[0].title} className='mb-6 mt-14'>
					<TabsList className='w-full bg-transparent space-x-4'>
						{features.map(feature => (
							<TabsTrigger
								key={feature.title}
								value={feature.title}
								className='data-[state=active]:bg-white data-[state=active]:text-blue-500 text-white text-xl rounded-full hover:bg-white/10'
							>
								{feature.title}
							</TabsTrigger>
						))}
					</TabsList>
					{features.map(feature => (
						<TabsContent key={feature.title} value={feature.title}>
							<p className='mt-6 max-w-2xl m-auto text-center'>{feature.description}</p>
							<div
								aria-hidden='true'
								className='w-2xl m-auto mt-8 overflow-hidden rounded-xl bg-slate-50 shadow-xl shadow-blue-900/20'
							>
								<Image
									className='w-full'
									src={feature.image}
									alt=''
									priority
									sizes='(min-width: 1024px) 67.8125rem, (min-width: 640px) 100vw, 45rem'
								/>
							</div>
						</TabsContent>
					))}
				</Tabs>
			</Container>
		</section>
	);
}
