export const IF_ELSE_VALIDATORS = ['boolean', 'number', 'text'] as const;
export type Validator = (typeof IF_ELSE_VALIDATORS)[number];

export const IF_ELSE_SUB_VALIDATORS = {
	boolean: [null],
	number: ['equal to', 'greater than', 'less than', 'between', 'outside', 'is even', 'is odd'],
	text: ['equal to', 'includes', 'starts with', 'ends with'], // TODO regex
} as const;
export type SubValidator = (typeof IF_ELSE_SUB_VALIDATORS)[Validator][number];
