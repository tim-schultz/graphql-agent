import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { openai } from "@ai-sdk/openai";
import { generate } from "@graphql-codegen/cli";
// Removed import for Types as it seems problematic in the current environment
// import type { Types } from "@graphql-codegen/core";
import { PgVector } from "@mastra/pg"; // Keep PgVector if ContentProcessor needs it passed in, or remove if encapsulated
import * as toml from "toml";
// import { embedMany } from "ai"; // embedMany likely handled by ContentProcessor
import { ContentProcessor, type ProcessableItem } from "./content-processor";
import { logger } from "./utils";

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default configuration path relative to the current file
const DEFAULT_CONFIG_PATH = path.join(__dirname, "config/graphql-types.toml");

// Assuming a default embedding model and dimension, adjust as needed
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSION = 1536;

interface Config {
	graphql: {
		endpoint: string;
		collection_prefix: string;
		headers?: Record<string, string>; // Optional headers for the endpoint
	};
}

/**
 * Loads configuration from a TOML file.
 * @param configPath - Path to the configuration file.
 * @returns The loaded configuration object.
 */
function loadConfig(configPath: string): Config {
	logger.info(`Loading configuration from ${configPath}`);
	try {
		const fileContent = fs.readFileSync(configPath, "utf-8");
		const config = toml.parse(fileContent);

		if (!config?.graphql?.endpoint || !config?.graphql?.collection_prefix) {
			throw new Error(
				"Configuration file is missing required fields (graphql.endpoint, graphql.collection_prefix)",
			);
		}

		// Ensure headers is an object if present, otherwise undefined
		if (config.graphql.headers && typeof config.graphql.headers !== "object") {
			throw new Error("graphql.headers must be an object (key-value pairs).");
		}

		return config as Config;
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			logger.error(`Configuration file not found at ${configPath}`);
			throw new Error(`Configuration file not found at ${configPath}`);
		}
		if (error instanceof Error) {
			logger.error(
				`Error parsing configuration file ${configPath}: ${error.message}`,
			);
			throw new Error(`Error parsing configuration file: ${error.message}`);
		}
		logger.error(
			`An unknown error occurred while loading configuration: ${String(error)}`,
		);
		throw new Error(
			`An unknown error occurred while loading configuration: ${String(error)}`,
		);
	}
}

/**
 * Generates TypeScript types from a remote GraphQL schema.
 * @param endpoint - The URL of the GraphQL endpoint.
 * @param headers - Optional headers for the request.
 * @returns The generated TypeScript types as a string.
 */
async function generateRemoteTypes(
	endpoint: string,
	headers?: Record<string, string>,
): Promise<string> {
	logger.info(`Generating TypeScript types from schema at ${endpoint}...`);
	try {
		// Let TypeScript infer the type for schemaConfig
		const schemaConfig: {
			[key: string]: { headers?: Record<string, string> };
		} = {};
		schemaConfig[endpoint] = headers ? { headers } : {};

		console.log("Schema config:", schemaConfig);
		const output = await generate({
			schema: endpoint,
			generates: {
				output: {
					plugins: ["typescript"],
				},
			},
			silent: true, // Minimize codegen logs
			errorsOnly: true, // Only log errors from codegen
		});

		const { content } = output[0];
		console.log("Codegen output:", content);

		logger.info(
			`Successfully generated TypeScript types. Total length: ${content.length}`,
		);
		return content;
	} catch (error: unknown) {
		logger.error(`Error generating types from ${endpoint}: ${error}`);
		if (error instanceof Error) {
			throw new Error(`Error generating types: ${error.message}`);
		}
		throw new Error(
			`An unknown error occurred during type generation: ${String(error)}`,
		);
	}
}

/**
 * Analyzes TypeScript type definitions to extract logical relationships between types.
 * @param typesContent - The full string content of the generated types file.
 * @returns An object containing the logical representation of types and their relationships.
 */

