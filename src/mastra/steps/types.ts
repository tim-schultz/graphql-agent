import { z } from "zod";

// Define schemas for data passing between steps
export const schemaOutput = z.object({
	schema: z.string(),
});

export const sourceCodeOutput = z.object({
	relevantSourceCode: z.string(),
});

export const queryOutput = z.object({
	success: z.boolean(),
	query: z.string(),
	variables: z.string(),
	explanation: z.string(),
	response: z.string(),
	errors: z.string().optional(),
});

export const analysisData = z.object({
	analysis: z.string(),
	relevance: z.number(),
	success: z.boolean(),
});

export const generateInputSchema = z.object({
	prompt: z.string(),
	schema: z.string(),
	relevantSourceCode: z.string(),
});

export const fixQueryInputSchema = z.object({
	prompt: z.string(),
	failedQuery: z.object({
		query: z.string(),
		variables: z.string(),
		explanation: z.string(),
		error: z.string(),
	}),
});
