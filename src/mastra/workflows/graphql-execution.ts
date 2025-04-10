import { Step, Workflow } from "@mastra/core/workflows";
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
	name: "newQueryAnalysis",
	// Define a specific schema for inputs to this nested workflow
	triggerSchema: z.object({
		prompt: z.string(),
	}),
})
	.step(fetchSchema)
	.then(sourceCode)
	.then(generateQuery)
	.then(analyzeQuery, {
		when: {
			"generateQuery.success": "true",
		},
	})
	.commit();

// Define the main workflow
const fixQueryAnalysis = new Workflow({
	name: "fixQueryAnalysis",
	triggerSchema: fixQueryInputSchema,
})
	.step(fixQuery)
	.then(analyzeQuery)
	.commit();

// Export both workflows
export { newQueryAnalysis, fixQueryAnalysis };
