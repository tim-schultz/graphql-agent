import { createLogger } from "@mastra/core/logger";
import { Mastra } from "@mastra/core/mastra";
// Import both workflow and agent from the workflows file
import { gitcoinAgent, gitcoinQueryWorkflow } from "./workflows";

export const mastra = new Mastra({
	workflows: { gitcoinQueryWorkflow },
	agents: { gitcoinAgent },
	logger: createLogger({
		name: "Mastra",
		level: "info",
	}),
});
