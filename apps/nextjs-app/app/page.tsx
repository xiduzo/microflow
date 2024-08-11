import { Faqs } from '@/components/Faqs';
import { Footer } from '@/components/Footer';
import { Header } from '@/components/Header';
import { Hero } from '@/components/Hero';
import { NavLink } from '@/components/NavLink';
import { PrimaryFeatures } from '@/components/PrimaryFeatures';

export default function Home() {
	return (
		<>
			<Header>
				<div className="hidden md:flex md:gap-x-6">
					<NavLink href="#features">Features</NavLink>
					<NavLink href="#faq">FAQs</NavLink>
				</div>
			</Header>
			<main>
				<Hero />
				<PrimaryFeatures />
				<Faqs />
				<Footer />
			</main>
		</>
	);
}
