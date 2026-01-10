export const COMPARE_SUB_VALIDATORS = {
	boolean: ['true'] as const,
	number: ['equal to', 'greater than', 'less than'] as const,
	oddEven: ['even', 'odd'] as const,
	range: ['between', 'outside'] as const,
	text: ['equal to', 'including', 'starting with', 'ending with'] as const, // IDEA regex
} as const;

export type CompareValidator = keyof typeof COMPARE_SUB_VALIDATORS;
export type CompareSubValidator = (typeof COMPARE_SUB_VALIDATORS)[CompareValidator][number];
