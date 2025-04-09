import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { generateMermaidDiagram } from "../../scripts/diagram-gql-schema";
import {
	gqlIntrospectAgent,
	gqlExecutionAgent,
	analysisAgent,
} from "../agents";
import {
	alloGithubSmartContract,
	graphqlIntrospection,
	graphqlQuery,
} from "../tools";

// Define the Status enum for consistent status values
const StatusEnum = z.enum(["success", "failure"]);
type Status = z.infer<typeof StatusEnum>;

const graphqlExecution = new Workflow({
	name: "graphql-workflow",
	triggerSchema: z.object({
		prompt: z.string(),
	}),
});

const fetchSchema = new Step({
	id: "fetchSchema",
	outputSchema: z.object({
		schema: z.string(),
	}),
	execute: async ({ context }) => {
		// Use the introspection tool to fetch the schema
		const result = await graphqlIntrospection?.execute?.({ context: {} });

		if (!result?.success || !result.fullSchema) {
			// Added check for fullSchema existence
			throw new Error(
				`Failed to fetch GraphQL schema: ${result?.message || "Schema was empty"}`,
			);
		}

		return {
			schema: result.fullSchema,
		};
	},
});

// const documentation = new Step({
//  id: "documentation",
//  outputSchema: z.object({
//      prompt: z.string(), // Assuming trigger provides prompt
//  }),
//  outputSchema: z.object({
// 		relevantDocumentation: z.string(),
//  }),
//  execute: async ({ context }) => {
//      const triggerData = context?.getStepResult<{ prompt: string }>("trigger");
//      const prompt = triggerData?.prompt;
//      if (!prompt) {
//          throw new Error("Prompt not found from trigger step");
//      }
//      console.log({ prompt });

// 		// Search for relevant documentation
// 		console.log("Searching Gitcoin docs for context");
// 		// Wrap query in context object
// 		const relevantDocumentation = await dynamicGitcoinDocs?.execute?.({
// 			context: { query: prompt },
// 		});

// 		if (!relevantDocumentation) {
// 			return {
// 				relevantDocumentation: "No relevant documentation found.",
// 			};
// 		}

// 		return {
// 			relevantDocumentation: relevantDocumentation.context,
// 		};
// 	},
// });

const sourceCode = new Step({
	id: "sourceCode",
	outputSchema: z.object({
		relevantSourceCode: z.string(),
	}),
	execute: async ({ context }) => {
		const triggerData = context?.getStepResult<{ prompt: string }>("trigger");
		const prompt = triggerData?.prompt;
		if (!prompt) {
			throw new Error("Prompt not found from trigger step in sourceCode");
		}

		// Wrap query in context object
		const eventDocuments = await alloGithubSmartContract?.execute?.({
			context: {
				query: `Events with @param or @notice similar to: ${prompt}`,
			},
		});

		const structDocuments = await alloGithubSmartContract?.execute?.({
			context: {
				query: `Structs with @param or @notice similar to: ${prompt}`,
			},
		});

		const functionDocuments = await alloGithubSmartContract?.execute?.({
			context: {
				query: `Functions with @param or @notice similar to: ${prompt}`,
			},
		});

		const relevantSourceCode = [
			eventDocuments?.context,
			structDocuments?.context,
			functionDocuments?.context,
		]
			.filter(
				(context) =>
					!context?.includes("No relevant context found in the vector databas"),
			)
			.join("\n");

		return {
			relevantSourceCode,
		};
	},
});

