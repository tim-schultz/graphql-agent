import { createTool } from "@mastra/core/tools";
import { type DefinitionNode, parse } from "graphql";
import { z } from "zod";
import { embedSingleString } from "../../embed/content-processor";

/**
 * Configuration options for the GraphQL query tool
 */
interface GraphQLQueryToolOptions {
	allowMutations?: boolean;
	maxTokens?: number;
	tokenBuffer?: number;
	truncationSuffix?: string;
	defaultHeaders?: Record<string, string>;
	successfulQueriesIndexName?: string;
	pgConnectionString?: string;
}

/**
 * Helper function to parse and merge headers
 */
function parseAndMergeHeaders(
	defaultHeaders: Record<string, string> = {},
	additionalHeaders: Record<string, string> | string = {},
): Record<string, string> {
	let parsedAdditionalHeaders: Record<string, string> = {};

	if (typeof additionalHeaders === "string") {
		try {
			parsedAdditionalHeaders = JSON.parse(additionalHeaders);
		} catch (e) {
			console.warn("Failed to parse headers as JSON, using empty object");
		}
	} else {
		parsedAdditionalHeaders = additionalHeaders;
	}

	return { ...defaultHeaders, ...parsedAdditionalHeaders };
}

/**
 * Helper function to process and sanitize GraphQL responses
 */
function processGraphQLResponse(
	result: {
		success: boolean;
		data?: unknown; // Changed from any
		errors: unknown[] | null; // Changed from any[]
		message: string;
	},
	options: {
		maxTokens: number;
		truncationSuffix: string;
	},
) {
	let responseData = result.data;
	if (!responseData) {
		return {
			success: result.success,
			data: responseData,
			errors: result.errors,
			message: result.message,
		};
	}

	// Simple approach to estimate size - in a real implementation, use a token counter
	const jsonString = JSON.stringify(responseData);
	if (jsonString && jsonString.split(" ").length > options.maxTokens) {
		// Rough char-to-token ratio
		// Truncate data
		const truncatedTokens = jsonString.split(" ").slice(0, options.maxTokens);
		responseData = truncatedTokens.join(" ") + options.truncationSuffix;
	}

	return {
		success: result.success,
		data: responseData,
		errors: result.errors,
	};
}

const outputSchema = z.object({
	success: z.boolean(),
	data: z.unknown().optional(), // Changed from any()
	errors: z.array(z.unknown()).nullable().optional(), // Changed from any()
	message: z.string().optional(),
});

/**
 * Creates a GraphQL query tool for Mastra
 *
 * @param endpoint GraphQL endpoint URL
 * @param options Tool configuration options
 * @returns Mastra-compatible query tool
 */
