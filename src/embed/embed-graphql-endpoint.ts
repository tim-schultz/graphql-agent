import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { openai } from "@ai-sdk/openai";
import { PgVector } from "@mastra/pg"; // Import PgVector
import { embedMany } from "ai"; // Import embedMany
import {
	type DefinitionNode,
	type DocumentNode,
	type IntrospectionQuery,
	Kind,
	buildClientSchema,
	getIntrospectionQuery,
	parse,
	print,
	printSchema,
} from "graphql";
import * as toml from "toml"; // Import toml parser
import { logger } from "./utils";

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default configuration path relative to the current file
const DEFAULT_CONFIG_PATH = path.join(
	__dirname,
	"graphql-endpoint-config.toml",
);

// Assuming a default embedding model and dimension, adjust as needed
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSION = 1536;

/**
 * Structure for the configuration loaded from TOML
 */
interface Config {
	graphql: {
		endpoint: string;
		collection_prefix: string;
	};
}

/**
 * Loads configuration from a TOML file.
 * @param configPath Path to the TOML configuration file.
 * @returns The loaded configuration object.
 * @throws Error if the configuration file is not found or cannot be parsed.
 */
function loadConfig(configPath: string): Config {
	logger.info(`Loading configuration from ${configPath}`);
	try {
		const fileContent = fs.readFileSync(configPath, "utf-8");
		const config = toml.parse(fileContent);

		// Basic validation
		if (!config?.graphql?.endpoint || !config?.graphql?.collection_prefix) {
			throw new Error(
				"Configuration file is missing required fields (graphql.endpoint, graphql.collection_prefix)",
			);
		}

		// Type assertion for cleaner access later
		return config as Config;
	} catch (error: unknown) {
		// Use type guard or check properties to narrow down 'unknown'
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

/** Defines the structure for separated parts of a GraphQL schema. */
interface SchemaChunks {
	/** Chunk containing the schema definition block(s) */
	schemaDefinitions: string[];
	/** Chunk containing all scalar type definitions */
	scalarDefinitions: string[];
	/** Chunk containing all directive definitions */
	directiveDefinitions: string[];
	/** Chunk containing object type definitions (i.e. "type" blocks) */
	objectTypeDefinitions: string[];
	/** Chunk containing input type definitions */
	inputObjectDefinitions: string[];
	/** Chunk containing enum definitions */
	enumTypeDefinitions: string[];
	/** Chunk containing interface type definitions */
	interfaceTypeDefinitions: string[];
	/** Chunk containing union type definitions */
	unionTypeDefinitions: string[];
	/** Chunk for any definitions that do not fall in the previous categories */
	others: string[];
}

/**
 * Splits a printed GraphQL schema (in SDL format) into logical chunks.
 *
 * @param sdl - The full schema as a string.
 * @returns An object containing the separated schema chunks.
 * @throws Throws an error if the SDL parsing fails.
 */
function splitSchemaIntoChunks(sdl: string): SchemaChunks {
	let ast: DocumentNode;
	try {
		ast = parse(sdl);
	} catch (error) {
		logger.error(`SDL Parsing Error: ${error}`);
		throw new Error(
			`Failed to parse the SDL. Please check the schema format. Error: ${error}`,
		);
	}

	const schemaDefs: DefinitionNode[] = [];
	const scalarDefs: DefinitionNode[] = [];
	const directiveDefs: DefinitionNode[] = [];
	const objectTypeDefs: DefinitionNode[] = [];
	const inputObjectDefs: DefinitionNode[] = [];
	const enumTypeDefs: DefinitionNode[] = [];
	const interfaceDefs: DefinitionNode[] = [];
	const unionDefs: DefinitionNode[] = [];
	const otherDefs: DefinitionNode[] = [];

	for (const def of ast.definitions) {
		switch (def.kind) {
			case Kind.SCHEMA_DEFINITION:
				schemaDefs.push(def);
				break;
			case Kind.SCALAR_TYPE_DEFINITION:
				scalarDefs.push(def);
				break;
			case Kind.DIRECTIVE_DEFINITION:
				directiveDefs.push(def);
				break;
			case Kind.OBJECT_TYPE_DEFINITION:
				objectTypeDefs.push(def);
				break;
			case Kind.INPUT_OBJECT_TYPE_DEFINITION:
				inputObjectDefs.push(def);
				break;
			case Kind.ENUM_TYPE_DEFINITION:
				enumTypeDefs.push(def);
				break;
			case Kind.INTERFACE_TYPE_DEFINITION:
				interfaceDefs.push(def);
				break;
			case Kind.UNION_TYPE_DEFINITION:
				unionDefs.push(def);
				break;
			// Handle extensions and other kinds
			case Kind.OBJECT_TYPE_EXTENSION:
			case Kind.INTERFACE_TYPE_EXTENSION:
			case Kind.ENUM_TYPE_EXTENSION:
			case Kind.UNION_TYPE_EXTENSION:
			case Kind.INPUT_OBJECT_TYPE_EXTENSION:
			case Kind.SCALAR_TYPE_EXTENSION:
			case Kind.SCHEMA_EXTENSION:
				// Add extensions to 'others' or handle them specifically if needed
				otherDefs.push(def);
				break;
			default:
				// Catch-all for other definition kinds (e.g., OperationDefinition, FragmentDefinition)
				// These are usually not part of the schema definition itself but might appear if parsing full documents
				otherDefs.push(def);
				logger.warn(
					`Unhandled or non-schema definition kind encountered: ${def.kind}`,
				);
				break;
		}
	}

	// Convert each array of AST nodes back into an SDL string
	return {
		schemaDefinitions: schemaDefs.map(print),
		scalarDefinitions: scalarDefs.map(print),
		directiveDefinitions: directiveDefs.map(print),
		objectTypeDefinitions: objectTypeDefs.map(print),
		inputObjectDefinitions: inputObjectDefs.map(print),
		enumTypeDefinitions: enumTypeDefs.map(print),
		interfaceTypeDefinitions: interfaceDefs.map(print),
		unionTypeDefinitions: unionDefs.map(print),
		others: otherDefs.map(print),
	};
}

/**
 * Fetches, parses, chunks, and embeds a GraphQL schema from a given endpoint.
 * Each type of definition (Object, Scalar, Enum, etc.) is embedded into its own collection.
 * @param pgConnectionString - The PostgreSQL connection string.
 * @param config - The loaded configuration containing endpoint and prefix.
 */
async function embedGraphqlEndpoint(
	pgConnectionString: string,
	config: Config,
) {
	const graphqlEndpoint = config.graphql.endpoint;
	const collectionPrefix = config.graphql.collection_prefix;

	logger.info(`Starting schema analysis for endpoint: ${graphqlEndpoint}`);

	// Initialize PgVector
	const pgVector = new PgVector(pgConnectionString);

	// 1. Fetch Introspection Schema
	let introspectionData: IntrospectionQuery;
	try {
		logger.info("Fetching introspection query results...");
		const response = await fetch(graphqlEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: getIntrospectionQuery() }),
		});

		if (!response.ok) {
			throw new Error(
				`HTTP error fetching schema: ${response.status} ${response.statusText}`,
			);
		}
		const responseJson = await response.json();
		if (responseJson.errors) {
			throw new Error(
				`GraphQL introspection query errors: ${JSON.stringify(responseJson.errors)}`,
			);
		}
		introspectionData = responseJson.data;
		logger.info("Introspection query successful.");
	} catch (error) {
		logger.error(`Failed to fetch or parse introspection schema: ${error}`);
		throw new Error(`Failed to fetch introspection schema: ${error}`); // Propagate error
	}

	// 2. Build and Print Schema from Introspection Data
	const schema = buildClientSchema(introspectionData);
	const printedSchema = printSchema(schema);
	logger.info(
		`Schema built successfully. Total SDL length: ${printedSchema.length}`,
	);

	// 3. Split Schema into Logical Chunks
	logger.info("Splitting schema into logical chunks...");
	const chunks = splitSchemaIntoChunks(printedSchema);

	// 4. Embed each chunk type into its own collection
	logger.info("Embedding schema chunks...");
	for (const [chunkKey, definitions] of Object.entries(chunks)) {
		if (definitions.length === 0) {
			logger.debug(`Skipping empty chunk: ${chunkKey}`);
			continue;
		}

		// Sanitize chunkKey for collection name (e.g., objectTypeDefinitions -> object_type_definitions)
		const collectionNameSuffix = chunkKey
			.replace(/([A-Z])/g, "_$1")
			.toLowerCase();
		const collectionName = `${collectionPrefix}_${collectionNameSuffix}`;

		logger.info(
			`Embedding ${definitions.length} definitions from ${chunkKey} into collection: ${collectionName}`,
		);

		try {
			// Ensure index exists for this collection
			await pgVector.createIndex({
				indexName: collectionName,
				dimension: DEFAULT_EMBEDDING_DIMENSION,
			}); // No-op if exists

			// Prepare documents and generate embeddings
			logger.info(
				`Generating embeddings for ${definitions.length} definitions...`,
			);
			const { embeddings } = await embedMany({
				model: openai.embedding(DEFAULT_EMBEDDING_MODEL),
				values: definitions,
			});

			if (!embeddings || embeddings.length !== definitions.length) {
				throw new Error(
					`Embedding generation failed or returned incorrect count for ${chunkKey}`,
				);
			}

			// Prepare metadata for each embedding
			const metadata = definitions.map((content: string) => ({
				text: content, // Include original text in metadata if desired
				source: graphqlEndpoint,
				type: chunkKey,
			}));

			// Upsert embeddings and metadata
			logger.info(
				`Storing ${embeddings.length} vectors in ${collectionName}...`,
			);
			await pgVector.upsert({
				indexName: collectionName,
				vectors: embeddings,
				metadata: metadata,
			});

			logger.info(`Successfully embedded ${chunkKey} definitions.`);
		} catch (error) {
			logger.error(
				`Failed to embed chunk ${chunkKey} into collection ${collectionName}: ${error}`,
			);
			// Decide if you want to stop the whole process or continue with other chunks
			// Consider logging the specific definition that failed if possible
			// throw error; // Uncomment to stop on first embedding error
		}
	}

	logger.info(
		`Finished embedding schema from endpoint: ${graphqlEndpoint} with prefix: ${collectionPrefix}`,
	);
}

