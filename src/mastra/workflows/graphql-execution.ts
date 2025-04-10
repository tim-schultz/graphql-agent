import { Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
	analyzeQuery,
	fetchSchema,
	fixQuery,
	fixQueryInputSchema,
	generateQuery,
	sourceCode,
} from "../steps";

// Create a nested workflow to handle query execution
const newQueryAnalysis = new Workflow({
	name: "new-query-analysis",
	// Define a specific schema for inputs to this nested workflow
	triggerSchema: z.object({
		prompt: z.string(),
	}),
})
	.step(fetchSchema)
	.then(sourceCode)
	.then(generateQuery)
	.then(analyzeQuery)
	.commit();

// Define the main workflow
const fixQueryAnalysis = new Workflow({
	name: "fix-query-analysis",
	triggerSchema: fixQueryInputSchema,
})
	.step(fixQuery)
	.then(analyzeQuery)
	.commit();

// Export both workflows
export { newQueryAnalysis, fixQueryAnalysis };