const generateQuery = new Step({
	id: "generateQuery",
	outputSchema: z.object({
		query: z.string(),
		explanation: z.string(),
	}),
	execute: async ({ context }) => {
		console.log("Executing generateQuery step...");
		try {
			// Retrieve data from previous steps using context
			const triggerData = context?.getStepResult<{ prompt: string }>("trigger");
			const schemaData = context?.getStepResult<{ schema: string }>(
				"fetchSchema",
			);
			const sourceCodeData = context?.getStepResult<{
				relevantSourceCode: string;
			}>("sourceCode");

			const prompt = triggerData?.prompt;
			const schema = schemaData?.schema;
			const relevantSourceCode = sourceCodeData?.relevantSourceCode;

			if (!prompt || !schema || relevantSourceCode === undefined) {
				// Check relevantSourceCode for undefined specifically, as it can be an empty string
				throw new Error(
					`Missing required data for generateQuery: prompt=${!!prompt}, schema=${!!schema}, relevantSourceCode=${relevantSourceCode !== undefined}`,
				);
			}

			const parsedSchema = JSON.parse(schema);
			const mermaid = generateMermaidDiagram(parsedSchema);

			const queryPrompt = `
You are an AI assistant tasked with generating GraphQL queries based on user questions and a provided GraphQL schema. Your goal is to create a query that can be executed against a GraphQL server to answer the user's question.

First, I will provide you with relevant context including the GraphQL schema represented as a mermaid diagram and potentially relevant source code comments:

<graphql_schema>
${mermaid}
</graphql_schema>

<relevant_source_code_comments>
${relevantSourceCode || "No relevant source code comments found."}
</relevant_source_code_comments>

Below you will find an example query that is known to be valid. It is important to craft your query with a similar syntax
<successful_query>
query getRoundForExplorer($roundId: String!, $chainId: Int!) {
    rounds(
      limit: 1
      where: {
        id: { _eq: $roundId }
        chainId: { _eq: $chainId }
        roundMetadata: { _isNull: false }
      }
    ) {
      id
      chainId
      uniqueDonorsCount
      applicationsStartTime
      applicationsEndTime
      donationsStartTime
      donationsEndTime
      matchTokenAddress
      roundMetadata
      roundMetadataCid
      applicationMetadata
      applicationMetadataCid
      strategyId
      projectId
      strategyAddress
      strategyName
      readyForPayoutTransaction
      applications(where: { status: { _eq: APPROVED } }) {
        id
        projectId
        status
        metadata
        anchorAddress
        project {
          id
          anchorAddress
        }
      }
    }
  }
</successful_query>

Here is further context for the active GG23 rounds:
	- All rounds are currently active on Arbitrum network which has a chainId of 42161.
	- The dApps and Apps round has a roundId of 867
	- The Web3 Infrastructure round has a roundId of 865
	- The Developer Tooling and Libraries has a roundId of 863


Now, follow these steps to generate an appropriate GraphQL query:

1. Analyze the user's question to identify the key information they are seeking.

2. Search the provided GraphQL schema for relevant types, fields, and relationships that correspond to the information in the question. Use the source code comments for additional context if needed.

3. Construct a GraphQL query that includes the necessary fields to answer the user's question. Make sure to:
   - Use the appropriate root query type (usually "query" or "Query")
   - Include any required arguments for fields
   - Nest fields for related types as needed
   - Only include fields that are relevant to answering the question

4. If the schema doesn't contain the necessary fields to fully answer the question, create a query with the most relevant available information.

5. Provide your response in the following format:
   <query>
   Your generated GraphQL query here
   </query>
   <explanation>
   A brief explanation of how this query relates to the user's question and how it can be used to obtain the desired information
   </explanation>

Here's an example of how your output should be formatted:

<example>
User question: "What are the titles of the top 5 rated movies?"

<query>
query {
  movies(orderBy: RATING_DESC, first: 5) {
    title
    rating
  }
}
</query>
<explanation>
This query fetches the top 5 movies ordered by their rating in descending order. It returns the title and rating of each movie, which directly answers the user's question about the titles of the top-rated movies.
</explanation>
</example>

Now, please generate a GraphQL query to answer the following question:

<question>
${prompt}
</question>
		`;

			const res = await gqlIntrospectAgent.generate(queryPrompt);

			if (!res || !res.text) {
				return {
					query: "query { example }", // Placeholder - Extract from res.text
					explanation: "", // Placeholder
				};
			}

			const result = {
				query: "",
				explanation: "",
			};

			// Define regex patterns to extract content between tags
			const queryPattern = /<query>([\s\S]*?)<\/query>/;
			const explanationPattern = /<explanation>([\s\S]*?)<\/explanation>/;

			// Extract query
			const queryMatch = res.text.match(queryPattern);
			// biome-ignore lint/complexity/useOptionalChain: <explanation>
			if (queryMatch && queryMatch[1]) {
				result.query = queryMatch[1].trim();
			}

			// Extract explanation
			const explanationMatch = res.text.match(explanationPattern);
			if (explanationMatch?.[1]) {
				result.explanation = explanationMatch[1].trim();
			}

			return result;
		} catch (error) {
			console.error("Error in generateQuery step:", error);
			throw new Error(`Failed to generate query: ${error}`);
		}
	},
});

