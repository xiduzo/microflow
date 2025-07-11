export const COMPARE_VALIDATORS = ['boolean', 'number', 'text'] as const;
export type CompareValidator = (typeof COMPARE_VALIDATORS)[number];

export const COMPARE_SUB_VALIDATORS = {
	boolean: ['true'] as const,
	number: ['equal to', 'greater than', 'less than', 'between', 'outside', 'even', 'odd'] as const,
	text: ['equal to', 'including', 'starting with', 'ending with'] as const, // TODO regex
} as const;
export type CompareSubValidator = (typeof COMPARE_SUB_VALIDATORS)[CompareValidator][number];