export const createGraphQLQueryTool = (
	endpoint: string,
	options: GraphQLQueryToolOptions = {},
) => {
	const {
		allowMutations = false,
		maxTokens = 25000,
		truncationSuffix = "... [content truncated due to size limits]",
		defaultHeaders = {},
		successfulQueriesIndexName,
		pgConnectionString,
	} = options;

	// Sanitization options
	const sanitizeOptions = {
		maxTokens,
		truncationSuffix,
	};

	return createTool({
		id: "GraphQL Query",
		inputSchema: z.object({
			query: z.string().describe("The GraphQL query to execute"),
			variables: z
				.string()
				.optional()
				.describe("JSON string of variables for the query"),
			maxTokens: z
				.number()
				.optional()
				.describe("Maximum token count before truncation"),
		}),
		description: "Execute a GraphQL query against an endpoint",
		outputSchema,
		execute: async ({ context }) => {
			console.log("[GraphQL Query Tool] Execution started.");

			const { query, variables, maxTokens: overrideMaxTokens } = context;

			// Allow overriding maxTokens per query
			const queryOptions = {
				...sanitizeOptions,
				...(overrideMaxTokens !== undefined
					? { maxTokens: overrideMaxTokens }
					: {}),
			};

			try {
				// Parse and validate the query
				const parsedQuery = parse(query);

				// Check if the query is a mutation
				const isMutation = parsedQuery.definitions.some(
					(def: DefinitionNode) =>
						def.kind === "OperationDefinition" && def.operation === "mutation",
				);

				// Disallow mutations if not enabled
				if (isMutation && !allowMutations) {
					console.warn(
						"[GraphQL Query Tool] Mutation attempted but not allowed.",
					);

					return processGraphQLResponse(
						{
							success: false,
							data: null,
							errors: [
								"Mutations are not allowed unless enabled in configuration",
							],
							message: "Mutations are not allowed",
						},
						queryOptions,
					);
				}

				// Execute the query
				const useHeaders = parseAndMergeHeaders(defaultHeaders, {});


				const response = await fetch(endpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...useHeaders,
					},
					body: JSON.stringify({
						query,
						variables: variables ? JSON.parse(variables) : undefined,
					}),
				});

				console.log(
					`[GraphQL Query Tool] Received response with status: ${response.status}`,
				);

				if (!response.ok) {
					const errorBody = await response.text();
					console.error(
						`[GraphQL Query Tool] Request failed with status ${response.status}. Body: ${errorBody}`,
					);
					throw new Error(`GraphQL request failed: ${response.statusText}`);
				}

				const result = await response.json();

				// Check for GraphQL-level errors
				if (result.errors && result.errors.length > 0) {
					console.warn(
						"[GraphQL Query Tool] GraphQL response contains errors.",
					);

					return processGraphQLResponse(
						{
							success: false,
							data: result.data,
							errors: result.errors,
							message: "GraphQL query executed but returned errors",
						},
						queryOptions,
					);
				}

				// Process and sanitize the successful response
				const sanitizedResponse = processGraphQLResponse(
					{
						success: true,
						data: result.data,
						errors: null,
						message: "GraphQL query executed successfully",
					},
					queryOptions,
				);

				console.log(
					"[GraphQL Query Tool] Successfully processed GraphQL response.",
				);

				// Optional: Store successful queries for future reference
				if (
					successfulQueriesIndexName &&
					pgConnectionString &&
					typeof embedSingleString === "function"
				) {
					try {
						console.log(
							"[GraphQL Query Tool] Attempting to embed successful query and result.",
						);
						const queryAndResult = `<query>${query}</query>\n<result>${JSON.stringify(
							result.data,
						)}</result>`;
						await embedSingleString(
							pgConnectionString,
							successfulQueriesIndexName,
							queryAndResult,
						);
						console.log("[GraphQL Query Tool] Embedding successful.");
					} catch (error) {
						console.error(
							`[GraphQL Query Tool] Error embedding the query and result: ${String(error)}`,
						);
					}
				}

				console.log("[GraphQL Query Tool] Execution finished successfully.");

				return sanitizedResponse;
			} catch (error) {
				console.error(
					`[GraphQL Query Tool] Execution failed with error: ${error instanceof Error ? error.message : String(error)}`,
					error,
				);

				return {
					success: false,
					data: null,
					errors: [error instanceof Error ? error.message : String(error)],
					message: `Failed to execute GraphQL query: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},
	});
};

/**
 * Usage example:
 *
 * import { createGraphQLQueryTool } from './graphql-query-tool';
 * import { Agent } from "@mastra/core/agent";
 * import { openai } from "@ai-sdk/openai";
 *
 * // Create the GraphQL query tool
 * const graphqlQueryTool = createGraphQLQueryTool(
 *   "https://api.example.com/graphql",
 *   {
 *     allowMutations: false,
 *     defaultHeaders: {
 *       "Authorization": `Bearer ${process.env.API_TOKEN}`
 *     },
 *     successfulQueriesIndexName: "successful_queries",
 *     pgConnectionString: process.env.POSTGRES_CONNECTION_STRING
 *   }
 * );
 *
 * // Add the tool to an agent
 * export const dataAgent = new Agent({
 *   name: 'Data Assistant',
 *   model: openai("gpt-4o-mini"),
 *   instructions: `You are a helpful assistant that can query GraphQL APIs.
 *   Use the GraphQL Query tool when the user asks for specific data.`,
 *   tools: {
 *     graphqlQueryTool
 *   },
 * });
 */
