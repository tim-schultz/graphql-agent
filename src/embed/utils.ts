export const logger = {
	debug: (message: string) => console.debug(message),
	info: (message: string) => console.info(message),
	warn: (message: string) => console.warn(message),
	error: (message: string) => console.error(message),
};

/**
 * Create a timeout that can be used in async functions
 */
export function timeout(ms: number): Promise<never> {
	return new Promise((_, reject) =>
		setTimeout(
			() => reject(new Error(`Operation timed out after ${ms} milliseconds`)),
			ms,
		),
	);
}

/**
 * Merge a promise with a timeout
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	errorMessage?: string,
): Promise<T> {
	return Promise.race([
		promise,
		timeout(ms).catch(() => {
			throw new Error(
				errorMessage || `Operation timed out after ${ms} milliseconds`,
			);
		}),
	]);
}
