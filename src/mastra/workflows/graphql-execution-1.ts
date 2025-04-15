import { Step, Workflow } from "@mastra/core";
import { z } from "zod";
// Placeholder for the actual embedding function/tool - replace with your implementation
// import { embedInCollection } from "../path/to/embedding/tool";

import { gqlExecutionAgent } from "../agents";
import { analyzeQuery } from "../steps";
import { sourceCode } from "../steps/generate-query";
import { schemaOutput, sourceCodeOutput, typesOutput } from "../steps/types";
import {
	POSTGRES_URL,
	dynamicGitcoinDocs,
	graphqlQuery,
	graphqlSourceTypes,
} from "../tools";
import { createVectorQueryTool } from "../tools/get-vector-context";

// Infer the tool config type from the create function
type VectorQueryToolConfig = Parameters<typeof createVectorQueryTool>[2];

const generateQueryOutput = z.object({
	query: z.string(),
	variables: z.string(),
});

// Step to fetch GraphQL schema
export const fetchSchemaDefinition = new Step({
	id: "fetchSchemaDefinition",
	outputSchema: typesOutput,
	execute: async ({ context }) => {
		const prompt = context?.getStepResult<{ prompt: string }>(
			"trigger",
		)?.prompt;

		const result = await graphqlSourceTypes?.execute?.({
			context: {
				query: `Type definitions similar to: ${prompt}`,
			},
		});

		if (!result?.context) {
			throw new Error("Failed to fetch GraphQL schema types");
		}

		return {
			types: result.results.map((r) => r.metadata.content).join("\n"),
		};
	},
});

const generateQuery = new Step({
	id: "generateQuery",
	// Define the output structure for this step
	outputSchema: generateQueryOutput,
	execute: async ({ context }) => {
		const referenceResult = context.getStepResult(fetchSchemaDefinition);
		const sourceCodeResult = context.getStepResult(sourceCode);
		// 		Also use the following source code context to help answer the question:
		// ${sourceCodeResult.relevantSourceCode}
		console.log(referenceResult.types, "referenceResult.types)");
		const prompt = `
Your goal is to craft a GraphQL query that will help answer the following question:
${context.triggerData.prompt}

Here is relevant documentation to help answer the question:
${sourceCodeResult.relevantSourceCode}

Use the following typescript type definitions which represent the available query parameters to help answer the question:
${referenceResult.types}


Here is further context for the active GG23 rounds:
- All rounds are currently active on Arbitrum network which has a chainId of 42161.
- The dApps and Apps round has a roundId of 867
- The Web3 Infrastructure round has a roundId of 865
- The Developer Tooling and Libraries has a roundId of 863
- Each round has a series projects that receive donations within a round


IMPORTANT:
- return variables as stringified JSON
- produce a valid GRAPHQL query that contains only allowed fields
- Generate a new query that is valid and will not produce any errors.
- Make sure to include the variables in the response.

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
	.step(fetchSchemaDefinition)
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

	Here are the typescript type definitions which represent the available query parameters to help answer the question:
	${context.getStepResult(fetchSchemaDefinition).types}

	Generate a new query that is valid and will not produce any errors.
	Make sure to include the variables in the response.

	Here is further context for the active GG23 rounds:
	- All rounds are currently active on Arbitrum network which has a chainId of 42161.
	- The dApps and Apps round has a roundId of 867
	- The Web3 Infrastructure round has a roundId of 865
	- The Developer Tooling and Libraries has a roundId of 863
	- Each round has a series projects that receive donations within a round

	IMPORTANT:
	- return variables as stringified JSON
	- produce a valid GRAPHQL query that contains only allowed fields
	- Generate a new query that is valid and will not produce any errors.
	- Make sure to include the variables in the response.
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
	.step(analyzeQuery, {
		when: {
			"executeFixedQuery.success": "true",
		},
	})

	.commit();
