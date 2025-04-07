import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Helper function to parse and merge headers
 */
function parseAndMergeHeaders(
  defaultHeaders: Record<string, string> = {},
  additionalHeaders: Record<string, string> | string = {}
): Record<string, string> {
  let parsedAdditionalHeaders: Record<string, string> = {};
  
  if (typeof additionalHeaders === 'string') {
    try {
      parsedAdditionalHeaders = JSON.parse(additionalHeaders);
    } catch (e) {
      console.warn('Failed to parse headers as JSON, using empty object');
    }
  } else {
    parsedAdditionalHeaders = additionalHeaders;
  }
  
  return { ...defaultHeaders, ...parsedAdditionalHeaders };
}

/**
 * Helper function to validate a URL
 */
function isValidUrl(string: string): boolean {
  try {
    new URL(string);
    return true;
  } catch {
    return false;
  }
}

/**
 * Introspect a GraphQL schema from an endpoint
 */
async function introspectEndpoint(
  endpoint: string,
  headers: Record<string, string> = {}
): Promise<string> {
  const introspectionQuery = `
    query IntrospectionQuery {
      __schema {
        queryType { name }
        mutationType { name }
        subscriptionType { name }
        types {
          ...FullType
        }
        directives {
          name
          description
          locations
          args {
            ...InputValue
          }
        }
      }
    }
    
    fragment FullType on __Type {
      kind
      name
      description
      fields(includeDeprecated: true) {
        name
        description
        args {
          ...InputValue
        }
        type {
          ...TypeRef
        }
        isDeprecated
        deprecationReason
      }
      inputFields {
        ...InputValue
      }
      interfaces {
        ...TypeRef
      }
      enumValues(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
      }
      possibleTypes {
        ...TypeRef
      }
    }
    
    fragment InputValue on __InputValue {
      name
      description
      type {
        ...TypeRef
      }
      defaultValue
    }
    
    fragment TypeRef on __Type {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      query: introspectionQuery,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to introspect schema: ${response.statusText}`);
  }

  const result = await response.json();
  
  if (result.errors) {
    throw new Error(`GraphQL introspection failed: ${JSON.stringify(result.errors)}`);
  }
  
  // Convert the introspection result to a human-readable schema
  // This is a simplified version - in practice you might use a library like graphql-js
  // to convert the introspection result to a GraphQL SDL string
  return JSON.stringify(result.data.__schema, null, 2);
}

/**
 * Get relevant parts of a schema based on a prompt
 */
// async function getRelevantSchemas(
//   entireSchema: string,
//   prompt: string,
//   modelName: string = 'gpt-4o-mini'
// ): Promise<string> {
//   console.log('[GraphQL Introspection] Extracting relevant schema parts...');
  
//   try {
//     // Create a simple prompt to extract the relevant parts of the schema
//     const promptText = `You are an experienced data scientist.
// You are given the entire GraphQL schema and a desired outcome from the user.
// Analyze the schema and return sections of the schema that are useful for obtaining the desired result.

// Here is the full GraphQL Schema: ${entireSchema}
// This is what data the user would like to determine: ${prompt}

// IMPORTANT: return only the desired schema in a clear, usable format.`;

//     // Use OpenAI to extract the relevant parts of the schema
//     const completion = await openai(modelName).withPresencePenalty(0.2).complete({
//       prompt: promptText,
//       max_tokens: 4000,
//       temperature: 0.1,
//     });
    
//     return completion.text;
//   } catch (error) {
//     console.error('[GraphQL Introspection] Error extracting relevant schema parts:', error);
//     return "Error extracting relevant schema parts. Returning full schema instead.\n\n" + entireSchema;
//   }
// }

/**
 * Configuration options for the GraphQL introspection tool
 */
interface GraphQLIntrospectionToolOptions {
  defaultHeaders?: Record<string, string>;
  modelName?: string;
}

/**
 * Creates a GraphQL introspection tool for Mastra
 * 
 * @param endpoint GraphQL endpoint URL
 * @param options Tool configuration options
 * @returns Mastra-compatible introspection tool
 */
export const createGraphQLIntrospectionTool = (
  endpoint: string,
  options: GraphQLIntrospectionToolOptions = {}
) => {
  const {
    defaultHeaders = {},
    modelName = 'gpt-4o-mini'
  } = options;
  
  return createTool({
    id: "GraphQL Introspection",
    inputSchema: z.object({}),
    description: 'Introspect a GraphQL schema from an endpoint',
    execute: async ({ context }) => {
      try {
        console.log('[GraphQL Introspection] Introspecting GraphQL schema...');
        
        if (!endpoint || !isValidUrl(endpoint)) {
          throw new Error('Invalid endpoint URL format');
        }
        
        const useHeaders = parseAndMergeHeaders(defaultHeaders, {});
        
        // Get the full schema
        const schema = await introspectEndpoint(endpoint, useHeaders);
        
        
        // // Extract relevant parts of the schema based on the user's query
        // const relevantSchema = await getRelevantSchemas(
        //   schema,
        //   String(lastPrompt),
        //   modelName
        // );
        
        console.log('[GraphQL Introspection] Successfully extracted relevant schema parts.');
        
        return {
          success: true,
        //   schema: relevantSchema,
          fullSchema: schema,
          message: 'GraphQL schema introspection completed successfully'
        };
      } catch (error: unknown) {
        console.error('[GraphQL Introspection] Error:', error);
        
        return {
          success: false,
          schema: null,
          message: `Failed to introspect schema: ${String(error)}`
        };
      }
    }
  });
};


const graphqlIntrospectionTool = createGraphQLIntrospectionTool(
    "https://beta.indexer.gitcoin.co/v1/graphql",
    {
      
    }
  );
  if (!graphqlIntrospectionTool) {
    throw new Error("Failed to create GraphQL introspection tool");
  }

  const toolResponse = await graphqlIntrospectionTool.execute({
    context: {}
  });

  console.log("Tool response:", toolResponse);
