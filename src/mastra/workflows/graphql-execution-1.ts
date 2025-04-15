import { Step, Workflow } from "@mastra/core";
import { z } from "zod";
// Placeholder for the actual embedding function/tool - replace with your implementation
// import { embedInCollection } from "../path/to/embedding/tool";

import { gqlExecutionAgent } from "../agents";
import { analyzeQuery } from "../steps";
import { sourceCode } from "../steps/generate-query";
import { POSTGRES_URL, graphqlQuery } from "../tools";
import { createVectorQueryTool } from "../tools/get-vector-context";

// Infer the tool config type from the create function
type VectorQueryToolConfig = Parameters<typeof createVectorQueryTool>[2];

const buildContextFromSchema = new Step({
	id: "buildContextFromSchema",
	// Define the output structure for this step
	outputSchema: z.object({
		queryReference: z.string(), // Placeholder for the combined context
	}),
	execute: async ({ context }) => {
		if (!POSTGRES_URL) {
			throw new Error(
				"POSTGRES_URL is not set. Please set it to use vector query tools.",
			);
		}

		const { prompt } = context.triggerData;

		const results = await Promise.all([
			executeQueryWithVectorTool(
				POSTGRES_URL,
				"gitcoin_gql",
				{
					description: "GraphQL Enum type definitions",
					topK: 5,
					threshold: 0.3,
				},
				prompt,
			),
		]);

		return {
			queryReference: results.map((result) => result).join("\n"),
		};
	},
});

const generateQueryOutput = z.object({
	query: z.string(),
	variables: z.string(),
});

const generateQuery = new Step({
	id: "generateQuery",
	// Define the output structure for this step
	outputSchema: generateQueryOutput,
	execute: async ({ context }) => {
		const referenceResult = context.getStepResult(buildContextFromSchema);
		const sourceCodeResult = context.getStepResult(sourceCode);
		const prompt = `
Craft a query that will answer the following question:
${context.triggerData.prompt}

Use the following GraphQL Definition nodes to help answer the question:
${referenceResult.queryReference}

Also use the following source code context to help answer the question:
${sourceCodeResult.relevantSourceCode}

Here is further context for the active GG23 rounds:
- All rounds are currently active on Arbitrum network which has a chainId of 42161.
- The dApps and Apps round has a roundId of 867
- The Web3 Infrastructure round has a roundId of 865
- The Developer Tooling and Libraries has a roundId of 863

It is very important that you produce a valid query that contains only allowed fields.

Below you will find an example of a question along with a valid query that answers it:
<example>
User question: "What are the details for the Web3 Infrastructure round?"
</example>

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

IMPORTANT:
- return variables as stringified JSON

`;
		const response = await gqlExecutionAgent.generate(prompt, {
			output: generateQueryOutput,
		});
		if (!response.object) {
			throw new Error("Failed to generate query from LLM");
		}
		return response.object;
	},
});

/** Helper function to create and execute a vector query tool. */
async function executeQueryWithVectorTool(
	pgUrl: string,
	collectionName: string,
	toolConfig: VectorQueryToolConfig,
	query: string,
) {
	const vectorQueryTool = createVectorQueryTool(
		pgUrl,
		collectionName,
		toolConfig,
	);
	if (!vectorQueryTool?.execute) {
		throw new Error(
			`Failed to create or find execute method for vector query tool: ${collectionName}`,
		);
	}

	const result = await vectorQueryTool.execute({ context: { query } });
	const context = result.results.map((r) => r.text).join("\n");
	return context;
}

const executeQuery = new Step({
	id: "executeQuery",
	outputSchema: z.object({
		data: z.string(),
		error: z.string().optional(),
		success: z.boolean(),
	}),
	execute: async ({ context }) => {
		const generateQueryResult = context.getStepResult(generateQuery);
		const query = generateQueryResult.query;
		const variables = generateQueryResult.variables;

		const response = await graphqlQuery?.execute?.({
			context: { query, variables },
		});

		if (!response) {
			return {
				data: "",
				error: "No response from GraphQL query execution",
				success: false,
			};
		}

		if (response?.success === false && response.errors) {
			return {
				data: "",
				errors: JSON.stringify(response.errors),
				success: false,
			};
		}

		return {
			data: JSON.stringify(response.data),
			success: true,
		};
	},
});

/** A workflow to analyze a GraphQL endpoint, split its schema, and embed chunks. */
export const graphqlAnalysis1 = new Workflow({
	name: "graphqlAnalysis1",
	// Define the expected input for this workflow
	triggerSchema: z.object({
		prompt: z
			.string()
			.describe(
				"Prompt to generate a GraphQL query from the schema and source code context",
			),
	}),
})
	.step(buildContextFromSchema)
	.then(sourceCode)
	.then(generateQuery)
	.then(executeQuery)
	.after(executeQuery)
	.step(analyzeQuery, {
		when: {
			"executeQuery.success": "true",
		},
	})
	.step(
		new Step({
			id: "fixQuery",
			outputSchema: generateQueryOutput,
			execute: async ({ context }) => {
				const generateQueryResult = context.getStepResult(generateQuery);
				const query = generateQueryResult.query;
				const variables = generateQueryResult.variables;
				const errors = context.getStepResult(executeQuery).error;

				const response = await gqlExecutionAgent.generate(
					`
The following query is invalid and needs to be fixed:
${query}
The variables are:
${variables}

When the query was executed it produced the following error(s):
${errors}

Generate a new query that is valid and will not produce any errors.
Make sure to include the variables in the response.

Here is further context for the active GG23 rounds:
- All rounds are currently active on Arbitrum network which has a chainId of 42161.
- The dApps and Apps round has a roundId of 867
- The Web3 Infrastructure round has a roundId of 865
- The Developer Tooling and Libraries has a roundId of 863
`,
					{
						output: generateQueryOutput,
					},
				);
				return response.object;
			},
		}),
	)
	.then(new Step({ ...executeQuery, id: "executeFixedQuery" }))

	.commit();
