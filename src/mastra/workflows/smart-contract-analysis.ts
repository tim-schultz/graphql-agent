import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";

// Import existing tools
import {
	dynamicGitcoinDocs,
	dynamicGitcoinSourceCode,
	graphqlIntrospection,
	graphqlQuery,
} from "../tools";

// Use the specified model
const o3Mini = openai("o3-mini-2025-01-31");

// Create an agent for our workflow
const gitcoinAgent = new Agent({
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
	model: o3Mini,
});

// Step 1: Fetch GraphQL Schema
const fetchSchema = new Step({
	id: "fetchSchema",
	inputSchema: z.object({
		userQuestion: z.string(),
	}),
	// outputSchema: z.object({
	//   schema: z.string(),
	//   userQuestion: z.string(),
	// }),
	execute: async ({ context }) => {
		// Get the user question from the trigger
		const userQuestion =
			context?.getStepResult<{ userQuestion: string }>("trigger")
				?.userQuestion || "";

		console.log("Fetching schema for question:", userQuestion);

		// Use the introspection tool to fetch the schema
		const result = await graphqlIntrospection?.execute?.({ context: {} });

		if (!result?.success || !result.fullSchema) {
			// Added check for fullSchema existence
			throw new Error(
				`Failed to fetch GraphQL schema: ${result?.message || "Schema was empty"}`,
			);
		}

		return {
			schema: result.fullSchema, // Now guaranteed to be a string
			userQuestion,
		};
	},
});

// Step 2: Search Documentation and Source Code
const searchContext = new Step({
	id: "searchContext",
	outputSchema: z.object({
		docsContext: z.string(),
		sourceCodeContext: z.string(),
		schema: z.string(),
		userQuestion: z.string(),
	}),
	execute: async ({ context }) => {
		const prevResult = context?.getStepResult<{
			schema: string;
			userQuestion: string;
		}>("fetchSchema");

		if (!prevResult) {
			throw new Error("No schema or user question found from previous step");
		}

		const { schema, userQuestion } = prevResult;

		// Search for relevant documentation
		console.log("Searching Gitcoin docs for context");
		// Wrap query in context object
		const docsResult = await dynamicGitcoinDocs?.execute?.({
			context: { query: userQuestion },
		});

		// Search for relevant source code
		console.log("Searching Gitcoin source code for context");
		// Wrap query in context object
		const sourceResult = await dynamicGitcoinSourceCode?.execute?.({
			context: { query: userQuestion },
		});
		return {
			docsContext: docsResult?.context || "No relevant documentation found.",
			sourceCodeContext:
				sourceResult.context || "No relevant source code found.",
			schema,
			userQuestion,
		};
	},
});

// Step 3: Plan GraphQL Query
const planQuery = new Step({
	id: "planQuery",
	outputSchema: z.object({
		queryText: z.string(),
		queryVariables: z.string().optional(),
		docsContext: z.string(),
		sourceCodeContext: z.string(),
		schema: z.string(),
		userQuestion: z.string(),
		attemptCount: z.number().default(1),
	}),
	execute: async ({ context }) => {
		// Check if this is an initial query or a retry
		const retryContext = context?.getStepResult<{
			queryText: string;
			queryVariables?: string;
			docsContext: string;
			sourceCodeContext: string;
			schema: string;
			userQuestion: string;
			attemptCount: number;
			analysisResult?: string;
		}>("analyzeResult");

		const initialContext = context?.getStepResult<{
			docsContext: string;
			sourceCodeContext: string;
			schema: string;
			userQuestion: string;
		}>("searchContext");

		if (!retryContext && !initialContext) {
			throw new Error("No context found from previous steps");
		}

		// Use retry context if available, otherwise use initial context
		const {
			docsContext,
			sourceCodeContext,
			schema,
			userQuestion,
			attemptCount = 1,
			analysisResult,
		} = retryContext || { ...initialContext, attemptCount: 1 };

		const promptBase = `
      I need you to create a GraphQL query to answer this question: "${userQuestion}"
      
      Here's what I know about the Gitcoin ecosystem:
      
      DOCUMENTATION CONTEXT:
      ${docsContext}
      
      SOURCE CODE CONTEXT:
      ${sourceCodeContext}
      
      GRAPHQL SCHEMA (EXCERPT):
      ${schema.length > 3000 ? `${schema.substring(0, 3000)}... (truncated)` : schema}
    `;

		// For retries, include the previous attempt and analysis
		const retryPrompt = retryContext
			? `
      PREVIOUS QUERY ATTEMPT:
      ${retryContext.queryText}
      
      WITH VARIABLES:
      ${retryContext.queryVariables || "{}"}
      
      ANALYSIS OF FAILURE:
      ${analysisResult}
      
      Please correct the issues and create a new query.
    `
			: "";

		const prompt = `
      ${promptBase}
      ${retryPrompt}
      
      IMPORTANT REMINDERS:
      - Do not request 'project.metadata.credentials' as it contains sensitive information
      - For grants rounds, filter by chainId (42161 for Arbitrum) and appropriate roundId
      - Ensure types match exactly what the schema expects
      
      Return a valid GraphQL query and variables as a JSON object with these properties:
      - queryText: The complete GraphQL query string
      - queryVariables: A JSON string containing the variables for the query (if any)
    `;

		const res = await gitcoinAgent.generate(prompt, {
			output: z.object({
				queryText: z.string(),
				queryVariables: z.string(),
			}),
		});

		return {
			...res.object,
			docsContext,
			sourceCodeContext,
			schema,
			userQuestion,
			attemptCount: retryContext ? retryContext.attemptCount + 1 : 1,
		};
	},
});

