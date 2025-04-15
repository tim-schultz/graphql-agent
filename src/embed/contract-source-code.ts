import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import * as toml from "toml";

import { ContentProcessor } from "./content-processor"; // Renamed import
import { logger, withTimeout } from "./utils";

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default configuration path relative to the current file
const DEFAULT_CONFIG_PATH = path.join(__dirname, "etherscan-config.toml");

/**
 * Structure for the configuration loaded from TOML
 */
interface Config {
	etherscan: {
		base_url: string;
		api_key: string;
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
		if (!config?.etherscan?.base_url || !config?.etherscan?.api_key) {
			throw new Error(
				"Configuration file is missing required fields (etherscan.base_url, etherscan.api_key)",
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

/**
 * Structure of the Etherscan API response for getsourcecode
 */
interface EtherscanSourceCodeResult {
	SourceCode: string | Record<string, { content: string }>; // Source code can be a single string or a JSON object for multi-file sources
	ABI: string;
	ContractName: string;
	CompilerVersion: string;
	OptimizationUsed: string;
	Runs: string;
	ConstructorArguments: string;
	EVMVersion: string;
	Library: string;
	LicenseType: string;
	Proxy: string;
	Implementation: string;
	SwarmSource: string;
}

interface EtherscanApiResponse {
	status: string;
	message: string;
	result: EtherscanSourceCodeResult[];
}

/**
 * Status of the embedding process
 */
interface EmbedStatus {
	contractAddress: string;
	status:
		| "idle"
		| "fetching"
		| "formatting"
		| "embedding"
		| "completed"
		| "error";
	error?: string;
	startTime?: number;
	chunksGenerated?: number;
	chunksStored?: number;
}

/**
 * EtherscanEmbedder class for fetching contract data and embedding it
 */
export class EtherscanEmbedder {
	private baseUrl: string;
	private apiKey: string;
	private contractAddress: string;
	private status: EmbedStatus;
	private client: AxiosInstance;
	private contentProcessor: ContentProcessor; // Renamed type

	/**
	 * Create a new EtherscanEmbedder
	 * @param baseUrl Base URL of the Etherscan-compatible API
	 * @param apiKey Etherscan API Key
	 * @param contractAddress The contract address to fetch data for
	 * @param pgConnectionString Database connection string
	 * @param indexName The name for the vector index in PostgreSQL
	 * @param options Additional options for the content processor
	 */
	constructor(
		baseUrl: string,
		apiKey: string,
		contractAddress: string,
		pgConnectionString: string,
		indexName: string,
		options: {
			chunkSize?: number;
			chunkOverlap?: number;
			embeddingModel?: string;
			dimension?: number;
		} = {},
	) {
		if (
			!baseUrl ||
			!apiKey ||
			!contractAddress ||
			!pgConnectionString ||
			!indexName
		) {
			throw new Error(
				"Missing required constructor parameters for EtherscanEmbedder.",
			);
		}
		this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
		this.apiKey = apiKey;
		this.contractAddress = contractAddress;
		this.status = {
			contractAddress: this.contractAddress,
			status: "idle",
		};
		this.client = axios.create({
			baseURL: this.baseUrl,
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; EtherscanEmbedder/1.0)",
			},
			timeout: 60000, // 60 seconds timeout
		});

		// Initialize the content processor
		this.contentProcessor = new ContentProcessor(
			// Renamed constructor call
			pgConnectionString,
			indexName,
			{
				chunkSize: options.chunkSize || 1500,
				chunkOverlap: options.chunkOverlap || 200,
				embeddingModel: options.embeddingModel || "text-embedding-3-small",
				dimension: options.dimension || 1536,
			},
		);
	}

	/**
	 * Main embedding method
	 */
	public async embedContract(): Promise<void> {
		try {
			this.status.startTime = Date.now();
			this.status.status = "fetching";
			logger.info(
				`Fetching contract data for ${this.contractAddress} from ${this.baseUrl}`,
			);

			const contractData = await this.fetchContractData(this.contractAddress);
			if (!contractData) {
				throw new Error(
					`Failed to fetch contract data for ${this.contractAddress}`,
				);
			}

			this.status.status = "formatting";
			logger.info(`Formatting contract data for ${contractData.ContractName}`);
			const formattedContent = this.formatContent(contractData);

			if (!formattedContent.trim()) {
				throw new Error("Formatted content is empty, cannot embed.");
			}

			this.status.status = "embedding";
			logger.info(
				`Starting embedding process for ${contractData.ContractName}`,
			);
			logger.debug(`Formatted Content Length: ${formattedContent.length}`);

			// Process and store the content using Mastra
			await this.contentProcessor.processAndStore(formattedContent, "text");

			const processStatus = this.contentProcessor.getStatus();
			this.status.chunksGenerated = processStatus.chunksGenerated;
			this.status.chunksStored = processStatus.chunksStored;
			this.status.status = "completed";
			logger.info(
				`Embedding completed for ${contractData.ContractName} (${this.contractAddress}). Stored ${processStatus.chunksStored} chunks.`,
			);
		} catch (e) {
			this.status.status = "error";
			this.status.error = e instanceof Error ? e.message : String(e);
			logger.error(
				`Embedding failed for ${this.contractAddress}: ${this.status.error}`,
			);
			throw e; // Re-throw the error
		}
	}

	/**
	 * Fetch contract source code and metadata from Etherscan API
	 * @param address The contract address
	 * @returns The contract source code result or null if failed
	 */
	private async fetchContractData(
		address: string,
	): Promise<EtherscanSourceCodeResult | null> {
		const params = {
			module: "contract",
			action: "getsourcecode",
			address: address,
			apikey: this.apiKey,
		};
		// Construct the full URL explicitly
		const queryString = new URLSearchParams(params).toString();
		const fullUrl = `${this.baseUrl}/api?${queryString}`;

		try {
			logger.debug(
				// Log the full URL, hiding the API key for security
				`Fetching from full URL: ${fullUrl.replace(this.apiKey, "...")}`,
			);
			const response: AxiosResponse<EtherscanApiResponse> = await withTimeout(
				// Pass the full URL directly to the client's get method
				this.client.get<EtherscanApiResponse>(fullUrl),
				this.client.defaults.timeout || 60000,
				`Timeout fetching contract data for ${address}`,
			);

			if (
				response.status === 200 &&
				response.data.status === "1" &&
				response.data.result?.length > 0
			) {
				logger.info(`Successfully fetched data for ${address}`);
				// Handle potential variations in source code format (string vs object)
				const result = response.data.result[0];
				if (
					typeof result.SourceCode === "string" &&
					result.SourceCode.startsWith("{") &&
					result.SourceCode.endsWith("}")
				) {
					try {
						// Attempt to parse if it looks like JSON (common for multi-file sources)
						const parsedSource = JSON.parse(result.SourceCode);
						if (parsedSource.sources) {
							// Standard Solidity JSON Input format
							result.SourceCode = parsedSource.sources;
						} else if (typeof parsedSource === "object") {
							// Other potential JSON structures
							result.SourceCode = parsedSource;
						}
						// If parsing fails or doesn't fit expected structures, leave as string
					} catch (parseError) {
						logger.debug(
							`Source code for ${address} looked like JSON but failed to parse. Treating as string.`,
						);
					}
				}
				return result;
			}
			logger.error(
				`Failed to fetch contract data for ${address}. API Status: ${response.data.status}, Message: ${response.data.message}`,
			);
			return null;
		} catch (e) {
			logger.error(
				`Error fetching contract data for ${address}: ${e instanceof Error ? e.message : String(e)}`,
			);
			if (axios.isAxiosError(e) && e.response) {
				logger.error(`API Response Status: ${e.response.status}`);
				logger.error(`API Response Data: ${JSON.stringify(e.response.data)}`);
			}
			return null;
		}
	}

	/**
	 * Format the contract data into a string suitable for embedding
	 * @param data The fetched contract data
	 * @returns A formatted string
	 */
	private formatContent(data: EtherscanSourceCodeResult): string {
		const parts: string[] = [];

		parts.push(`# Contract: ${data.ContractName || "Unnamed Contract"}`);
		parts.push(`Address: ${this.contractAddress}\n`); // Add the address context

		parts.push("## Metadata");
		parts.push(`- Compiler Version: ${data.CompilerVersion || "N/A"}`);
		parts.push(
			`- Optimization Used: ${data.OptimizationUsed === "1" ? "Yes" : "No"}`,
		);
		if (data.OptimizationUsed === "1") {
			parts.push(`- Runs: ${data.Runs || "N/A"}`);
		}
		parts.push(`- EVM Version: ${data.EVMVersion || "Default"}`);
		if (data.LicenseType && data.LicenseType !== "Unknown") {
			parts.push(`- License: ${data.LicenseType}`);
		}
		if (data.Proxy === "1") {
			parts.push("- Proxy: Yes");
			if (data.Implementation) {
				parts.push(`- Implementation Address: ${data.Implementation}`);
			}
		}
		parts.push("\n");

		if (data.SourceCode) {
			parts.push("## Source Code\n");
			if (typeof data.SourceCode === "string") {
				parts.push("```solidity");
				parts.push(data.SourceCode.trim());
				parts.push("```\n");
			} else if (typeof data.SourceCode === "object") {
				// Handle multi-file source code (JSON object)
				parts.push("This contract consists of multiple source files:\n");
				for (const [fileName, fileContent] of Object.entries(data.SourceCode)) {
					if (typeof fileContent === "object" && fileContent.content) {
						parts.push(`### File: ${fileName}\n`);
						parts.push("```solidity");
						parts.push(fileContent.content.trim());
						parts.push("```\n");
					} else {
						// Fallback for unexpected structures
						parts.push(`### File: ${fileName}\n`);
						parts.push("```json");
						parts.push(JSON.stringify(fileContent, null, 2));
						parts.push("```\n");
					}
				}
			}
		} else {
			parts.push(
				"## Source Code\n\nSource code not available or not verified.\n",
			);
		}

		if (data.ABI && data.ABI !== "Contract source code not verified") {
			parts.push("## ABI\n");
			parts.push("```json");
			try {
				// Prettify the JSON ABI string
				const parsedAbi = JSON.parse(data.ABI);
				parts.push(JSON.stringify(parsedAbi, null, 2));
			} catch (e) {
				logger.warn(
					`Could not parse ABI JSON for ${this.contractAddress}, embedding as raw string.`,
				);
				parts.push(data.ABI); // Fallback to raw string if parsing fails
			}
			parts.push("```\n");
		} else {
			parts.push("## ABI\n\nABI not available or contract not verified.\n");
		}

		if (data.ConstructorArguments) {
			parts.push("## Constructor Arguments (ABI-encoded)\n");
			parts.push("```");
			parts.push(data.ConstructorArguments);
			parts.push("```\n");
		}

		return parts.join("\n").trim();
	}

	/**
	 * Get the current status of the embedding process
	 * @returns The current status
	 */
	public getStatus(): EmbedStatus {
		const status = { ...this.status };
		if (
			this.status.startTime &&
			(this.status.status === "embedding" ||
				this.status.status === "completed" ||
				this.status.status === "error")
		) {
			const elapsed = Math.round((Date.now() - this.status.startTime) / 1000);
			Object.defineProperty(status, "elapsedTime", {
				enumerable: true,
				value: elapsed,
			});
		}
		// Include processor status if available
		if (this.contentProcessor) {
			const processorStatus = this.contentProcessor.getStatus();
			status.chunksGenerated = processorStatus.chunksGenerated;
			status.chunksStored = processorStatus.chunksStored;
		}
		return status;
	}
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

	const etherscanBaseUrl = config.etherscan.base_url;
	const etherscanApiKey = config.etherscan.api_key;
	const pgConnectionString = process.env.POSTGRES_URL;
	const indexName = "gitcoin_source_code";

	// Get contract address from command line arguments (excluding --config arg)
	const contractAddress = process.argv.find(
		(arg) =>
			!arg.startsWith("--") &&
			arg !== process.argv[0] &&
			arg !== process.argv[1],
	);

	if (!contractAddress) {
		logger.error(
			"Please provide the contract address as a command line argument.",
		);
		logger.info(
			"Usage: pnpm tsx src/embed/contract-source-code.ts <contract_address> [--config=path/to/config.toml]",
		);
		process.exit(1);
	}

	// Basic validation of loaded config (already done in loadConfig, but double-check)
	if (!etherscanBaseUrl || !etherscanApiKey || !pgConnectionString) {
		logger.error(
			"One or more required configuration values are missing after loading.",
		);
		process.exit(1);
	}

	// 1. Create Embedder Instance
	let embedder: EtherscanEmbedder;
	try {
		embedder = new EtherscanEmbedder(
			etherscanBaseUrl,
			etherscanApiKey,
			contractAddress,
			pgConnectionString,
			indexName,
			{
				chunkSize: 1500, // Characters per chunk
				chunkOverlap: 200, // Characters of overlap
				embeddingModel: "text-embedding-3-small", // OpenAI embedding model
				dimension: 1536, // Dimension size for text-embedding-3-small
			},
		);
	} catch (error) {
		logger.error(
			`Failed to initialize EtherscanEmbedder: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}

	// 2. Embed Contract
	try {
		logger.info(
			`Starting Etherscan embedding for contract: ${contractAddress}`,
		);
		await embedder.embedContract();
		const finalStatus = embedder.getStatus();
		logger.info(
			`Embedding finished successfully for ${contractAddress}. Status: ${JSON.stringify(finalStatus)}`,
		);
	} catch (error) {
		logger.error(
			`Etherscan embedding failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		const finalStatus = embedder.getStatus();
		logger.error(`Final status: ${JSON.stringify(finalStatus)}`);
		process.exit(1);
	}
}

// Run the script
main().catch((err) => {
	console.error("Unhandled error in main:", err);
	process.exit(1);
});