/** Represents extracted information about a TypeScript type. */
interface TypeInfo {
	name: string;
	kind: "type" | "interface" | "enum";
	content: string;
}

function analyzeTypeRelationships(typesContent: string): {
	types: Map<string, TypeInfo>;
	relationships: Map<string, string[]>;
} {
	// Extract all exported types with their content
	const typeRegex =
		/export\s+(type|interface|enum)\s+(\w+)([^{]*{[^}]*}|\s*=[^;]*;)/g;
	const types = new Map<string, TypeInfo>();
	const relationships = new Map<string, string[]>();

	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: Standard pattern for regex exec loop
	while ((match = typeRegex.exec(typesContent)) !== null) {
		const typeName = match[2];
		const typeKind = match[1] as TypeInfo["kind"]; // Assert type based on regex
		const typeContent = match[0];
		types.set(typeName, {
			name: typeName,
			kind: typeKind,
			content: typeContent,
		});

		// Check if this is a filter type (ends with BoolExp)
		if (typeName.endsWith("BoolExp")) {
			const entityName = typeName.replace("BoolExp", "");
			if (!relationships.has(entityName)) {
				relationships.set(entityName, []);
			}
			relationships.get(entityName)?.push(typeName);
		}

		// Check if this is an ordering type (ends with OrderBy)
		if (typeName.endsWith("OrderBy")) {
			const entityName = typeName.replace("OrderBy", "");
			if (!relationships.has(entityName)) {
				relationships.set(entityName, []);
			}
			relationships.get(entityName)?.push(typeName);
		}

		// Check if this is a selection type (ends with SelectColumn)
		if (typeName.endsWith("SelectColumn")) {
			const entityName = typeName.replace("SelectColumn", "");
			if (!relationships.has(entityName)) {
				relationships.set(entityName, []);
			}
			relationships.get(entityName)?.push(typeName);
		}

		// Check if this is an aggregate type (ends with Aggregate)
		if (typeName.endsWith("Aggregate")) {
			const entityName = typeName.replace("Aggregate", "");
			if (!relationships.has(entityName)) {
				relationships.set(entityName, []);
			}
			relationships.get(entityName)?.push(typeName);
		}
	}

	// Find field relationships within type definitions
	for (const [typeName, typeInfo] of types.entries()) {
		// Skip if not an entity type (to avoid processing filter types)
		if (
			typeName.endsWith("BoolExp") ||
			typeName.endsWith("OrderBy") ||
			typeName.endsWith("SelectColumn") ||
			typeName.endsWith("Aggregate")
		) {
			continue;
		}

		// Look for fields that reference other types
		const fieldRegex =
			/(\w+)(\?)?:\s*(?:Maybe<)?(\w+)(?:\['(?:output|input)'\])?/g;
		let fieldMatch: RegExpExecArray | null;
		const typeContent = typeInfo.content;

		// Reset regex lastIndex before each loop if using a global regex
		fieldRegex.lastIndex = 0;

		// biome-ignore lint/suspicious/noAssignInExpressions: Standard pattern for regex exec loop
		while ((fieldMatch = fieldRegex.exec(typeContent)) !== null) {
			const fieldName = fieldMatch[1];
			const referencedType = fieldMatch[3];

			// If the referenced type exists in our types map, it's a relationship
			if (
				types.has(referencedType) &&
				!referencedType.startsWith("Scalars") &&
				!["String", "Int", "Float", "Boolean"].includes(referencedType)
			) {
				if (!relationships.has(typeName)) {
					relationships.set(typeName, []);
				}

				// Add the field relationship
				const relationshipKey = `${typeName}.${fieldName}`;
				relationships.get(typeName)?.push(relationshipKey);
			}
		}
	}

	return { types, relationships };
}

/**
 * Creates chunks that preserve logical relationships between types.
 * @param typesContent - The full string content of the generated types file.
 * @returns An array of string chunks containing related types.
 */
