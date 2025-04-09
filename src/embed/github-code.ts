import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import * as toml from "toml";
import { embedSingleString } from "./content-processor";
import { logger } from "./utils";

/**
 * Configuration interface for the script
 */
interface Config {
	postgresql: {
		connectionString: string;
		indexName: string;
	};
	github: {
		files: string[];
	};
	embedding: {
		chunkMaxLines?: number;
		chunkByFunctions?: boolean;
	};
}

/**
 * Read and parse the TOML configuration file
 * @param filePath Path to the TOML configuration file
 * @returns Parsed configuration object
 */
function readConfig(filePath: string): Config {
	try {
		const fileContent = fs.readFileSync(filePath, "utf-8");
		const config = toml.parse(fileContent) as Config;

		// Set defaults for optional properties
		if (!config.embedding) {
			config.embedding = {};
		}
		if (config.embedding.chunkMaxLines === undefined) {
			config.embedding.chunkMaxLines = 20;
		}
		if (config.embedding.chunkByFunctions === undefined) {
			config.embedding.chunkByFunctions = true;
		}

		return config;
	} catch (error) {
		logger.error(`Error reading or parsing config file: ${error}`);
		process.exit(1);
	}
}

/**
 * Fetch content from a GitHub raw URL
 * @param url GitHub raw URL
 * @returns File content as string
 */
async function fetchGitHubFile(url: string): Promise<string> {
	try {
		logger.info(`Fetching file from: ${url}`);
		const response = await axios.get(url);
		return response.data;
	} catch (error) {
		logger.error(`Error fetching file from ${url}: ${error}`);
		return "";
	}
}

/**
 * Split Solidity content by function definitions, events, structs, mappings, and other declaration types
 * @param content Solidity file content
 * @returns Array of chunks containing code elements with their documentation
 */
function splitSolidityByFunctions(content: string): string[] {
	// Regular expression patterns for different Solidity elements
	const patterns = [
		// Function definitions with their associated comments
		/(\/\/\/[\s\S]+?function\s+\w+\s*\([^)]*\)[\s\S]*?(?:\{[\s\S]*?\}|;))/g,

		// Events with their associated comments
		/(\/\/\/[\s\S]+?event\s+\w+\s*\([^)]*\)[\s\S]*?;)/g,

		// Structs with their associated comments
		/(\/\/\/[\s\S]+?struct\s+\w+\s*\{[\s\S]*?\})/g,

		// Public/external mappings with their associated comments
		/(\/\/\/[\s\S]+?mapping\s*\([^)]+\)\s*(?:public|external|internal|private)?\s+\w+\s*;)/g,

		// State variables with visibility and their associated comments
		/(\/\/\/[\s\S]+?(?:uint|int|address|bool|string|bytes)(?:\d*)?(?:\[\])?\s+(?:public|external|internal|private)?\s+\w+\s*(?:=\s*[^;]+)?\s*;)/g,
	];

	// Collect all matches from different patterns
	const allMatches: string[] = [];
	for (const pattern of patterns) {
		const matches = content.match(pattern);
		if (matches) {
			allMatches.push(...matches);
		}
	}

	// Sort matches by their position in the original content to maintain order
	const positionMap = new Map<string, number>();
	for (const match of allMatches) {
		positionMap.set(match, content.indexOf(match));
	}

	const sortedMatches = [...allMatches].sort((a, b) => {
		return (positionMap.get(a) || 0) - (positionMap.get(b) || 0);
	});

	if (sortedMatches.length === 0) {
		// If no elements found with the main patterns, try some alternative patterns

		// Interface method definitions (without implementations)
		const interfaceMethodPattern =
			/(\/\/\/[\s\S]+?function\s+\w+\s*\([^)]*\)[^;]*;)/g;
		const interfaceMatches = content.match(interfaceMethodPattern);

		if (interfaceMatches && interfaceMatches.length > 0) {
			return interfaceMatches;
		}

		// Plain mappings without NatSpec but with potential inline comments
		const plainMappingPattern =
			/((?:\/\/[^\n]*\n)*\s*mapping\s*\([^)]+\)\s*(?:public|external|internal|private)?\s+\w+\s*;)/g;
		const mappingMatches = content.match(plainMappingPattern);

		if (mappingMatches && mappingMatches.length > 0) {
			return mappingMatches;
		}

		// Look for any NatSpec comment blocks (even without specific elements)
		const commentBlockPattern = /(\/\/\/[\s\S]+?)(?=\/\/\/|$)/g;
		const commentMatches = content.match(commentBlockPattern);

		if (commentMatches && commentMatches.length > 0) {
			return commentMatches;
		}

		// Special case for sections with header comments (like "/// === Events ===")
		const sectionPattern = /(\/\/\/\s*=+[\s\S]+?)(?=\/\/\/\s*=+|$)/g;
		const sectionMatches = content.match(sectionPattern);

		if (sectionMatches && sectionMatches.length > 0) {
			return sectionMatches;
		}

		// Last resort: split by line groups
		logger.warn(
			"No suitable code elements or comment blocks found in Solidity file. Falling back to line-based splitting.",
		);
		return splitByLines(content, 20);
	}

	return sortedMatches;
}

