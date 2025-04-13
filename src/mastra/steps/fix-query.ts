import { Step } from "@mastra/core";
import { z } from "zod";
import { fixQueryInputSchema, queryOutput } from ".";
import { generateMermaidDiagram } from "../../scripts/diagram-gql-schema";
import { gqlExecutionAgent } from "../agents";
import { graphqlQuery } from "../tools";

// Define the structure of the trigger data expected by the fixQuery step
const FixQueryTriggerDataSchema = z.object({
	prompt: z.string(),
	schema: z.string(),
	relevantSourceCode: z.string().optional(),
	failedQuery: z.object({
		query: z.string(),
		variables: z.string(),
		explanation: z.string().optional(),
		error: z.any(),
	}),
});

type FixQueryTriggerData = z.infer<typeof FixQueryTriggerDataSchema>;
type ParsedAgentResponse = {
	query: string;
	variables: string;
	rawResponse: string;
};
type ExecuteQueryResult = {
	success: boolean;
	data?: unknown;
	errors?: unknown;
};

/**
 * Validates the input data for the fixQuery step.
 */
function validateInputData(context: {
	triggerData: unknown;
}): FixQueryTriggerData | null {
	const result = FixQueryTriggerDataSchema.safeParse(context.triggerData);
	if (!result.success) {
		console.error("Invalid input data:", result.error);
		return null;
	}
	return result.data;
}

/**
 * Generates the prompt for the AI agent to fix the GraphQL query.
 */
function generateFixQueryPrompt(data: FixQueryTriggerData): string {
	const { prompt, schema, relevantSourceCode, failedQuery } = data;
	const { query, variables, explanation, error } = failedQuery;

	const parsedSchema = JSON.parse(schema);
	const mermaid = generateMermaidDiagram(parsedSchema);

	return `
You are an AI assistant specialized in fixing GraphQL queries that have failed to execute. Your task is to analyze the error, review the schema, and provide a corrected version of the query and variables that will successfully run against the GraphQL server.

First, let's review the context and necessary information:

<original_question>
${prompt}
</original_question>

<failed_query>
${query}
</failed_query>

<failed_variables>
${variables}
</failed_variables>

<query_explanation>
${explanation || "No explanation provided."}
</query_explanation>

<error_message>
${typeof error === "string" ? error : JSON.stringify(error)}
</error_message>

Here's an example of a successful query for reference:

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

<successful_variables>
{
  "roundId": "865",
  "chainId": 42161
}
</successful_variables>

Additional context for active GG23 rounds:
- All rounds are currently active on Arbitrum network (chainId: 42161)
- dApps and Apps round (roundId: 867)
- Web3 Infrastructure round (roundId: 865)
- Developer Tooling and Libraries round (roundId: 863)

<graphql_schema>
${mermaid}
</graphql_schema>

<relevant_source_code_comments>
${relevantSourceCode || "No relevant source code comments found."}
</relevant_source_code_comments>

Now, please follow these steps to analyze and fix the query:

1. Analyze the error message, GraphQL schema, and failed query.
2. Identify potential issues, such as:
   - Non-existent field names
   - Missing or incorrect arguments
   - Syntax errors in arguments or filters
   - Invalid nested fields
   - Problems with variable definitions or usage
   - Mismatches between query variables and provided JSON
3. Compare the failed query with the successful query example.
4. Brainstorm multiple potential fixes that would result in a different query from the original.
5. Choose the most appropriate fix that addresses the error and improves the query.
6. Implement the chosen fix in both the query and variables.
7. Ensure the new query is different from the original query.
8. Format your response as shown in the example below.

Please wrap your output as described below. Do not deviate from the format

Only return output that matches the below structure:

Example output structure:
<query>
query ExampleQuery($exampleVar: String!) {
  exampleField(input: $exampleVar) {
    subField1
    subField2
  }
}
</query>
<variables>
{
  "exampleVar": "exampleValue"
}
</variables>

Now, please proceed with your analysis and correction of the failed GraphQL query.
You are an AI assistant tasked with fixing a GraphQL query that failed to execute. Your goal is to correct the query and variables so they can successfully run against the GraphQL server.
    `;
}

