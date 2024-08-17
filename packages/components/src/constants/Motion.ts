export const MOTION_CONTROLLERS = [
	'HCSR501',
	'GP2Y0D810Z0F',
	'GP2Y0D815Z0F',
] as const;
export type Controller = (typeof MOTION_CONTROLLERS)[number];