// --- Main Execution ---

async function main() {
	// Configuration - Load from TOML file
	let config: Config;
	try {
		// Allow overriding config path via command line argument, e.g., --config=./my-config.toml
		const configArg = process.argv.find((arg) => arg.startsWith("--config="));
		const configPath = configArg
			? configArg.split("=")[1]
			: DEFAULT_CONFIG_PATH;

		// Fix path if it starts with a dot
		const resolvedConfigPath = configPath.startsWith(".")
			? path.resolve(process.cwd(), configPath.substring(1))
			: configPath;

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

	// Optionally allow overriding config values via args (e.g., --endpoint=..., --prefix=...)
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

	// Basic validation of loaded config
	if (!config.graphql.endpoint || !config.graphql.collection_prefix) {
		logger.error(
			"One or more required GraphQL configuration values are missing after loading/overriding.",
		);
		process.exit(1);
	}

	// Run the embedding process
	try {
		logger.info(
			`Starting GraphQL schema embedding for: ${config.graphql.endpoint}`,
		);
		await embedGraphqlEndpoint(pgConnectionString, config);
		logger.info(
			`GraphQL schema embedding finished successfully for ${config.graphql.endpoint}.`,
		);
	} catch (error) {
		logger.error(
			`GraphQL schema embedding failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}

// Run the script
main().catch((err) => {
	console.error("Unhandled error in main:", err);
	process.exit(1);
});
