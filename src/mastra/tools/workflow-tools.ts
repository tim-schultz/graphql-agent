import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
	fixQueryAnalysis,
	newQueryAnalysis,
} from "../workflows/graphql-execution";

type StepResult<T = unknown> = {
	status: string;
	output?: T;
};

// Helper function to safely get step output
function getStepOutput<T>(result: {
	results: Record<string, { status?: string; output?: unknown }>;
	activePaths?: Map<string, { status: string; suspendPayload?: unknown }>;
}): T {
	console.log("getStepOutput", result);
	// Get the last executed step from activePaths
	if (result.activePaths && result.activePaths.size > 0) {
		// Get the first (and only) key from the activePaths Map
		const lastStepId = Array.from(result.activePaths.keys())[0];

		// Get the result for this step
		const stepResult = result.results[lastStepId];
		console.log("stepResult", stepResult);
		if (stepResult?.status === "success" && stepResult.output) {
			return stepResult.output as T;
		}
	}

	throw new Error("unable to get step output");
}

// Create a tool that wraps the newQueryAnalysis workflow
export const newQueryAnalysisTool = createTool({
	id: "newQueryAnalysis",
	description:
		"Analyzes a new GraphQL query using the schema and source code context",
	inputSchema: z.object({
		prompt: z.string().describe("The prompt to generate a GraphQL query from"),
	}),
	outputSchema: z.object({
		query: z.string().optional(),
		variables: z.string().optional(),
		explanation: z.string().optional(),
		success: z.boolean().optional(),
		errors: z.string().optional(),
	}),
	execute: async ({ context }) => {
		// Create a workflow run
		const run = newQueryAnalysis.createRun();

		// Start the workflow with the input data
		const result = await run.start({
			triggerData: {
				prompt: context.prompt,
			},
		});

		// Get step outputs safely
		const generateQueryOutput = getStepOutput<{
			query?: string;
			variables?: string;
			explanation?: string;
			success?: boolean;
			errors?: string;
		}>(result);

		console.log("fixQueryOutput", generateQueryOutput, result);

		// Return only the generateQuery results
		return {
			query: generateQueryOutput?.query,
			variables: generateQueryOutput?.variables,
			explanation: generateQueryOutput?.explanation,
			success: generateQueryOutput?.success,
			errors: generateQueryOutput?.errors,
		};
	},
});

// Create a tool that wraps the fixQueryAnalysis workflow
export const fixQueryAnalysisTool = createTool({
	id: "fixQueryAnalysis",
	description: "Fix, execute, and analyze a prblematic GraphQL query",
	inputSchema: z.object({
		prompt: z.string().describe("The original prompt that generated the query"),
		query: z.string().describe("The GraphQL query to fix"),
		variables: z.string().describe("The variables for the query"),
		explanation: z.string().describe("The explanation of the original query"),
		error: z.string().describe("The errors from the previous query attempt"),
	}),
	outputSchema: z.object({
		query: z.string().optional(),
		variables: z.string().optional(),
		explanation: z.string().optional(),
		success: z.boolean().optional(),
		errors: z.string().optional(),
	}),
	execute: async ({ context }) => {
		// Create a workflow run
		const run = fixQueryAnalysis.createRun();

		// Start the workflow with the input data
		const result = await run.start({
			triggerData: {
				prompt: context.prompt,
				failedQuery: {
					query: context.query,
					variables: context.variables,
					explanation: context.explanation,
					error: context.error,
				},
			},
		});

		// Get step outputs safely
		const fixQueryOutput = getStepOutput<{
			query?: string;
			variables?: string;
			explanation?: string;
			success?: boolean;
			errors?: string;
		}>(result);
		console.log("fixQueryOutput", fixQueryOutput, result);

		// Return only the fixQuery results
		return {
			query: fixQueryOutput?.query,
			variables: fixQueryOutput?.variables,
			explanation: fixQueryOutput?.explanation,
			success: fixQueryOutput?.success,
			errors: fixQueryOutput?.errors,
		};
	},
});
