import { openai } from "@ai-sdk/openai";
import { createTool } from "@mastra/core/tools";
import { PgVector } from "@mastra/pg";
import { embed } from "ai";
import { z } from "zod";

/**
 * Fetches contextually similar embeddings from the Mastra vector database.
 *
 * @param pgConnectionString PostgreSQL connection string
 * @param indexName The name of the vector index
 * @param topK Number of results to return (default: 5)
 * @param threshold Minimum similarity threshold (default: 0.5)
 * @param embeddingModel Model to use for embedding generation (default: 'text-embedding-3-small')
 */
export const createVectorQueryTool = (
	pgConnectionString: string,
	indexName: string,
	options: {
		topK?: number;
		threshold?: number;
		embeddingModel?: string;
		description?: string;
	} = {},
) => {
	// Set default values for options
	const topK = options.topK || 5;
	const threshold = options.threshold || 0.5;
	const embeddingModel = options.embeddingModel || "text-embedding-3-small";
	const description =
		options.description ||
		`Fetches contextually similar content from the vector database based on a query. This tool searches the '${indexName}' collection for the most relevant information.`;

	// Initialize the PgVector client
	const pgVector = new PgVector(pgConnectionString);

	return createTool({
		id: "Vector Database Query",
		inputSchema: z.object({
			query: z
				.string()
				.describe(
					"The user query or topic to find relevant context for. This should be a concise summary or question.",
				),
		}),
		outputSchema: z.object({
			context: z
				.string()
				.describe(
					"The context retrieved from the vector database. This will contain the most relevant information based on the query.",
				),
			query: z
				.string()
				.describe(
					"The original query that was used to fetch the context. This is useful for reference and debugging.",
				),
			results: z.array(
				z.object({
					text: z
						.string()
						.describe(
							"The text of the document that was retrieved from the vector database.",
						),
					similarity: z
						.number()
						.describe(
							"The similarity score of the retrieved document with respect to the query. This indicates how relevant the document is to the query.",
						),
					metadata: z.object({}),
				}),
			),
		}),
		description,
		execute: async ({ context: { query } }) => {
			try {
				console.log(`Executing Vector Query with: "${query}"`);

				// Generate embedding for the query using OpenAI
				const { embedding } = await embed({
					value: query,
					model: openai.embedding(embeddingModel),
				});

				// Query the vector store
				const results = await pgVector.query({
					indexName: indexName,
					queryVector: embedding,
					topK: topK,
					// // Optional filter by similarity threshold
					// filter: threshold > 0 ? {
					//   $custom: {
					//     operator: ">",
					//     value: threshold,
					//     field: "score" // This assumes the similarity score field is named 'score'
					//   }
					// } : undefined
				});

				if (!results || results.length === 0) {
					console.log("No context found for the query:", query);
					return {
						context: "No relevant context found in the vector database.",
						query,
						results: [],
					};
				}

				// Format results
				const formattedResults = results.map((result) => ({
					text: result.metadata?.text,
					similarity: result.score,
					metadata: { ...result.metadata },
				}));

				console.log(
					`Found ${formattedResults.length} relevant results for query: "${query}"`,
				);

				return {
					context: formattedResults
						.map(
							(doc) =>
								`- ${doc.text} (Similarity: ${doc.similarity.toFixed(2)})`,
						)
						.join("\n"),
					query,
					results: formattedResults,
				};
			} catch (error) {
				console.error("Error fetching vector context:", error);
				return {
					context: `Error fetching context from vector database: ${
						error instanceof Error ? error.message : "Unknown error"
					}`,
					query,
					results: [],
				};
			}
		},
	});
};

/**
 * Usage example:
 *
 * import { createVectorQueryTool } from './vectorQueryTool';
 * import { Agent } from "@mastra/core/agent";
 * import { openai } from "@ai-sdk/openai";
 *
 * // Create the vector query tool
 * const vectorQueryTool = createVectorQueryTool(
 *   process.env.POSTGRES_CONNECTION_STRING,
 *   "knowledge_base",
 *   {
 *     topK: 3,
 *     threshold: 0.7,
 *     description: "Search our knowledge base for relevant information"
 *   }
 * );
 *
 * // Add the tool to an agent
 * export const ragAgent = new Agent({
 *   name: 'RAG Assistant',
 *   model: openai("gpt-4o-mini"),
 *   instructions: `You are a helpful assistant that uses vector search to provide accurate information.
 *   When asked a question, use the Vector Database Query tool to find relevant information.`,
 *   tools: {
 *     vectorQueryTool
 *   },
 * });
 */