/**
 * Split typescript/javascript content by function or class definitions
 * @param content TypeScript/JavaScript file content
 * @returns Array of chunks containing function/class definitions with comments
 */
function splitJavaScriptByFunctions(content: string): string[] {
	// Match functions, methods, and classes with their JSDoc comments
	const patterns = [
		// JSDoc + function/method definition
		/(\/\*\*[\s\S]*?\*\/\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*\{[\s\S]*?\})/g,
		// JSDoc + arrow function with block body
		/(\/\*\*[\s\S]*?\*\/\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{[\s\S]*?\})/g,
		// JSDoc + class definition
		/(\/\*\*[\s\S]*?\*\/\s*(?:export\s+)?class\s+\w+[\s\S]*?\})/g,
		// JSDoc + class method
		/(\/\*\*[\s\S]*?\*\/\s*(?:async\s+)?[\w]+\s*\([^)]*\)\s*\{[\s\S]*?\})/g,
		// JSDoc + interface or type definition
		/(\/\*\*[\s\S]*?\*\/\s*(?:export\s+)?(?:interface|type)\s+\w+[\s\S]*?(?:\}|;))/g,
	];

	// Collect all matches from different patterns
	const allMatches: string[] = [];
	for (const pattern of patterns) {
		const matches = content.match(pattern);
		if (matches) {
			allMatches.push(...matches);
		}
	}

	// Sort matches by their position in the original string
	// This preserves the original order of functions/classes
	const positionMap = new Map<string, number>();
	for (const match of allMatches) {
		positionMap.set(match, content.indexOf(match));
	}

	const sortedMatches = [...allMatches].sort((a, b) => {
		return (positionMap.get(a) || 0) - (positionMap.get(b) || 0);
	});

	if (sortedMatches.length === 0) {
		// If no matches found, try simpler patterns without JSDoc
		const simpleFunctionPattern =
			/(?:export\s+)?(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*\{[\s\S]*?\}/g;
		const simpleClassPattern = /(?:export\s+)?class\s+\w+[\s\S]*?\}/g;

		const simpleFunctions = content.match(simpleFunctionPattern) || [];
		const simpleClasses = content.match(simpleClassPattern) || [];

		if (simpleFunctions.length > 0 || simpleClasses.length > 0) {
			return [...simpleFunctions, ...simpleClasses].sort((a, b) => {
				return content.indexOf(a) - content.indexOf(b);
			});
		}

		// Last resort: split by line groups
		logger.warn(
			"No function or class definitions found in JavaScript/TypeScript file. Falling back to line-based splitting.",
		);
		return splitByLines(content, 20);
	}

	return sortedMatches;
}

/**
 * Split content by lines
 * @param content File content
 * @param maxLines Maximum number of lines per chunk
 * @returns Array of content chunks
 */
function splitByLines(content: string, maxLines: number): string[] {
	const lines = content.split("\n");
	const chunks: string[] = [];

	for (let i = 0; i < lines.length; i += maxLines) {
		const chunk = lines.slice(i, i + maxLines).join("\n");
		if (chunk.trim()) {
			chunks.push(chunk);
		}
	}

	return chunks;
}

/**
 * Add metadata to a chunk of code
 * @param chunk Code chunk
 * @param fileUrl Source file URL
 * @param index Chunk index
 * @returns Chunk with metadata
 */
