import { createVectorQueryTool } from "./get-vector-context";
import { createGraphQLIntrospectionTool } from "./introspect-graphql";
// Import tool creators
import { createGraphQLQueryTool } from "./query-graphql";

// Environment variables
const GITCOIN_INDEXER_API_URL =
	process.env.GITCOIN_INDEXER_API_URL ||
	"https://beta.indexer.gitcoin.co/v1/graphql";
const POSTGRES_URL = process.env.POSTGRES_URL;
const GITCOIN_DOCS_INDEX = process.env.GITCOIN_DOCS_INDEX || "gitcoin_docs";
const GITCOIN_ALLO_SOURCE_CODE =
	process.env.GITCOIN_DOCS_INDEX || "gitcoin_code_embeddings";
const GITCOIN_SOURCE_INDEX =
	process.env.GITCOIN_SOURCE_INDEX || "gitcoin_source_code";
const SUCCESSFUL_QUERIES_INDEX =
	process.env.SUCCESSFUL_QUERIES_INDEX || "successful_gql_queries";
const API_TOKEN = process.env.API_TOKEN || "";

/**
 * Create and export GraphQL query tool instance
 */
export const graphqlQuery = createGraphQLQueryTool(GITCOIN_INDEXER_API_URL, {
	allowMutations: false,
	defaultHeaders: {
		Authorization: API_TOKEN ? `Bearer ${API_TOKEN}` : "",
	},
	successfulQueriesIndexName: SUCCESSFUL_QUERIES_INDEX,
	pgConnectionString: POSTGRES_URL,
});

/**
 * Create and export GraphQL introspection tool instance
 */
export const graphqlIntrospection = createGraphQLIntrospectionTool(
	GITCOIN_INDEXER_API_URL,
	{
		defaultHeaders: {
			Authorization: API_TOKEN ? `Bearer ${API_TOKEN}` : "",
		},
	},
);

if (!POSTGRES_URL) {
	throw new Error(
		"POSTGRES_URL is not set. Please set it to use vector query tools.",
	);
}

/**
 * Export vector query tools conditionally
 */

const dynamicGitcoinDocs = createVectorQueryTool(
	POSTGRES_URL,
	GITCOIN_DOCS_INDEX,
	{
		description:
			"Retrieve relevant information about the Gitcoin Grants ecosystem, how the protocol works, and how to get involved from a grantee, community member, or just an interested party",
		topK: 1,
		threshold: 0.3,
	},
);

const alloGithubSmartContract = createVectorQueryTool(
	POSTGRES_URL,
	GITCOIN_ALLO_SOURCE_CODE,
	{
		description:
			"Retrieve relevant source code that makes up the mechanisms behind Gitcoin Grants Rounds. Useful to understand how the protocol works and how to run queries to access relevant transaction data",
		topK: 1,
		threshold: 0.3,
	},
);

const dynamicGitcoinSourceCode = createVectorQueryTool(
	POSTGRES_URL,
	GITCOIN_SOURCE_INDEX,
	{
		description:
			"Retrieve relevant source code that makes up the mechanisms behind Gitcoin Grants Rounds. Useful to understand how the protocol works and how to contribute to it",
		topK: 1,
		threshold: 0.3,
	},
);

export {
	dynamicGitcoinDocs,
	dynamicGitcoinSourceCode,
	alloGithubSmartContract,
};

/**
 * Export all tool creators for custom usage
 */
// export {
//   createGraphQLQueryTool,
//   createGraphQLIntrospectionTool,
//   createVectorQueryTool
// };

/**
 * Create a combined tools object with all available tools
 */
// const tools = {
//   graphqlQuery,
//   graphqlIntrospection,
//   ...(dynamicGitcoinDocs ? { dynamicGitcoinDocs } : {}),
//   ...(dynamicGitcoinSourceCode ? { dynamicGitcoinSourceCode } : {})
// };

// export default tools;
