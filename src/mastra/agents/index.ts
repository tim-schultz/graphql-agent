import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

const openrouter = createOpenRouter({
	apiKey: process.env.OPENROUTER_API_KEY,
});

export const gqlIntrospectAgent = new Agent({
	name: "GraphQL Agent",
	instructions: `
    You are an AI assistant tasked with generating GraphQL queries based on user questions, a provided GraphQL schema, and useful knowledge about the queried service.
    Your goal is to create a query that can be executed against a GraphQL server to answer the user's question.
    `,
	model: openai("o3-mini-2025-01-31"),
});

export const gqlExecutionAgent = new Agent({
	name: "GraphQL Agent",
	instructions: `
    You are an AI assistant tasked with executing GraphQL queries based on user questions, a provided GraphQL schema, and useful knowledge about the queried service.
    Your goal is to create a query that can be executed against a GraphQL server to answer the user's question.
    `,
	model: openai("o3-mini-2025-01-31"),
});

export const analysisAgent = new Agent({
	name: "GraphQL Agent",
	instructions: `
    You are an AI assistant tasked with generating a detailed response to a user's query.
    You will be given the user's original question, a graphql query, and an explanation of that query, and the query result. Answer the user's question to the best of your ability.
    `,
	model: openai("o3-mini-2025-01-31"),
});

export const gitcoinAgent = new Agent({
	name: "Gitcoin Analysis Agent",
	instructions: `You are a data scientist specializing in blockchain analytics. 
  You have access to the Gitcoin Grants Program's GraphQL API and documentation.
  Your task is to analyze user queries, determine appropriate GraphQL queries,
  and provide insightful answers based on the data.
  
  When querying data about the latest grants rounds you need to filter by chainId and roundId.
  
  Here is further context for the active GG23 rounds:
  - All rounds are currently active on Arbitrum network which has a chainId of 42161.
  - The dApps and Apps round has a roundId of 867
  - The Web3 Infrastructure round has a roundId of 865
  - The Developer Tooling and Libraries has a roundId of 863
  
  Remember to:
  - Always introspect the GraphQL schema first to understand available queries
  - Ensure that you pass the correct arguments to GraphQL requests
  - Do not request the 'project.metadata.credentials' field as it contains sensitive information
  - If a query fails, analyze why and adjust parameters to try again`,
	model: openai("o3-mini-2025-01-31"),
});

export { graphqlQueryAgent } from "./graphql-query-agent";