function chunkGeneratedTypesWithRelationships(typesContent: string): string[] {
	logger.info("Analyzing type relationships...");
	const { types, relationships } = analyzeTypeRelationships(typesContent);

	// Group types by their logical relationships
	const typeGroups = new Map<string, Set<string>>();

	// First, create a group for each entity type
	for (const [entityName, relatedTypes] of relationships.entries()) {
		if (!typeGroups.has(entityName)) {
			typeGroups.set(entityName, new Set([entityName]));
		}

		// Add all directly related types to the entity's group
		for (const relatedType of relatedTypes) {
			if (relatedType.includes(".")) {
				// It's a field relationship, extract the type name
				const [, fieldType] = relatedType.split(".");
				typeGroups.get(entityName)?.add(fieldType);
			} else {
				typeGroups.get(entityName)?.add(relatedType);
			}
		}
	}

	// Merge overlapping groups
	const mergedGroups = new Map<string, Set<string>>();
	for (const [groupName, groupTypes] of typeGroups.entries()) {
		let merged = false;

		for (const [existingName, existingTypes] of mergedGroups.entries()) {
			// Check for overlap
			const hasOverlap = Array.from(groupTypes).some((type) =>
				existingTypes.has(type),
			);

			if (hasOverlap) {
				// Merge the groups
				for (const type of groupTypes) {
					existingTypes.add(type);
				}
				merged = true;
				break;
			}
		}

		if (!merged) {
			mergedGroups.set(groupName, groupTypes);
		}
	}

	// Create chunks from the merged groups
	const chunks: string[] = [];

	// Add any types that weren't part of a relationship group
	const coveredTypes = new Set<string>();
	for (const typeSet of mergedGroups.values()) {
		for (const typeName of typeSet) {
			coveredTypes.add(typeName);
		}
	}

	// Add a chunk for each merged group
	for (const [groupName, groupTypes] of mergedGroups.entries()) {
		let groupChunk = `// Logical group for ${groupName} and related types\n\n`;

		for (const typeName of groupTypes) {
			const typeInfo = types.get(typeName);
			if (typeInfo) {
				groupChunk += `${typeInfo.content}\n\n`;
			}
		}

		chunks.push(groupChunk.trim());
	}

	// Add any types that weren't in a relationship group
	const miscChunk = Array.from(types.entries())
		.filter(([typeName]) => !coveredTypes.has(typeName))
		.map(([_, typeInfo]) => typeInfo.content)
		.join("\n\n");

	if (miscChunk) {
		chunks.push(`// Miscellaneous types\n\n${miscChunk}`);
	}

	logger.info(`Created ${chunks.length} logical chunks from types.`);
	return chunks;
}

/**
 * Generates GraphQL types and embeds them into the vector database using ContentProcessor.
 * @param pgConnectionString - The connection string for the PostgreSQL database.
 * @param config - The loaded configuration.
 */
