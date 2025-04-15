import { createLogger } from "@mastra/core/logger";
import { Mastra } from "@mastra/core/mastra";
import {
	analysisAgent,
	gitcoinAgent,
	gqlExecutionAgent,
	gqlIntrospectAgent,
	graphqlQueryAgent,
} from "./agents";
import { fixQueryAnalysis, newQueryAnalysis } from "./workflows";
import { graphqlAnalysis1 } from "./workflows/graphql-execution-1";

export const mastra = new Mastra({
	workflows: { newQueryAnalysis, fixQueryAnalysis, graphqlAnalysis1 },
	agents: {
		gitcoinAgent,
		gqlIntrospectAgent,
		gqlExecutionAgent,
		analysisAgent,
		graphqlQueryAgent,
	},
	logger: createLogger({
		name: "Mastra",
		level: "info",
	}),
});
