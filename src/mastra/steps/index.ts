import { Step } from "@mastra/core/workflows";
import { z } from "zod";
import { analysisAgent } from "../agents";
import { generateQuery } from "./generate-query";
import { analysisData, queryOutput } from "./types";

// Step to analyze query results
export const analyzeQuery = new Step({
	id: "analyzeQuery",
	inputSchema: z.object({
		prompt: z.string(),
		queryData: queryOutput,
	}),
	outputSchema: analysisData,
	execute: async ({ context }) => {
		try {
			const { prompt, queryData } = context.inputData;
			const { query, variables, explanation, response } =
				context.getStepResult(generateQuery);

			const analysisPrompt = `
You are an expert GraphQL analyst who can interpret query results and provide clear insights.
You'll be given a user's original question, the GraphQL query that was executed, and the query results.
Your job is to analyze the data and provide meaningful insights that directly answer the user's original question.

User's original question:
"${prompt}"

The GraphQL query that was executed:
\`\`\`graphql
${query}
\`\`\`

The variables used:
\`\`\`json
${variables}
\`\`\`

Query explanation:
${explanation || "No explanation provided."}

Query results:
\`\`\`json
${JSON.stringify(response, null, 2)}
\`\`\`

Please provide a comprehensive analysis of these results that:
1. Clearly explains what the data shows in relation to the original question
2. Highlights key insights extracted from the data
3. Notes any patterns, trends, or notable observations
4. Mentions any limitations in the data that prevent fully answering the original question
5. Offers possible next steps or further queries that might be helpful

Important: Provide your analysis as a well-structured natural text response without using XML tags.
When providing the analysis, be specific and reference actual values from the data when relevant.

At the end of your analysis, on a separate line, please include a relevance score from 0-10 indicating 
how well these results answer the original question, where 0 means "not at all relevant" and 10 means 
"completely answers the question". Format this as "Relevance score: X/10".
      `;

			const res = await analysisAgent.generate(analysisPrompt);

			if (!res || !res.text) {
				return {
					analysis: "Failed to analyze the query results.",
					relevance: 0,
					success: false,
				};
			}

			let relevanceScore = 5;
			const relevanceMatch = res.text.match(/Relevance score:\s*(\d+)\/10/i);
			if (relevanceMatch?.[1]) {
				relevanceScore = Number.parseInt(relevanceMatch[1], 10);
				relevanceScore = Math.min(10, Math.max(0, relevanceScore));
			}

			return {
				analysis: res.text,
				relevance: relevanceScore,
				success: true,
			};
		} catch (error) {
			console.error("Error in analyzeQuery step:", error);
			return {
				analysis: `Failed to analyze query results: ${error instanceof Error ? error.message : String(error)}`,
				relevance: 0,
				success: false,
			};
		}
	},
});

export { fixQuery } from "./fix-query";
export { generateQuery } from "./generate-query";