async function embedGraphqlTypes(pgConnectionString: string, config: Config) {
	const graphqlEndpoint = config.graphql.endpoint;
	const collectionName = config.graphql.collection_prefix;
	const headers = config.graphql.headers;

	logger.info(`Starting GraphQL type embedding from: ${graphqlEndpoint}`);

	// Instantiate the ContentProcessor
	const processor = new ContentProcessor(pgConnectionString, collectionName, {
		embeddingModel: DEFAULT_EMBEDDING_MODEL,
		dimension: DEFAULT_EMBEDDING_DIMENSION,
	});

	// Generate the TypeScript types string
	const generatedTypes = await generateRemoteTypes(graphqlEndpoint, headers);

	if (!generatedTypes || generatedTypes.trim().length === 0) {
		logger.warn("Generated types string is empty. Skipping embedding.");
		return;
	}

	// Chunk the generated types with logical relationships preserved
	const typeChunks = chunkGeneratedTypesWithRelationships(generatedTypes);

	if (typeChunks.length === 0) {
		logger.warn("No type chunks found after analysis. Skipping embedding.");
		return;
	}

	debugger;
	// Prepare items for the ContentProcessor
	const itemsToEmbed: ProcessableItem[] = typeChunks.map(
		(chunkContent, index) => {
			// Try to extract a meaningful title from the chunk
			const groupMatch = chunkContent.match(/\/\/ Logical group for (\w+)/);
			const titleMatch = chunkContent.match(
				/export\s+(?:type|interface|enum|const)\s+(\w+)/,
			);

			const title = groupMatch
				? `${groupMatch[1]} Type Group`
				: titleMatch
					? `${titleMatch[1]} and Related Types`
					: `Type Group ${index + 1}`;

			return {
				content: chunkContent,
				metadata: {
					title: title,
					content: chunkContent,
					// Add additional metadata for search enhancement
					isGraphQLType: true,
					containsEntityTypes:
						chunkContent.includes("interface") ||
						(chunkContent.includes("type") &&
							!chunkContent.includes("BoolExp")),
					containsFilterTypes: chunkContent.includes("BoolExp"),
					containsOrderTypes: chunkContent.includes("OrderBy"),
				},
			};
		},
	);

	try {
		logger.info(
			`Processing and embedding ${itemsToEmbed.length} logical type groups...`,
		);

		// Use the processor to handle embedding and upserting
		await processor.processAndEmbedBatch(itemsToEmbed);

		logger.info(
			`Embedding completed successfully for types from: ${graphqlEndpoint}`,
		);
	} catch (error) {
		logger.error(
			`Failed to embed types into collection ${collectionName}: ${error}`,
		);
		// Re-throw the error to be caught by the main execution block
		throw error;
	}
}

/**
 * Main execution function.
 */
async function main() {
	let config: Config;
	try {
		const configArg = process.argv.find((arg) => arg.startsWith("--config="));
		const configPath = configArg
			? configArg.split("=")[1]
			: DEFAULT_CONFIG_PATH;

		const resolvedConfigPath = path.isAbsolute(configPath)
			? configPath
			: path.resolve(process.cwd(), configPath);

		logger.info(`Resolved config path: ${resolvedConfigPath}`);
		config = loadConfig(resolvedConfigPath);
	} catch (error) {
		logger.error(
			`Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}

	if (!process.env.POSTGRES_URL) {
		logger.error("Missing required environment variable: POSTGRES_URL");
		process.exit(1);
	}
	const pgConnectionString = process.env.POSTGRES_URL;

	// Allow overriding config via command line arguments
	const endpointArg = process.argv.find((arg) => arg.startsWith("--endpoint="));
	const prefixArg = process.argv.find((arg) => arg.startsWith("--prefix="));

	if (endpointArg) {
		config.graphql.endpoint = endpointArg.split("=")[1];
		logger.info(
			`Overriding endpoint from command line: ${config.graphql.endpoint}`,
		);
	}
	if (prefixArg) {
		config.graphql.collection_prefix = prefixArg.split("=")[1];
		logger.info(
			`Overriding collection prefix from command line: ${config.graphql.collection_prefix}`,
		);
	}

	// Final check after potential overrides
	if (!config.graphql.endpoint || !config.graphql.collection_prefix) {
		logger.error(
			"One or more required GraphQL configuration values are missing after loading/overriding.",
		);
		process.exit(1);
	}

	try {
		logger.info(
			`Starting GraphQL type embedding for endpoint: ${config.graphql.endpoint}`,
		);
		await embedGraphqlTypes(pgConnectionString, config);
		logger.info(
			`GraphQL type embedding finished successfully for ${config.graphql.endpoint}.`,
		);
	} catch (error) {
		logger.error(
			`GraphQL type embedding failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Unhandled error in main:", err);
	process.exit(1);
});