// Step 4: Execute Query
const executeQuery = new Step({
	id: "executeQuery",
	outputSchema: z.object({
		success: z.boolean(),
		data: z.any().optional(),
		errors: z.any().optional(),
		message: z.string().optional(),
		queryText: z.string(),
		queryVariables: z.string().optional(),
		docsContext: z.string(),
		sourceCodeContext: z.string(),
		schema: z.string(),
		userQuestion: z.string(),
		attemptCount: z.number(),
	}),
	execute: async ({ context }) => {
		const prevResult = context?.getStepResult<{
			queryText: string;
			queryVariables?: string;
			docsContext: string;
			sourceCodeContext: string;
			schema: string;
			userQuestion: string;
			attemptCount: number;
		}>("planQuery");

		if (!prevResult) {
			throw new Error("No query plan found from previous step");
		}

		const {
			queryText,
			queryVariables,
			docsContext,
			sourceCodeContext,
			schema,
			userQuestion,
			attemptCount,
		} = prevResult;

		console.log(`Executing GraphQL query (attempt ${attemptCount}):`);
		console.log(queryText);
		console.log("With variables:", queryVariables || "{}");

		console.log(`Executing GraphQL query (attempt ${attemptCount}):`);
		console.log(queryText);
		console.log("With variables:", queryVariables || "{}");

		// Execute the query using the graphqlQuery tool
		// Wrap query and variables in context object
		const result = await graphqlQuery?.execute?.({
			context: {
				query: queryText,
				variables: queryVariables,
			},
		});

		return {
			...result,
			queryText,
			queryVariables,
			docsContext,
			sourceCodeContext,
			schema,
			userQuestion,
			attemptCount,
		};
	},
});

