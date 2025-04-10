import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { generateMermaidDiagram } from "../../scripts/diagram-gql-schema";
import {
	analysisAgent,
	gqlExecutionAgent,
	gqlIntrospectAgent,
} from "../agents";
import {
	alloGithubSmartContract,
	graphqlIntrospection,
	graphqlQuery,
} from "../tools";

const StatusEnum = z.enum(["success", "failure"]);
type Status = z.infer<typeof StatusEnum>;

const fetchSchema = new Step({
	id: "fetchSchema",
	outputSchema: z.object({
		schema: z.string(),
	}),
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

const queryResponse = z.object({
	status: z.boolean(), // Changed from z.enum(["success", "failure"])
	query: z.string(),
	variables: z.string(),
	explanation: z.string(),
	response: z.string(),
});

const generateQuery = new Step({
	id: "generateQuery",
	outputSchema: queryResponse,
	execute: async ({ context }) => {
		console.log("Executing generateQuery step...");
		const triggerData = context?.getStepResult<{ prompt: string }>("trigger");
		const schemaData = context?.getStepResult(fetchSchema);
		const sourceCodeData = context?.getStepResult(sourceCode);

		const prompt = triggerData?.prompt;
		const schema = schemaData?.schema;
		const relevantSourceCode = sourceCodeData?.relevantSourceCode;

		const result = {
			query: "",
			variables: "{}",
			explanation: "",
			response: "",
			status: false, // Initial status is failure
		};

		if (!prompt || !schema || relevantSourceCode === undefined) {
			return result;
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

		const res = await gqlIntrospectAgent.generate(queryPrompt);

		if (!res || !res.text) {
			return result;
		}

		const queryPattern = /<query>([\s\S]*?)<\/query>/;
		const variablesPattern = /<variables>([\s\S]*?)<\/variables>/;
		const explanationPattern = /<explanation>([\s\S]*?)<\/explanation>/;

		const queryMatch = res.text.match(queryPattern);
		if (queryMatch?.[1]) {
			result.query = queryMatch[1].trim();
		}

		const variablesMatch = res.text.match(variablesPattern);
		if (variablesMatch?.[1]) {
			result.variables = variablesMatch[1].trim();
		}

		const explanationMatch = res.text.match(explanationPattern);
		if (explanationMatch?.[1]) {
			result.explanation = explanationMatch[1].trim();
		}

		const gqlResponse = await graphqlQuery?.execute?.({
			context: {
				query: result.query,
				variables: result.variables,
			},
		});

		if (gqlResponse?.success) {
			result.response = JSON.stringify(gqlResponse.data);
			result.status = true; // Status is success
		}

		return result;
	},
});

const executeResponseSchema = z.object({
	status: StatusEnum,
	result: z.string().optional(),
	error: z.union([z.array(z.unknown()), z.string()]).optional(),
});

const fixQuery = new Step({
	id: "fixQuery",
	inputSchema: executeResponseSchema,
	outputSchema: queryResponse,
	execute: async ({ context }) => {
		const triggerData = context?.getStepResult<{ prompt: string }>("trigger");
		const schemaData = context?.getStepResult(fetchSchema);
		const sourceCodeData = context?.getStepResult(sourceCode);
		const queryData = context?.getStepResult(generateQuery);
		const executeResponse = context?.inputData;

		const prompt = triggerData?.prompt;
		const schema = schemaData?.schema;
		const relevantSourceCode = sourceCodeData?.relevantSourceCode;
		const originalQuery = queryData?.query;
		const originalVariables = queryData?.variables;
		const originalExplanation = queryData?.explanation;
		const error = executeResponse?.error;

		console.log({ error });

		if (
			!prompt ||
			!schema ||
			!originalQuery ||
			!originalVariables ||
			relevantSourceCode === undefined ||
			!error
		) {
			return {
				response: "",
				query: "",
				variables: "",
				explanation: "Missing required data for fixQuery step",
				status: false, // Status is failure
			};
		}

		const parsedSchema = JSON.parse(schema);
		const mermaid = generateMermaidDiagram(parsedSchema);
		const fixQueryPrompt = `
			You are an AI assistant specialized in fixing GraphQL queries that have failed to execute. Your task is to analyze the error, review the schema, and provide a corrected version of the query and variables that will successfully run against the GraphQL server.

First, let's review the context and necessary information:

<original_question>
${prompt}
</original_question>

<failed_query>
${originalQuery}
</failed_query>

<failed_variables>
${originalVariables}
</failed_variables>

<query_explanation>
${originalExplanation}
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

Please wrap your output  as described below. Do not deviate from the format

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

		const res = await gqlExecutionAgent.generate(fixQueryPrompt);

		if (!res || !res.text) {
			return {
				response: "",
				query: "",
				variables: "",
				explanation: "Failed to generate fixed query",
				status: false, // Status is failure
			};
		}

		const queryPattern = /<query>([\s\S]*?)<\/query>/;
		const variablesPattern = /<variables>([\s\S]*?)<\/variables>/;

		const queryMatch = res.text.match(queryPattern);
		const variablesMatch = res.text.match(variablesPattern);

		if (!queryMatch && !variablesMatch) {
			return {
				response: "",
				query: "",
				variables: "",
				explanation: "Failed to generate fixed query",
				status: false, // Status is failure
			};
		}

		if (queryMatch && variablesMatch) {
			const correctedQuery = queryMatch?.[1]
				? queryMatch[1].trim()
				: originalQuery;
			const correctedVariables = variablesMatch?.[1]
				? variablesMatch[1].trim()
				: originalVariables;

			const gqlResponse = await graphqlQuery?.execute?.({
				context: {
					query: correctedQuery,
					variables: correctedVariables,
				},
			});

			if (gqlResponse?.success) {
				return {
					response: JSON.stringify(gqlResponse.data),
					query: correctedQuery,
					variables: correctedVariables,
					explanation: res.text, // Keep the explanation from the agent
					status: true, // Status is success
				};
			}
		}
		return {
			response: "",
			query: "",
			variables: "",
			explanation: res.text, // Keep the explanation from the agent
			status: false, // Status is failure
		};
	},
});

const analyzeQuery = new Step({
	id: "analyzeQuery",
	inputSchema: queryResponse,
	outputSchema: z.object({
		analysis: z.string(),
		relevance: z.number(),
	}),
	execute: async ({ context }) => {
		try {
			const triggerData = context?.getStepResult<{ prompt: string }>("trigger");
			const inputData = context?.inputData;

			const { prompt } = triggerData;
			const { query, variables, explanation, response } = inputData;

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

The variables used:
\`\`\`json
${variables}
\`\`\`

Query explanation:
${explanation || "No explanation provided."}

Query results:
\`\`\`json
${JSON.stringify(response, null, 2)}
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

			const res = await analysisAgent.generate(analysisPrompt);

			if (!res || !res.text) {
				return {
					analysis: "Failed to analyze the query results.",
					relevance: 0,
				};
			}

			let relevanceScore = 5;
			const relevanceMatch = res.text.match(/Relevance score:\s*(\d+)\/10/i);
			if (relevanceMatch?.[1]) {
				relevanceScore = Number.parseInt(relevanceMatch[1], 10);
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

const graphqlExecution = new Workflow({
	name: "graphql-execution",
});

graphqlExecution
	.step(generateQuery)
	.then(analyzeQuery, {
		when: { "generateQuery.status": true }, // Note: Changed from "success" to true based on your schema
	})
	.after(generateQuery)
	.step(fixQuery, {
		when: { "generateQuery.status": false }, // Note: Changed from "failure" to false
	});

// Then define and commit the main workflow, using the execution workflow as a step
const graphqlWorkflow = new Workflow({
	name: "graphql-workflow",
	triggerSchema: z.object({
		prompt: z.string(),
	}),
});

// Add steps to the main workflow
graphqlWorkflow
	.step(fetchSchema)
	.then(sourceCode)
	.then(graphqlExecution, {
		// Pass needed variables from parent to nested workflow
		variables: {
			// Map any necessary variables here if needed
		},
	})
	.commit();

// Export both workflows
export { graphqlWorkflow, graphqlExecution };
