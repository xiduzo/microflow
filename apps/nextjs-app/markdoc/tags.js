import { Callout } from '@/components/Callout';
import { QuickLink, QuickLinks } from '@/components/QuickLinks';
import { Badge, Icon } from '@microflow/ui';

const tags = {
	callout: {
		attributes: {
			title: { type: String },
			type: {
				type: String,
				default: 'note',
				matches: ['note', 'warning'],
				errorLevel: 'critical',
			},
		},
		render: Callout,
	},
	figure: {
		selfClosing: true,
		attributes: {
			src: { type: String },
			alt: { type: String },
			caption: { type: String },
		},
		render: ({ src, alt = '', caption }) => (
			<figure>
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img src={src} alt={alt} />
				<figcaption>{caption}</figcaption>
			</figure>
		),
	},
	'quick-links': {
		render: QuickLinks,
	},
	'quick-link': {
		selfClosing: true,
		render: QuickLink,
		attributes: {
			title: { type: String },
			description: { type: String },
			icon: { type: String },
			href: { type: String },
		},
	},
	tag: {
		render: Badge,
		selfClosing: true,
		attributes: {
			title: { type: String },
		},
		render: props => {
			return (
				<Badge {...props} variant="secondary">
					{props.title}
				</Badge>
			);
		},
	},
	tags: {
		render: ({ children }) => {
			return <div className="flex flex-wrap gap-2">{children}</div>;
		},
	},
	icon: {
		selfClosing: true,
		attributes: {
			name: { type: String },
		},
		render: ({ name, className }) => {
			return <Icon icon={name} className={className} />;
		},
	},
};

export default tags;
