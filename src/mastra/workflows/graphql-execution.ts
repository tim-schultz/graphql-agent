import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import {gqlAgent} from "../agents";
import { graphqlIntrospection } from "../tools";

const graphqlExecution = new Workflow({
    name: "gitcoin-query-workflow",
    triggerSchema: z.object({
      userQuestion: z.string(),
    }),
  });

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
      const userQuestion = context?.getStepResult<{ userQuestion: string }>("trigger")?.userQuestion 
        || "";
      
      console.log("Fetching schema for question:", userQuestion);
      
      // Use the introspection tool to fetch the schema
      const result = await graphqlIntrospection!.execute!({context:{}});
      
      if (!result.success || !result.fullSchema) { // Added check for fullSchema existence
        throw new Error(`Failed to fetch GraphQL schema: ${result.message || 'Schema was empty'}`);
      } 
      
      return {
        schema: result.fullSchema, // Now guaranteed to be a string
        userQuestion,
      };
    },
  });


export { graphqlExecution }