/**
 * Calls the AI agent to generate the fixed query and variables.
 */
async function generateFixedQuery(prompt: string): Promise<string | null> {
	const res = await gqlExecutionAgent.generate(prompt);
	if (!res?.text) {
		console.error("AI agent failed to generate response.");
		return null;
	}
	return res.text;
}

/**
 * Parses the AI agent's response to extract the query and variables.
 */
function parseAgentResponse(
	responseText: string | null,
	originalQuery: string,
	originalVariables: string,
): ParsedAgentResponse | null {
	if (!responseText) {
		return null;
	}

	const queryPattern = /<query>([\s\S]*?)<\/query>/;
	const variablesPattern = /<variables>([\s\S]*?)<\/variables>/;

	const queryMatch = responseText.match(queryPattern);
	const variablesMatch = responseText.match(variablesPattern);

	if (!queryMatch || !variablesMatch) {
		console.error(
			"AI did not return query and variables in the expected format.",
		);
		return {
			query: "",
			variables: "",
			rawResponse: responseText,
		};
	}

	const correctedQuery = queryMatch[1] ? queryMatch[1].trim() : originalQuery;
	const correctedVariables = variablesMatch[1]
		? variablesMatch[1].trim()
		: originalVariables;

	return {
		query: correctedQuery,
		variables: correctedVariables,
		rawResponse: responseText,
	};
}

/**
 * Executes the potentially fixed GraphQL query.
 */
async function executeFixedQuery(
	query: string,
	variables: string,
): Promise<ExecuteQueryResult> {
	if (!query || !variables) {
		return { success: false, errors: "Missing query or variables" };
	}

	const gqlResponse = await graphqlQuery?.execute?.({
		context: { query, variables },
	});

	return {
		success: gqlResponse?.success ?? false,
		data: gqlResponse?.data,
		errors: gqlResponse?.errors,
	};
}

// Step to fix a failed query
export const fixQuery = new Step({
	id: "fixQuery",
	inputSchema: fixQueryInputSchema,
	outputSchema: queryOutput,
	execute: async ({ context }) => {
		const inputData = validateInputData(context);
		if (!inputData) {
			return {
				response: "",
				query: "",
				variables: "",
				explanation: "Missing required data for fixQuery step",
				success: false,
				errors: "Invalid input data",
			};
		}

		const { failedQuery } = inputData;
		const { query: originalQuery, variables: originalVariables } = failedQuery;

		const fixPrompt = generateFixQueryPrompt(inputData);
		const agentResponseText = await generateFixedQuery(fixPrompt);

		if (!agentResponseText) {
			return {
				response: "",
				query: "",
				variables: "",
				explanation: "Failed to generate fixed query from AI agent",
				success: false,
			};
		}

		const parsedResponse = parseAgentResponse(
			agentResponseText,
			originalQuery,
			originalVariables,
		);

		if (!parsedResponse || !parsedResponse.query || !parsedResponse.variables) {
			return {
				response: "AI Did not generate a fixed query in the expected format",
				query: "",
				variables: "",
				explanation: agentResponseText, // Return the raw response for debugging
				success: false,
			};
		}

		const { query: correctedQuery, variables: correctedVariables } =
			parsedResponse;

		const executionResult = await executeFixedQuery(
			correctedQuery,
			correctedVariables,
		);

		if (executionResult.success) {
			return {
				response: JSON.stringify(executionResult.data),
				query: correctedQuery,
				variables: correctedVariables,
				explanation: parsedResponse.rawResponse,
				success: true,
			};
		}
		return {
			response: "Corrected query failed to execute",
			query: correctedQuery, // Return the attempted query
			variables: correctedVariables, // Return the attempted variables
			explanation: parsedResponse.rawResponse,
			success: false,
			errors: JSON.stringify(executionResult.errors),
		};
	},
});
