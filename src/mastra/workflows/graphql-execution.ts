import { Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { analyzeQuery, fixQuery, generateQuery } from "../steps";
import { fetchSchema, sourceCode } from "../steps/generate-query";
import { fixQueryInputSchema } from "../steps/types";

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
	.after(generateQuery)
	.step(analyzeQuery, {
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
	.step(fetchSchema)
	.then(sourceCode)
	.then(fixQuery)
	.after(fixQuery)
	.step(analyzeQuery, {
		when: {
			"generateQuery.success": "true",
		},
	})
	.commit();

// Export both workflows
export { newQueryAnalysis, fixQueryAnalysis };
