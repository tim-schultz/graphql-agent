import { Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { analyzeQuery, fetchSchema, generateQuery, sourceCode } from "../steps";

// Create a nested workflow to handle query execution
const graphqlExecution = new Workflow({
	name: "new-query-analysis",
	// Define a specific schema for inputs to this nested workflow
	triggerSchema: z.object({
		prompt: z.string(),
	}),
})
	.step(fetchSchema)
	.then(sourceCode)
	.step(generateQuery)
	.step(analyzeQuery);

// Add steps to the execution workflow
graphqlExecution
	.step(generateQuery)
	.then(analyzeQuery, {
		when: { "generateQuery.status": true }, // Note: Changed from "success" to true based on your schema
	})
	.commit();

// Define the main workflow
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
