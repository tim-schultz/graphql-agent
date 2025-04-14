import { Step, type WorkflowContext } from "@mastra/core";
import { z } from "zod";
import { generateMermaidDiagram } from "../../scripts/diagram-gql-schema";
import { gqlIntrospectAgent } from "../agents";
import {
	alloGithubSmartContract,
	graphqlIntrospection,
	graphqlQuery,
} from "../tools";
import { queryOutput, schemaOutput, sourceCodeOutput } from "./types";

// Step to fetch relevant source code for the query
export const sourceCode = new Step({
	id: "sourceCode",
	outputSchema: sourceCodeOutput,
	execute: async ({ context }) => {
		const prompt = context?.getStepResult<{ prompt: string }>(
			"trigger",
		)?.prompt;

		if (!prompt) {
			throw new Error("Prompt not found in sourceCode step");
		}

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

// Step to fetch GraphQL schema
export const fetchSchema = new Step({
	id: "fetchSchema",
	outputSchema: schemaOutput,
	execute: async ({ context }) => {
		const result = await graphqlIntrospection?.execute?.({ context: {} });

		if (!result?.success || !result.fullSchema) {
			throw new Error(
				`Failed to fetch GraphQL schema: ${result?.message || "Schema was empty"}`,
			);
		}

		return {
			schema: result.fullSchema,
		};
	},
});

// Define the structure for input data retrieved from the context
const GenerateQueryInputDataSchema = z.object({
	prompt: z.string(),
	schema: z.string(),
	relevantSourceCode: z.string().optional(),
});

type GenerateQueryInputData = z.infer<typeof GenerateQueryInputDataSchema>;

// Define the structure for the parsed AI agent response
type ParsedAgentResponse = {
	query: string;
	variables: string;
	explanation: string;
	rawResponse: string;
};

// Define the structure for the GraphQL execution result
type ExecuteQueryResult = {
	success: boolean;
	data?: unknown;
	message?: string;
	errors?: unknown;
};

/**
 * Retrieves and validates the necessary input data from the workflow context.
 */
function getAndValidateInputData(
	context: WorkflowContext,
): GenerateQueryInputData | null {
	const prompt = context?.getStepResult<{ prompt: string }>("trigger")?.prompt;
	const schemaResult = context.getStepResult(fetchSchema);
	const sourceCodeResult = context.getStepResult(sourceCode);

	const inputData = {
		prompt,
		schema: schemaResult?.schema,
		relevantSourceCode: sourceCodeResult?.relevantSourceCode,
	};

	const result = GenerateQueryInputDataSchema.safeParse(inputData);

	if (!result.success) {
		console.error(
			"Failed to validate input data for generateQuery:",
			result.error.flatten(),
		);
		return null;
	}
	console.log("Input data validated successfully for generateQuery.");

	return result.data;
}

/**
 * Generates the prompt for the AI agent to create a GraphQL query.
 */
function generateAgentPrompt(data: GenerateQueryInputData): string {
	const { prompt, schema, relevantSourceCode } = data;

	const parsedSchema = JSON.parse(schema);
	const mermaid = generateMermaidDiagram(parsedSchema);

	return `
You are an AI assistant tasked with generating GraphQL queries based on user questions and a provided GraphQL schema. Your goal is to create a query that can be executed against a GraphQL server to answer the user's question.

First, I will provide you with relevant context including the GraphQL schema represented as a mermaid diagram and potentially relevant source code comments:

<graphql_schema>
${mermaid}
</graphql_schema>

<relevant_source_code_comments>
${relevantSourceCode || "No relevant source code comments found."}
</relevant_source_code_comments>

Below you will find an example query that is known to be valid. It is important to craft your query with a similar syntax, including proper variable definitions:

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
   - Define all required variables with their types in the query
   - Include any required arguments for fields
   - Nest fields for related types as needed
   - Only include fields that are relevant to answering the question

4. Generate appropriate variables in JSON format that match the variable definitions in your query.

5. If the schema doesn't contain the necessary fields to fully answer the question, create a query with the most relevant available information.

6. Provide your response in the following format:
   <query>
   Your generated GraphQL query here with variable definitions
   </query>
   <variables>
   Your JSON variables here
   </variables>
   <explanation>
   A brief explanation of how this query relates to the user's question and how it can be used to obtain the desired information
   </explanation>

Here's an example of how your output should be formatted:

<example>
User question: "What are the details for the Web3 Infrastructure round?"

<query>
query getRoundDetails($roundId: String!, $chainId: Int!) {
  rounds(
    limit: 1
    where: {
      id: { _eq: $roundId }
      chainId: { _eq: $chainId }
    }
  ) {
    id
    chainId
    roundMetadata
    applicationsStartTime
    applicationsEndTime
    donationsStartTime
    donationsEndTime
  }
}
</query>
<variables>
{
  "roundId": "865",
  "chainId": 42161
}
</variables>
<explanation>
This query fetches details about the Web3 Infrastructure round (ID: 865) on the Arbitrum network (chainID: 42161). It includes key fields like application periods, donation periods, and metadata that will provide information about the round.
</explanation>
</example>

Now, please generate a GraphQL query to answer the following question:

<question>
${prompt}
</question>
    `;
}

/**
 * Calls the AI agent to generate the GraphQL query details.
 */
async function callAIAgent(prompt: string): Promise<string | null> {
	console.log("Calling AI agent to generate query...");
	const res = await gqlIntrospectAgent.generate(prompt);
	if (!res?.text) {
		console.error("AI agent failed to generate response text.");
		return null;
	}
	console.log(`AI agent returned response of length: ${res.text.length}`);
	return res.text;
}

/**
 * Parses the AI agent's response text to extract query, variables, and explanation.
 */
function parseAgentResponse(responseText: string | null): ParsedAgentResponse {
	const defaultResponse = {
		query: "",
		variables: "{}",
		explanation: "",
		rawResponse: responseText || "",
	};

	if (!responseText) {
		return defaultResponse;
	}
	console.log("Parsing AI agent response...");

	const queryPattern = /<query>([\s\S]*?)<\/query>/;
	const variablesPattern = /<variables>([\s\S]*?)<\/variables>/;
	const explanationPattern = /<explanation>([\s\S]*?)<\/explanation>/;

	const queryMatch = responseText.match(queryPattern);
	const variablesMatch = responseText.match(variablesPattern);
	const explanationMatch = responseText.match(explanationPattern);

	const result = {
		query: queryMatch?.[1]?.trim() ?? defaultResponse.query,
		variables: variablesMatch?.[1]?.trim() ?? defaultResponse.variables,
		explanation: explanationMatch?.[1]?.trim() ?? defaultResponse.explanation,
		rawResponse: responseText,
	};
	console.log(
		`Parsed agent response. Query found: ${!!result.query}, Variables found: ${!!result.variables}`,
	);
	return result;
}

/**
 * Executes the generated GraphQL query.
 */
async function executeGeneratedQuery(
	query: string,
	variables: string,
): Promise<ExecuteQueryResult> {
	if (!query) {
		console.error("Cannot execute query: Query string is empty.");
		return { success: false, message: "No query provided", errors: null };
	}
	console.log("Executing generated GraphQL query...");
	console.log(`Query: ${query}`);
	console.log(`Variables: ${variables}`);

	try {
		const gqlResponse = await graphqlQuery?.execute?.({
			context: { query, variables },
		});

		return {
			success: gqlResponse?.success ?? false,
			data: gqlResponse?.data,
			message: gqlResponse?.message,
			errors: gqlResponse?.errors,
		};
	} catch (error) {
		console.error("Exception caught during GraphQL query execution:", error);
		return {
			success: false,
			message: "Exception during query execution",
			errors: error instanceof Error ? error.message : JSON.stringify(error),
		};
	}
}

// Step to generate a GraphQL query based on a prompt and schema
export const generateQuery = new Step({
	id: "generateQuery",
	outputSchema: queryOutput,
	execute: async ({ context }) => {
		console.log("Executing generateQuery step...");
		console.log("Executing generateQuery step...");
		const defaultResult = {
			query: "",
			variables: "{}",
			explanation: "",
			response: "",
			success: false,
			errors: "Failed to generate query",
		};

		const inputData = getAndValidateInputData(context);
		if (!inputData) {
			console.error(
				"generateQuery step failed: Invalid or missing input data.",
			);
			return { ...defaultResult, errors: "Invalid or missing input data" };
		}
		console.log("Successfully retrieved and validated input data.");

		const agentPrompt = generateAgentPrompt(inputData);
		console.log("Generated agent prompt.");
		const agentResponseText = await callAIAgent(agentPrompt);

		if (!agentResponseText) {
			console.error("generateQuery step failed: AI agent did not return text.");
			return {
				...defaultResult,
				explanation: "AI agent failed to generate a response",
				errors: "AI agent failed to generate a response",
			};
		}

		const parsedResponse = parseAgentResponse(agentResponseText);

		if (!parsedResponse.query) {
			console.error(
				"generateQuery step failed: Could not parse query from agent response.",
			);
			return {
				...defaultResult,
				explanation: parsedResponse.rawResponse, // Return raw response if parsing failed
				errors: "AI agent did not return a query in the expected format",
			};
		}

		const executionResult = await executeGeneratedQuery(
			parsedResponse.query,
			parsedResponse.variables,
		);

		console.log("GraphQL execution completed.");
		if (executionResult.errors) {
			console.error(
				"GraphQL execution returned errors:",
				executionResult.errors,
			);
		}

		if (executionResult.success) {
			console.log("generateQuery step succeeded.");
			return {
				query: parsedResponse.query,
				variables: parsedResponse.variables,
				explanation: parsedResponse.explanation,
				response: JSON.stringify(executionResult.data),
				success: true,
				errors: "",
			};
		}
		// If execution failed, return the generated query but indicate failure
		console.warn("generateQuery step finished, but query execution failed.");
		return {
			query: parsedResponse.query,
			variables: parsedResponse.variables,
			explanation: parsedResponse.explanation,
			response: JSON.stringify(executionResult.message), // Include potential message
			success: false,
			errors: JSON.stringify(executionResult.errors),
		};
	},
});
