import { createLogger } from "@mastra/core/logger";
import { Mastra } from "@mastra/core/mastra";
import {
	analysisAgent,
	gitcoinAgent,
	gqlExecutionAgent,
	gqlIntrospectAgent,
} from "./agents";
import { graphqlExecution } from "./workflows";

export const mastra = new Mastra({
	workflows: { graphqlExecution },
	agents: {
		gitcoinAgent,
		gqlIntrospectAgent,
		gqlExecutionAgent,
		analysisAgent,
	},
	logger: createLogger({
		name: "Mastra",
		level: "info",
	}),
});
