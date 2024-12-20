export function transformValueToBoolean(value: unknown) {
	if (typeof value === 'boolean') return value;

	if (typeof value === 'number') return value > 0;

	const isTruthy = ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase());
	const isSecretlyPositiveNumber = !Number.isNaN(Number(value)) && Number(value) > 0;

	return isTruthy || isSecretlyPositiveNumber;
}