// Step 5: Analyze Result
const analyzeResult = new Step({
	id: "analyzeResult",
	outputSchema: z.object({
		answer: z.string(),
		needsRetry: z.boolean(),
		retryStrategy: z.string().optional(),
		queryText: z.string(),
		queryVariables: z.string().optional(),
		docsContext: z.string(),
		sourceCodeContext: z.string(),
		schema: z.string(),
		userQuestion: z.string(),
		attemptCount: z.number(),
		analysisResult: z.string().optional(),
	}),
	execute: async ({ context }) => {
		const prevResult = context?.getStepResult<{
			success: boolean;
			data?: unknown;
			errors?: unknown;
			message?: string;
			queryText: string;
			queryVariables?: string;
			docsContext: string;
			sourceCodeContext: string;
			schema: string;
			userQuestion: string;
			attemptCount: number;
		}>("executeQuery");

		if (!prevResult) {
			throw new Error("No query execution result found from previous step");
		}

		const {
			success,
			data,
			errors,
			message,
			queryText,
			queryVariables,
			docsContext,
			sourceCodeContext,
			schema,
			userQuestion,
			attemptCount,
		} = prevResult;

		// Define maximum retry attempts
		const MAX_RETRIES = 2;

		console.log(
			`Analyzing query result (success: ${success}, attempt: ${attemptCount}/${MAX_RETRIES})`,
		);

		// If success, analyze the data and generate an answer
		if (success) {
			const prompt = `
        Please analyze this GraphQL query result and provide a clear, concise answer to the user's question.
        
        USER QUESTION:
        ${userQuestion}
        
        QUERY EXECUTED:
        ${queryText}
        
        VARIABLES:
        ${queryVariables || "{}"}
        
        RESULT DATA:
        ${JSON.stringify(data, null, 2)}
        
        DOCUMENTATION CONTEXT:
        ${docsContext}
        
        SOURCE CODE CONTEXT:
        ${sourceCodeContext}
        
        Provide a comprehensive but concise answer focused specifically on what the user asked.
        Be direct and helpful, using the data from the query result as the primary source of information.
      `;

			const res = await gitcoinAgent.generate(prompt);

			return {
				answer: res.text,
				needsRetry: false,
				queryText,
				queryVariables,
				docsContext,
				sourceCodeContext,
				schema,
				userQuestion,
				attemptCount,
			};
		}
		// Query failed - should we retry?
		const shouldRetry = attemptCount < MAX_RETRIES;

		// Analyze the error
		const errorAnalysisPrompt = `
        Please analyze why this GraphQL query failed and provide specific guidance on how to fix it.
        
        USER QUESTION:
        ${userQuestion}
        
        QUERY THAT FAILED:
        ${queryText}
        
        VARIABLES:
        ${queryVariables || "{}"}
        
        ERROR MESSAGE:
        ${JSON.stringify(errors, null, 2) || "Unknown error"}
        
        DOCUMENTATION CONTEXT:
        ${docsContext}
        
        SOURCE CODE CONTEXT:
        ${sourceCodeContext}
        
        GRAPHQL SCHEMA (EXCERPT):
        ${schema.length > 2000 ? `${schema.substring(0, 2000)}... (truncated)` : schema}
        
        ${shouldRetry ? "Please provide a detailed analysis of what went wrong and how to correct it." : "Please provide a detailed analysis of what went wrong and suggest an alternative approach."}
      `;

		const analysisRes = await gitcoinAgent.generate(errorAnalysisPrompt);
		const analysisResult = analysisRes.text;

		if (shouldRetry) {
			// We'll try again
			return {
				answer: "",
				needsRetry: true,
				retryStrategy: analysisResult,
				queryText,
				queryVariables,
				docsContext,
				sourceCodeContext,
				schema,
				userQuestion,
				attemptCount,
				analysisResult,
			};
		}
		// We've exhausted retries, give a fallback answer
		const fallbackPrompt = `
          You need to provide a helpful response despite GraphQL query failures.
          
          USER QUESTION:
          ${userQuestion}
          
          We attempted ${attemptCount} queries but all failed.
          
          LAST ERROR:
          ${JSON.stringify(errors, null, 2) || message || "Unknown error"}
          
          DOCUMENTATION CONTEXT:
          ${docsContext}
          
          SOURCE CODE CONTEXT:
          ${sourceCodeContext}
          
          Please provide a helpful response based on the documentation and source code context,
          even though we couldn't get specific data from the GraphQL API.
          Acknowledge the technical difficulties but try to give the user some useful information
          based on what you know about Gitcoin from the context provided.
        `;

		const fallbackRes = await gitcoinAgent.generate(fallbackPrompt);

		return {
			answer: fallbackRes.text,
			needsRetry: false,
			queryText,
			queryVariables,
			docsContext,
			sourceCodeContext,
			schema,
			userQuestion,
			attemptCount,
			analysisResult,
		};
	},
});

// Step 6: Final Answer
const finalAnswer = new Step({
	id: "finalAnswer",
	outputSchema: z.object({
		finalAnswer: z.string(),
	}),
	execute: async ({ context }) => {
		const result = context?.getStepResult<{
			answer: string;
			needsRetry: boolean;
		}>("analyzeResult");

		if (!result) {
			throw new Error("No analysis result found from previous step");
		}

		// We should only reach this step if needsRetry is false
		return {
			finalAnswer: result.answer,
		};
	},
});

// Create the workflow with the full retry loop
const gitcoinQueryWorkflow = new Workflow({
	name: "gitcoin-query-workflow",
	triggerSchema: z.object({
		userQuestion: z.string(),
	}),
});

// First attempt path
gitcoinQueryWorkflow
	.step(fetchSchema)
	.then(searchContext)
	.then(planQuery)
	.then(executeQuery)
	.then(analyzeResult)
	.then(finalAnswer, {
		when: { "analyzeResult.needsRetry": false },
	})
	.after(analyzeResult)
	.step(planQuery, {
		when: { "analyzeResult.needsRetry": true },
	});

// Complete retry path - if query fails, try again with new plan
gitcoinQueryWorkflow
	.after(planQuery)
	.step(executeQuery)
	.then(analyzeResult)
	.then(finalAnswer, {
		when: { "analyzeResult.needsRetry": false },
	})
	.after(analyzeResult)
	.step(fetchSchema, {
		when: {
			"analyzeResult.needsRetry": true,
			"analyzeResult.attemptCount": 2,
		},
	})
	.after(analyzeResult)
	.step(planQuery, {
		when: {
			"analyzeResult.needsRetry": true,
			"analyzeResult.attemptCount": 1,
		},
	});

// Special case: If we've exhausted our retries, restart from the beginning
gitcoinQueryWorkflow
	.after(fetchSchema)
	.step(searchContext)
	.after(searchContext)
	.step(planQuery);

gitcoinQueryWorkflow.commit();

// Export for use in other files
export { gitcoinQueryWorkflow, gitcoinAgent };
