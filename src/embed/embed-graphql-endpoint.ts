import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { openai } from "@ai-sdk/openai";
import { PgVector } from "@mastra/pg";
import { embedMany } from "ai";
import {
	type DefinitionNode,
	type DocumentNode,
	Kind,
	type TypeNode,
	buildClientSchema,
	getIntrospectionQuery,
	parse,
	print,
	printSchema,
} from "graphql";
import * as toml from "toml";
import { logger } from "./utils";

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default configuration path relative to the current file
const DEFAULT_CONFIG_PATH = path.join(__dirname, "config/gitcoin-gql.toml");

// Assuming a default embedding model and dimension, adjust as needed
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSION = 1536;
const MAX_CHUNK_LENGTH = 1000;

interface Config {
	graphql: {
		endpoint: string;
		collection_prefix: string;
	};
}

interface SchemaChunk {
	title: string;
	content: string;
}

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

async function fetchSchema(endpoint: string): Promise<string> {
	logger.info(`Fetching introspection query results from ${endpoint}...`);
	try {
		const response = await fetch(endpoint, {
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
		if (!responseJson.data) {
			throw new Error("No data returned from introspection query.");
		}

		const schema = buildClientSchema(responseJson.data);
		const printedSchema = printSchema(schema);
		logger.info(
			`Schema built successfully. Total SDL length: ${printedSchema.length}`,
		);
		return printedSchema;
	} catch (error) {
		logger.error(`Failed to fetch or process introspection schema: ${error}`);
		if (error instanceof Error) {
			throw new Error(`Failed to fetch introspection schema: ${error.message}`);
		}
		throw new Error(
			`An unknown error occurred while fetching introspection schema: ${String(error)}`,
		);
	}
}

function chunkSchemaForLLM(schemaSDL: string): SchemaChunk[] {
	let ast: DocumentNode;
	try {
		ast = parse(schemaSDL);
	} catch (error) {
		logger.error(`SDL Parsing Error: ${error}`);
		throw new Error(
			`Failed to parse the SDL. Please check the schema format. Error: ${error}`,
		);
	}

	const chunks: SchemaChunk[] = [];

	const getName = (d: DefinitionNode): string | undefined => {
		return "name" in d && d.name ? d.name.value : undefined;
	};

	for (const def of ast.definitions) {
		let chunkTitle = "";
		let definitionName = "";

		switch (def.kind) {
			case Kind.OBJECT_TYPE_DEFINITION:
			case Kind.OBJECT_TYPE_EXTENSION:
				definitionName = getName(def) || "Unnamed Object";
				chunkTitle = `Type: ${definitionName}`;
				break;
			case Kind.ENUM_TYPE_DEFINITION:
			case Kind.ENUM_TYPE_EXTENSION:
				definitionName = getName(def) || "Unnamed Enum";
				chunkTitle = `Enum: ${definitionName}`;
				break;
			case Kind.INPUT_OBJECT_TYPE_DEFINITION:
			case Kind.INPUT_OBJECT_TYPE_EXTENSION:
				definitionName = getName(def) || "Unnamed Input";
				chunkTitle = `Input: ${definitionName}`;
				break;
			case Kind.INTERFACE_TYPE_DEFINITION:
			case Kind.INTERFACE_TYPE_EXTENSION:
				definitionName = getName(def) || "Unnamed Interface";
				chunkTitle = `Interface: ${definitionName}`;
				break;
			case Kind.UNION_TYPE_DEFINITION:
			case Kind.UNION_TYPE_EXTENSION:
				definitionName = getName(def) || "Unnamed Union";
				chunkTitle = `Union: ${definitionName}`;
				break;
			case Kind.DIRECTIVE_DEFINITION:
				definitionName = getName(def) || "Unnamed Directive";
				chunkTitle = `Directive: @${definitionName}`;
				break;
			case Kind.SCALAR_TYPE_DEFINITION:
			case Kind.SCALAR_TYPE_EXTENSION:
				definitionName = getName(def) || "Unnamed Scalar";
				chunkTitle = `Scalar: ${definitionName}`;
				break;
			case Kind.SCHEMA_DEFINITION:
			case Kind.SCHEMA_EXTENSION:
				chunkTitle = "Schema Definition/Extension";
				break;
			default:
				chunkTitle = `Other Definition: ${def.kind}`;
				logger.warn(
					`Unhandled or non-schema definition kind encountered: ${def.kind}`,
				);
		}

		chunks.push({
			title: chunkTitle,
			content: print(def).trim(),
		});
	}

	return chunks;
}

function furtherChunkLargeDefinitions(
	chunk: SchemaChunk,
	maxLength = MAX_CHUNK_LENGTH,
): SchemaChunk[] {
	if (chunk.content.length <= maxLength) return [chunk];

	logger.debug(
		`Chunk "${chunk.title}" exceeds max length (${chunk.content.length} > ${maxLength}), splitting...`,
	);

	const lines = chunk.content.split("\n");
	const smallerChunks: SchemaChunk[] = [];
	let currentChunkLines: string[] = [];
	let currentLength = 0;
	let partNumber = 1;

	for (const line of lines) {
		const lineLength = line.length + 1;

		if (
			currentLength + lineLength > maxLength &&
			currentChunkLines.length > 0
		) {
			smallerChunks.push({
				title: `${chunk.title} (part ${partNumber})`,
				content: currentChunkLines.join("\n").trim(),
			});
			currentChunkLines = [line];
			currentLength = lineLength;
			partNumber++;
		} else {
			currentChunkLines.push(line);
			currentLength += lineLength;
		}
	}

	if (currentChunkLines.length > 0) {
		smallerChunks.push({
			title:
				partNumber === 1 ? chunk.title : `${chunk.title} (part ${partNumber})`,
			content: currentChunkLines.join("\n").trim(),
		});
	}

	logger.debug(
		`Split "${chunk.title}" into ${smallerChunks.length} smaller chunks.`,
	);
	return smallerChunks;
}

function getNamedTypeFromTypeNode(type: TypeNode): string | null {
	if (type.kind === "NamedType") {
		return type.name.value;
	}
	if ("type" in type) {
		return getNamedTypeFromTypeNode(type.type);
	}
	return null;
}

function extractRelationships(schemaSDL: string): Record<string, string[]> {
	const ast = parse(schemaSDL);
	const relationships: Record<string, string[]> = {};

	for (const def of ast.definitions) {
		if (def.kind === Kind.OBJECT_TYPE_DEFINITION) {
			const typeName = def.name.value;
			relationships[typeName] = [];

			for (const field of def.fields ?? []) {
				const namedType = getNamedTypeFromTypeNode(field.type);
				if (namedType && namedType !== typeName) {
					relationships[typeName].push(namedType);
				}
			}
		}
	}

	return relationships;
}

async function embedGraphqlEndpoint(
	pgConnectionString: string,
	config: Config,
) {
	const graphqlEndpoint = config.graphql.endpoint;
	const collectionName = config.graphql.collection_prefix;

	logger.info(`Starting schema embedding from: ${graphqlEndpoint}`);

	const pgVector = new PgVector(pgConnectionString);

	const schemaSDL = await fetchSchema(graphqlEndpoint);
	const typeRelationships = extractRelationships(schemaSDL);

	logger.info("Splitting schema into logical chunks...");
	const initialChunks = chunkSchemaForLLM(schemaSDL);

	logger.info("Checking for and splitting large chunks...");
	const finalChunks: SchemaChunk[] = [];
	for (const chunk of initialChunks) {
		const subChunks = furtherChunkLargeDefinitions(chunk, MAX_CHUNK_LENGTH);
		finalChunks.push(...subChunks);
	}
	logger.info(`Total final chunks to embed: ${finalChunks.length}`);

	try {
		await pgVector.createIndex({
			indexName: collectionName,
			dimension: DEFAULT_EMBEDDING_DIMENSION,
		});

		const contentsToEmbed = finalChunks.map((chunk) => chunk.content);
		logger.info(
			`Generating embeddings for ${contentsToEmbed.length} chunks...`,
		);
		const { embeddings } = await embedMany({
			model: openai.embedding(DEFAULT_EMBEDDING_MODEL),
			values: contentsToEmbed,
		});

		if (!embeddings || embeddings.length !== finalChunks.length) {
			throw new Error(
				`Embedding count mismatch: expected ${finalChunks.length}, got ${embeddings?.length ?? 0}`,
			);
		}

		const metadata = finalChunks
			.map((chunk) => {
				const typeMatch = chunk.title.match(/Type: (.+?)( \(part \d+\))?$/);
				const typeName = typeMatch ? typeMatch[1] : null;

				return {
					text: chunk.content,
					source: graphqlEndpoint,
					title: chunk.title,
					relatedEntities: typeName ? typeRelationships[typeName] || [] : [],
				};
			})
			.filter((chunk) => chunk.relatedEntities.length > 0);

		logger.info(`Storing ${embeddings.length} vectors in ${collectionName}...`);
		await pgVector.upsert({
			indexName: collectionName,
			vectors: embeddings,
			metadata,
		});

		logger.info(`Embedding completed successfully for: ${graphqlEndpoint}`);
	} catch (error) {
		logger.error(
			`Failed to embed chunks into collection ${collectionName}: ${error}`,
		);
		throw error;
	}
}

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

	if (!config.graphql.endpoint || !config.graphql.collection_prefix) {
		logger.error(
			"One or more required GraphQL configuration values are missing after loading/overriding.",
		);
		process.exit(1);
	}

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

main().catch((err) => {
	console.error("Unhandled error in main:", err);
	process.exit(1);
});