function addMetadataToChunk(
	chunk: string,
	fileUrl: string,
	index: number,
): string {
	// Extract filename from URL
	const filename = fileUrl.split("/").pop() || "unknown";

	// Analyze chunk to identify content type
	let chunkType = "code";
	if (chunk.trim().startsWith("///")) {
		chunkType = "documented_code";
	}

	// Try to extract element name and type
	let elementName = "unknown";
	let elementType = "unknown";

	// Check for different Solidity elements
	const functionMatch = chunk.match(/function\s+(\w+)/);
	const eventMatch = chunk.match(/event\s+(\w+)/);
	const structMatch = chunk.match(/struct\s+(\w+)/);
	const mappingMatch = chunk.match(
		/mapping\s*\([^)]+\)\s*(?:public|external|internal|private)?\s+(\w+)/,
	);
	const stateVarMatch = chunk.match(
		/(?:uint|int|address|bool|string|bytes)(?:\d*)?(?:\[\])?\s+(?:public|external|internal|private)?\s+(\w+)/,
	);

	if (functionMatch?.[1]) {
		elementName = functionMatch[1];
		elementType = "function";
	} else if (eventMatch?.[1]) {
		elementName = eventMatch[1];
		elementType = "event";
	} else if (structMatch?.[1]) {
		elementName = structMatch[1];
		elementType = "struct";
	} else if (mappingMatch?.[1]) {
		elementName = mappingMatch[1];
		elementType = "mapping";
	} else if (stateVarMatch?.[1]) {
		elementName = stateVarMatch[1];
		elementType = "state_variable";
	}

	// Create metadata
	const metadata = `Source: ${fileUrl}
  File: ${filename}
  Chunk: ${index + 1}
  Type: ${chunkType}
  Element: ${elementType}
  Name: ${elementName}
  ---
  
  `;

	return metadata + chunk;
}

/**
 * Process a single file and embed its chunks
 * @param fileUrl GitHub raw URL
 * @param pgConnectionString PostgreSQL connection string
 * @param indexName Vector index name
 * @param config Embedding configuration
 * @returns Number of chunks successfully embedded
 */
async function processFile(
	fileUrl: string,
	pgConnectionString: string,
	indexName: string,
	config: {
		chunkMaxLines?: number;
		chunkByFunctions?: boolean;
	},
): Promise<number> {
	// Fetch file content
	const content = await fetchGitHubFile(fileUrl);

	if (!content) {
		logger.warn(`Skipping empty or failed file: ${fileUrl}`);
		return 0;
	}

	logger.info(`Processing file: ${fileUrl} (${content.length} characters)`);

	// Determine file type and choose appropriate splitting method
	const fileExtension = path.extname(fileUrl).toLowerCase();
	let chunks: string[];

	if (config.chunkByFunctions) {
		if ([".sol", ".solidity"].includes(fileExtension)) {
			chunks = splitSolidityByFunctions(content);
		} else if ([".ts", ".js", ".tsx", ".jsx"].includes(fileExtension)) {
			chunks = splitJavaScriptByFunctions(content);
		} else {
			// For other file types, use simple line-based splitting
			chunks = splitByLines(content, config.chunkMaxLines || 20);
		}
	} else {
		// If chunk-by-functions is disabled, always use line-based splitting
		chunks = splitByLines(content, config.chunkMaxLines || 20);
	}

	logger.info(`File split into ${chunks.length} chunks`);

	// Process each chunk
	let successCount = 0;

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];

		// Add source and metadata to the chunk
		const chunkWithMetadata = addMetadataToChunk(chunk, fileUrl, i);

		logger.info(
			`Embedding chunk ${i + 1}/${chunks.length} (${chunk.length} characters)`,
		);

		// Embed the chunk
		const success = await embedSingleString(
			pgConnectionString,
			indexName,
			chunkWithMetadata,
		);

		if (success) {
			successCount++;
		}
	}

	logger.info(
		`Successfully embedded ${successCount}/${chunks.length} chunks for ${fileUrl}`,
	);
	return successCount;
}

async function embedContent() {
	try {
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = path.dirname(__filename);
		const configPath = path.resolve(__dirname, "config/allo-contracts.toml");
		const config = readConfig(configPath);

		logger.info("GitHub Code Embedder Example");
		logger.info(`Using configuration from: ${configPath}`);

		// Check if there are files to process
		if (!config.github.files.length) {
			logger.error("No GitHub files specified in the configuration");
			return;
		}

		logger.info(`Will process ${config.github.files.length} files:`);
		config.github.files.forEach((file, index) => {
			logger.info(`  ${index + 1}. ${file}`);
		});

		const connectionString = process.env.POSTGRES_URL;
		if (!connectionString) {
			logger.error(
				"POSTGRES_URL environment variable is not set. Please set it to use the PostgreSQL vector database.",
			);
			return;
		}

		const files = config.github.files;
		if (!files || files.length === 0) {
			logger.error("No files specified in the configuration.");
			return;
		}

		for (const file of files) {
			// Process a single file as an example
			logger.info(`\nProcessing file: ${file}`);

			const successCount = await processFile(
				file,
				connectionString,
				config.postgresql.indexName,
				config.embedding,
			);

			logger.info("\nProcessing complete!");
			logger.info(`Successfully embedded ${successCount} chunks from ${file}`);
		}

		// Instructions for processing all files
		logger.info("\nTo process all files listed in the configuration:");
	} catch (error) {
		logger.error(`Error running example: ${error}`);
	}
}
embedContent();
