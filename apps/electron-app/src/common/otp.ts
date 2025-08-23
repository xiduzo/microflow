/**
 * Generates a unique OTP code for collaboration sessions
 * Format: 6-digit numeric code (000000-999999)
 */
export function generateOTP(): string {
	// Generate a random 6-digit number
	const otp = Math.floor(100000 + Math.random() * 900000);
	return otp.toString();
}

/**
 * Validates if a string is a valid OTP code
 * @param code - The code to validate
 * @returns true if the code is a valid 6-digit number
 */
export function isValidOTP(code: string): boolean {
	return /^\d{6}$/.test(code);
}

/**
 * Formats an OTP code for display (adds spaces for readability)
 * @param code - The OTP code to format
 * @returns Formatted code with spaces (e.g., "123 456")
 */
export function formatOTP(code: string): string {
	if (!isValidOTP(code)) return code;
	return code.replace(/(\d{3})(\d{3})/, '$1 $2');
}
