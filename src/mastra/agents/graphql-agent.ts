import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

const openrouter = createOpenRouter({
	apiKey: process.env.OPENROUTER_API_KEY,
});

export const gqlAgent = new Agent({
	name: "GraphQL Agent",
	instructions: `
    You are an AI assistant tasked with generating GraphQL queries based on user questions, a provided GraphQL schema, and useful knowledge about the queried service.
    Your goal is to create a query that can be executed against a GraphQL server to answer the user's question.
    `,
	model: openrouter.chat("openrouter/quasar-alpha"),
});