// Define the success response schema with StatusEnum
const successResponseSchema = z.object({
	status: StatusEnum,
	result: z.string(),
});

// Define the error response schema with StatusEnum
const errorResponseSchema = z.object({
	status: StatusEnum,
	error: z.union([z.array(z.unknown()), z.string()]),
});

// Combine into a union type for the full result
const resultSchema = z.union([successResponseSchema, errorResponseSchema]);

const executeQuery = new Step({
	id: "executeQuery",
	outputSchema: resultSchema,
	execute: async ({ context }) => {
		try {
			if (!context) {
				throw new Error("Context is not available in executeQuery step");
			}
			// Retrieve data from previous steps using context
			const { query, explanation } = context.getStepResult<{
				query: string;
				explanation: string;
			}>("generateQuery");
			const correctedQuery = context.getStepResult<{
				correctedQuery?: string;
			}>("fixQuery")?.correctedQuery;

			if (correctedQuery) {
				console.log("Using corrected query:", correctedQuery);
			} else {
				console.log("Using original query:", query);
			}

			const result = await graphqlQuery?.execute?.({
				context: {
					query: correctedQuery || query,
				},
			});

			if (result?.success) {
				return {
					status: "success" as const,
					result: JSON.stringify(result.data),
				};
			}
			return {
				status: "failure" as const,
				error: result?.errors || "Query execution failed",
			};
		} catch (error) {
			return {
				status: "failure" as const,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
});

const fixQuery = new Step({
	id: "fixQuery",
	outputSchema: z.object({
		correctedQuery: z.string(),
	}),
	execute: async ({ context }) => {
		try {
			// Retrieve data from previous steps
			const triggerData = context?.getStepResult<{ prompt: string }>("trigger");
			const schemaData = context?.getStepResult<{ schema: string }>(
				"fetchSchema",
			);
			const sourceCodeData = context?.getStepResult<{
				relevantSourceCode: string;
			}>("sourceCode");
			const queryData = context?.getStepResult<{
				query: string;
				explanation: string;
			}>("generateQuery");
			const executeData = context?.getStepResult<{
				status: Status;
				error: unknown;
				result?: string;
			}>("executeQuery");

			const prompt = triggerData?.prompt;
			const schema = schemaData?.schema;
			const relevantSourceCode = sourceCodeData?.relevantSourceCode;
			const originalQuery = queryData?.query;
			const originalExplanation = queryData?.explanation;
			const error = executeData?.error;

			console.log({ error });

			if (
				!prompt ||
				!schema ||
				!originalQuery ||
				relevantSourceCode === undefined ||
				!error
			) {
				throw new Error(
					`Missing required data for fixQuery: prompt=${!!prompt}, schema=${!!schema}, relevantSourceCode=${relevantSourceCode !== undefined}, originalQuery=${!!originalQuery}, error=${!!error}`,
				);
			}

			const parsedSchema = JSON.parse(schema);
			const mermaid = generateMermaidDiagram(parsedSchema);

			// Create a prompt to fix the failed query
			const fixQueryPrompt = `
You are an AI assistant tasked with fixing a GraphQL query that failed to execute. Your goal is to correct the query so it can successfully run against the GraphQL server.

First, I will provide you with the context including the GraphQL schema, the original user question, the failed query, and the error message:

<graphql_schema>
${mermaid}
</graphql_schema>

<relevant_source_code_comments>
${relevantSourceCode || "No relevant source code comments found."}
</relevant_source_code_comments>

<original_question>
${prompt}
</original_question>

<failed_query>
${originalQuery}
</failed_query>

<query_explanation>
${originalExplanation}
</query_explanation>

<error_message>
${typeof error === "string" ? error : JSON.stringify(error)}
</error_message>

Below you will find an example query that is known to be valid. It is important to craft your fixed query with a similar syntax:
<successful_query>
query getRoundForExplorer($roundId: String!, $chainId: Int!) {
	rounds(
		limit: 1
		where: {
		id: { _eq: $roundId }
		chainId: { _eq: $chainId }
		roundMetadata: { _isNull: false }
		}
	) {
		id
		chainId
		uniqueDonorsCount
		applicationsStartTime
		applicationsEndTime
		donationsStartTime
		donationsEndTime
		matchTokenAddress
		roundMetadata
		roundMetadataCid
		applicationMetadata
		applicationMetadataCid
		strategyId
		projectId
		strategyAddress
		strategyName
		readyForPayoutTransaction
		applications(where: { status: { _eq: APPROVED } }) {
		id
		projectId
		status
		metadata
		anchorAddress
		project {
			id
			anchorAddress
		}
		}
	}
	}
</successful_query>

Here is further context for the active GG23 rounds:
	- All rounds are currently active on Arbitrum network which has a chainId of 42161.
	- The dApps and Apps round has a roundId of 867
	- The Web3 Infrastructure round has a roundId of 865
	- The Developer Tooling and Libraries has a roundId of 863

Now, please analyze the error and fix the query. Common issues include:
1. Using field names that don't exist in the schema
2. Missing required arguments
3. Incorrect syntax for arguments or filters
4. Including nested fields that don't exist on the parent type
5. Issues with variable definitions and usage

Provide your corrected query in the following format:
<query>
Your corrected GraphQL query here
</query>
<explanation>
A brief explanation of what was wrong with the original query and how you fixed it
</explanation>
			`;

			// Use the GQL agent to fix the query
			const res = await gqlExecutionAgent.generate(fixQueryPrompt);

			if (!res || !res.text) {
				return {
					correctedQuery: originalQuery, // Return original if no fix is available
					explanation: "Failed to generate a fixed query.",
					status: "failure" as const,
					error: "No response from query fixing agent",
				};
			}

			// Extract the corrected query and explanation
			const result = {
				correctedQuery: "",
				explanation: "",
				status: "failure" as const,
				error: "Query fixing process incomplete",
			};

			// Define regex patterns to extract content between tags
			const queryPattern = /<query>([\s\S]*?)<\/query>/;
			const explanationPattern = /<explanation>([\s\S]*?)<\/explanation>/;

			// Extract query
			const queryMatch = res.text.match(queryPattern);
			if (queryMatch?.[1]) {
				const correctedQuery = queryMatch[1].trim();
				console.log({ correctedQuery });
				return {
					correctedQuery,
				};
			}
			throw new Error("Failed to extract corrected query from response");
		} catch (error) {
			console.error("Error in fixQuery step:", error);
			return {
				correctedQuery: "",
				explanation: `Failed to fix query: ${error instanceof Error ? error.message : String(error)}`,
				status: "failure" as const,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
});

const analyzeQuery = new Step({
	id: "analyzeQuery",
	outputSchema: z.object({
		analysis: z.string(),
		relevance: z.number(),
	}),
	execute: async ({ context }) => {
		try {
			// Retrieve data from previous steps
			const triggerData = context?.getStepResult<{ prompt: string }>("trigger");
			const queryData = context?.getStepResult<{
				query: string;
				explanation: string;
			}>("generateQuery");

			// Get the result - from either executeQuery or fixQuery depending on which was successful
			let resultData: unknown;
			let queryResult: unknown;
			// Check if we have a successful result from executeQuery
			const executeData = context?.getStepResult<{
				status: Status;
				result?: string;
			}>("executeQuery");
			if (executeData?.status === "success" && executeData?.result) {
				resultData = executeData;
				queryResult = JSON.parse(executeData.result);
			} else {
				// If not, check if we have a successful result from fixQuery
				const fixData = context?.getStepResult<{
					status: Status;
					result?: string;
				}>("fixQuery");
				if (fixData?.status === "success" && fixData?.result) {
					resultData = fixData;
					queryResult = JSON.parse(fixData.result);
				}
			}

			const prompt = triggerData?.prompt;
			const query = queryData?.query;
			const explanation = queryData?.explanation;

			if (!prompt || !query || !resultData || !queryResult) {
				throw new Error(
					`Missing required data for analyzeQuery: prompt=${!!prompt}, query=${!!query}, resultData=${!!resultData}, queryResult=${!!queryResult}`,
				);
			}

			// Create a prompt for the agent to analyze the query result
			const analysisPrompt = `
You are an expert GraphQL analyst who can interpret query results and provide clear insights.
You'll be given a user's original question, the GraphQL query that was executed, and the query results.
Your job is to analyze the data and provide meaningful insights that directly answer the user's original question.

User's original question:
"${prompt}"

The GraphQL query that was executed:
\`\`\`graphql
${query}
\`\`\`

Query explanation:
${explanation || "No explanation provided."}

Query results:
\`\`\`json
${JSON.stringify(queryResult, null, 2)}
\`\`\`

Please provide a comprehensive analysis of these results that:
1. Clearly explains what the data shows in relation to the original question
2. Highlights key insights extracted from the data
3. Notes any patterns, trends, or notable observations
4. Mentions any limitations in the data that prevent fully answering the original question
5. Offers possible next steps or further queries that might be helpful

Important: Provide your analysis as a well-structured natural text response without using XML tags.
When providing the analysis, be specific and reference actual values from the data when relevant.

At the end of your analysis, on a separate line, please include a relevance score from 0-10 indicating 
how well these results answer the original question, where 0 means "not at all relevant" and 10 means 
"completely answers the question". Format this as "Relevance score: X/10".
			`;

			// Use the GQL agent to analyze the result
			const res = await analysisAgent.generate(analysisPrompt);

			if (!res || !res.text) {
				return {
					analysis: "Failed to analyze the query results.",
					relevance: 0,
				};
			}

			// Extract the relevance score if present, otherwise default to 5
			let relevanceScore = 5;
			const relevanceMatch = res.text.match(/Relevance score:\s*(\d+)\/10/i);
			if (relevanceMatch?.[1]) {
				relevanceScore = Number.parseInt(relevanceMatch[1], 10);
				// Ensure score is within 0-10 range
				relevanceScore = Math.min(10, Math.max(0, relevanceScore));
			}

			return {
				analysis: res.text,
				relevance: relevanceScore,
			};
		} catch (error) {
			console.error("Error in analyzeQuery step:", error);
			return {
				analysis: `Failed to analyze query results: ${error instanceof Error ? error.message : String(error)}`,
				relevance: 0,
			};
		}
	},
});

const debugStep = new Step({
	id: "debugStep",
	execute: async ({ context }) => {
		const executeData = context?.getStepResult("executeQuery");
		console.log(
			"DEBUG - executeQuery result:",
			JSON.stringify(executeData, null, 2),
		);

		const fixData = context?.getStepResult("fixQuery");
		console.log("DEBUG - fixQuery result:", JSON.stringify(fixData, null, 2));

		return { debugCompleted: true };
	},
});

graphqlExecution
	// Initial steps
	.step(fetchSchema)
	.then(sourceCode)
	.then(generateQuery)
	.then(executeQuery)

	// Success path
	.then(analyzeQuery, {
		when: { "executeQuery.status": "success" },
	})

	// Failure path - first attempt
	.after(executeQuery)
	.step(fixQuery, {
		when: { "executeQuery.status": "failure" },
	})
	.then(analyzeQuery, {
		when: { "executeQuery.status": "success" },
	})
	.after(executeQuery)
	.step(fixQuery, {
		when: { "executeQuery.status": "failure" },
	})
	.then(executeQuery);

//   .step(executeQuery);

graphqlExecution.commit();

export { graphqlExecution };
