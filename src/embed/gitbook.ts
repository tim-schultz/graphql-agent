import * as fs from "node:fs/promises";
import * as path from "node:path";
import { URL } from "node:url";
import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import * as cheerio from "cheerio";
import slugify from "slugify";
import TurndownService from "turndown";

import { MastraContentProcessor } from "./content-processor";
import { logger, withTimeout } from "./utils";

/**
 * Status of the download process
 */
interface DownloadStatus {
	totalPages: number;
	currentPage: number;
	currentUrl: string;
	status: "idle" | "downloading" | "completed" | "error";
	error?: string;
	startTime?: number;
	pagesScraped: string[];
	outputFile?: string;
	rateLimitReset?: number;
}

/**
 * Page data structure
 */
interface PageData {
	index: number;
	title: string;
	content: string;
	url: string;
}

/**
 * GitbookDownloader class for downloading and converting GitBook content to markdown
 */
export class GitbookDownloader {
	private baseUrl: string;
	private status: DownloadStatus;
	private client: AxiosInstance;
	private visitedUrls: Set<string>;
	private delay: number;
	private maxRetries: number;
	private retryDelay: number;
	private pages: Map<number, PageData>;
	private contentHash: Map<number, number>;
	private turndownService: TurndownService;

	/**
	 * Create a new GitbookDownloader
	 * @param url Base URL of the GitBook to download
	 * @param options Additional options
	 */
	constructor(
		url: string,
		options: {
			delay?: number;
			maxRetries?: number;
			retryDelay?: number;
		} = {},
	) {
		this.baseUrl = url.endsWith("/") ? url.slice(0, -1) : url;
		this.status = {
			totalPages: 0,
			currentPage: 0,
			currentUrl: "",
			status: "idle",
			pagesScraped: [],
		};
		this.client = axios.create({
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; GitbookDownloader/1.0)",
			},
			timeout: 30000, // 30 seconds timeout
		});
		this.visitedUrls = new Set<string>();
		this.delay = options.delay || 1000; // Delay between requests in milliseconds
		this.maxRetries = options.maxRetries || 3;
		this.retryDelay = options.retryDelay || 2000; // Initial retry delay in milliseconds
		this.pages = new Map<number, PageData>();
		this.contentHash = new Map<number, number>();
		this.turndownService = new TurndownService({
			headingStyle: "atx",
			bulletListMarker: "-",
		});
	}

	/**
	 * Main download method
	 * @returns The markdown content of the downloaded GitBook
	 */
	public async download(): Promise<string> {
		try {
			this.status.startTime = Date.now();
			this.status.status = "downloading";
			this.visitedUrls.clear();
			this.pages.clear();
			this.contentHash.clear();

			logger.info(`Starting download from ${this.baseUrl}`);

			// First get the main page
			const initialContent = await this.fetchPage(this.baseUrl);
			if (!initialContent) {
				throw new Error(`Failed to fetch main page: ${this.baseUrl}`);
			}

			// Extract navigation links
			const navLinks = await this.extractNavLinks(initialContent);
			this.status.totalPages = navLinks.length + 1;
			logger.info(`Found ${navLinks.length} navigation links.`);

			// Process main page
			const mainPage = await this.processPageContent(
				this.baseUrl,
				initialContent,
			);
			if (mainPage) {
				this.pages.set(0, { ...mainPage, index: 0 });
				this.status.pagesScraped.push(mainPage.title);
				this.visitedUrls.add(this.baseUrl);
				logger.debug(`Processed main page: ${mainPage.title}`);
			} else {
				logger.warn(`Could not process main page: ${this.baseUrl}`);
			}

			// Process other pages
			let pageIndex = 1;
			for (const link of navLinks) {
				try {
					// Skip if URL already processed
					if (this.visitedUrls.has(link)) {
						logger.debug(`Skipping already visited URL: ${link}`);
						continue;
					}

					this.status.currentPage = pageIndex;
					this.status.currentUrl = link;
					logger.debug(
						`Processing page ${pageIndex}/${this.status.totalPages}: ${link}`,
					);

					// Add delay between requests
					await this.sleep(this.delay);

					const content = await this.fetchPage(link);
					if (content) {
						const pageData = await this.processPageContent(link, content);
						if (pageData) {
							// Check for duplicate content
							const contentHash = this.hashCode(pageData.content);
							if (!this.contentHash.has(contentHash)) {
								this.pages.set(pageIndex, { ...pageData, index: pageIndex });
								this.status.pagesScraped.push(pageData.title);
								this.contentHash.set(contentHash, pageIndex);
								logger.debug(`Processed page: ${pageData.title}`);
								pageIndex++;
							} else {
								logger.debug(`Skipping duplicate content from: ${link}`);
							}
						} else {
							logger.warn(`Could not process page content from: ${link}`);
						}
					}

					this.visitedUrls.add(link);
				} catch (e) {
					logger.error(
						`Error processing page ${link}: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
			}

			// Generate markdown
			logger.info("Generating combined markdown content...");
			const markdownContent = this.generateMarkdown();
			if (!markdownContent) {
				throw new Error("Failed to generate markdown content");
			}

			this.status.status = "completed";
			logger.info(
				`Download completed. Processed ${this.pages.size} unique pages.`,
			);
			return markdownContent;
		} catch (e) {
			this.status.status = "error";
			this.status.error = e instanceof Error ? e.message : String(e);
			logger.error(`Download failed: ${this.status.error}`);
			throw e;
		}
	}

	/**
	 * Get the current status of the download
	 * @returns The current download status
	 */
	public getStatus(): DownloadStatus {
		const status = { ...this.status };
		if (this.status.startTime) {
			const elapsed = Math.round((Date.now() - this.status.startTime) / 1000);
			Object.defineProperty(status, "elapsedTime", {
				enumerable: true,
				value: elapsed,
			});
		}
		return status;
	}

	/**
	 * Process the content of a page
	 * @param url The URL of the page
	 * @param content The HTML content of the page
	 * @returns The processed page data
	 */
	private async processPageContent(
		url: string,
		content: string,
	): Promise<Omit<PageData, "index"> | null> {
		try {
			const $ = cheerio.load(content);

			// Extract title
			let title: string | null = null;
			const h1 = $("h1").first();
			if (h1.length) {
				title = h1.text().trim();
			}
			if (!title) {
				const titleTag = $("title");
				if (titleTag.length) {
					// Clean up title - remove site name and extra parts
					title = titleTag.text().trim();
					title = title.split(/[|\-–]/)[0].trim();
				}
			}
			if (!title) {
				const parsedUrl = new URL(url);
				const pathSegments = parsedUrl.pathname.split("/");
				const lastSegment = pathSegments[pathSegments.length - 1];
				title =
					lastSegment ||
					pathSegments[pathSegments.length - 2] ||
					"Introduction";
			}
			title = title || "Untitled"; // Fallback title

			// Get main content area
			let mainContent = $("main, article");
			if (!mainContent.length) {
				mainContent = $(
					"div.markdown, div.content, div.article, div.documentation",
				);
			}
			if (!mainContent.length) {
				logger.warn(`Could not find main content area for ${url}. Using body.`);
				mainContent = $("body");
			}

			// Remove navigation, header, footer, scripts, styles, etc.
			mainContent.find("nav, aside, header, footer, script, style").remove();

			// Remove specific GitBook UI elements if needed
			mainContent.find(".gitbook-link, .page-navigation").remove();

			// Remove navigation links often found at the bottom
			mainContent.find("a").each((_, elem) => {
				const text = $(elem).text().trim();
				if (/Previous|Next|Edit this page/i.test(text)) {
					// Remove the link or its container if it's simple
					$(elem).parent().closest("div, p").remove(); // Be careful not to remove too much
					$(elem).remove();
				}
			});

			// Convert remaining HTML to markdown
			const contentHtml = mainContent.html() || "";
			if (!contentHtml.trim()) {
				logger.warn(`No convertible HTML content found for ${url}`);
				return null;
			}

			let md = this.turndownService.turndown(contentHtml);

			// Clean up markdown
			md = md.replace(/\n{3,}/g, "\n\n"); // Remove excessive newlines
			md = md.replace(/!\[.*?\]\(data:.*?\)/g, ""); // Remove base64 images
			md = md.replace(/^\s*#\s+/gm, "## "); // Ensure headings start at H2 minimum relative to page title
			md = md.trim();

			if (!md) {
				logger.warn(`Markdown conversion resulted in empty content for ${url}`);
				return null;
			}

			return { title, content: md, url };
		} catch (e) {
			logger.error(
				`Error processing page content for ${url}: ${e instanceof Error ? e.message : String(e)}`,
			);
			return null;
		}
	}

	/**
	 * Generate markdown content from downloaded pages
	 * @returns The markdown content
	 */
	private generateMarkdown(): string {
		if (this.pages.size === 0) {
			logger.warn("No pages were downloaded, cannot generate markdown.");
			return "";
		}

		const markdownParts: string[] = [];
		const seenTitles = new Set<string>();

		// Convert Map to array and sort by index
		const sortedPages = Array.from(this.pages.values()).sort(
			(a, b) => a.index - b.index,
		);

		// Add table of contents (optional, could be generated later)
		markdownParts.push("# Table of Contents\n");
		for (const page of sortedPages) {
			if (page.title) {
				const title = page.title.trim();
				const slug = slugify(title, { lower: true, strict: true });
				if (title && !seenTitles.has(title)) {
					markdownParts.push(`- [${title}](#${slug})`);
					seenTitles.add(title);
				}
			}
		}
		markdownParts.push("\n---\n");
		seenTitles.clear(); // Reset for content section

		// Add content
		for (const page of sortedPages) {
			if (page.title && page.content) {
				const title = page.title.trim();
				const content = page.content.trim();
				const slug = slugify(title, { lower: true, strict: true });

				// Avoid adding completely duplicate sections (based on title)
				if (title && !seenTitles.has(title)) {
					markdownParts.push(`\n# ${title} {#${slug}}`); // Add anchor ID
					markdownParts.push(`\n*Source: ${page.url}*\n`);
					markdownParts.push(content);
					markdownParts.push("\n---\n");
					seenTitles.add(title);
				} else if (title && seenTitles.has(title)) {
					logger.debug(
						`Skipping content for duplicate title: "${title}" from ${page.url}`,
					);
				}
			}
		}

		return markdownParts.join("\n").trim();
	}

	/**
	 * Fetch a page with retry logic
	 * @param url The URL to fetch
	 * @returns The HTML content of the page
	 */
	private async fetchPage(url: string): Promise<string | null> {
		let retryCount = 0;
		let currentDelay = this.retryDelay;

		while (retryCount <= this.maxRetries) {
			try {
				logger.debug(`Fetching: ${url} (Attempt ${retryCount + 1})`);
				const response: AxiosResponse<string> = await withTimeout(
					this.client.get(url),
					this.client.defaults.timeout || 30000,
					`Timeout fetching ${url}`,
				);

				if (response.status === 200) {
					return response.data;
				}
				if (response.status === 429) {
					// Rate limit
					const retryAfterHeader = response.headers["retry-after"];
					let waitTime = currentDelay / 1000; // Default wait based on retry delay
					if (retryAfterHeader) {
						const retryAfterSeconds = Number.parseInt(retryAfterHeader, 10);
						if (!Number.isNaN(retryAfterSeconds)) {
							waitTime = retryAfterSeconds;
						} else {
							// Could be an HTTP date
							try {
								const retryDate = Date.parse(retryAfterHeader);
								waitTime = Math.max(
									0,
									Math.ceil((retryDate - Date.now()) / 1000),
								);
							} catch {
								/* ignore date parsing error */
							}
						}
					}
					waitTime = Math.min(waitTime, 300); // Max wait 5 minutes
					this.status.rateLimitReset = waitTime;
					logger.warn(
						`Rate limited fetching ${url}. Waiting ${waitTime} seconds.`,
					);
					await this.sleep(waitTime * 1000);
					// Don't increment retryCount here, let the loop continue
				} else {
					logger.warn(
						`HTTP ${response.status} for ${url}. Attempt ${retryCount + 1}/${this.maxRetries + 1}.`,
					);
					if (response.status >= 500 && retryCount < this.maxRetries) {
						// Retry on server errors
						await this.sleep(currentDelay);
						currentDelay *= 2; // Exponential backoff
						retryCount++;
					} else {
						// Non-retryable error or max retries reached
						return null;
					}
				}
			} catch (e) {
				logger.error(
					`Error fetching ${url} (Attempt ${retryCount + 1}): ${e instanceof Error ? e.message : String(e)}`,
				);
				if (retryCount < this.maxRetries) {
					await this.sleep(currentDelay);
					currentDelay *= 2; // Exponential backoff
					retryCount++;
				} else {
					logger.error(`Max retries reached for ${url}. Giving up.`);
					return null; // Max retries exceeded
				}
			}
		}
		return null; // Should not be reached if logic is correct
	}

	/**
	 * Extract navigation links from GitBook page content
	 * @param content The HTML content of the page
	 * @returns An array of absolute navigation links in perceived order
	 */
	private async extractNavLinks(content: string): Promise<string[]> {
		try {
			const $ = cheerio.load(content);
			const navLinks = new Map<string, number>(); // Store URL -> order index
			let orderIndex = 0;

			const processLink = (href: string | undefined) => {
				if (!href || href.startsWith("#") || href.startsWith("mailto:")) {
					return; // Skip fragments, mailto links
				}

				let fullUrl: string;
				try {
					// Resolve relative URLs against the base URL
					fullUrl = new URL(href, this.baseUrl).toString();
				} catch (e) {
					logger.warn(`Invalid URL found in nav link: ${href}`);
					return;
				}

				// Only include URLs that are within the base URL's scope (same domain/path prefix)
				if (fullUrl.startsWith(this.baseUrl)) {
					if (!navLinks.has(fullUrl)) {
						navLinks.set(fullUrl, orderIndex++);
					}
				} else {
					// logger.debug(`Skipping external or non-base URL: ${fullUrl}`);
				}
			};

			// Common navigation structures: <nav>, <aside>, specific class names
			$("nav, aside, .nav, .sidebar, .toc, .menu").each((_, container) => {
				$(container)
					.find("a[href]")
					.each((_, link) => {
						processLink($(link).attr("href"));
					});
			});

			// If no links found in common structures, try a broader search (less reliable)
			if (navLinks.size === 0) {
				logger.debug(
					"No links found in standard nav elements, trying broader search.",
				);
				$("a[href]").each((_, link) => {
					processLink($(link).attr("href"));
				});
			}

			// Sort links by the order they were encountered
			const sortedLinks = Array.from(navLinks.entries())
				.sort(([, idxA], [, idxB]) => idxA - idxB)
				.map(([url]) => url);

			// Filter out the base URL itself if it was added
			return sortedLinks.filter((link) => link !== this.baseUrl);
		} catch (e) {
			logger.error(
				`Error extracting nav links: ${e instanceof Error ? e.message : String(e)}`,
			);
			return [];
		}
	}

	/**
	 * Sleep for a given number of milliseconds
	 * @param ms The number of milliseconds to sleep
	 * @returns A promise that resolves after the given time
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Generate a hash code for a string (simple non-crypto hash)
	 * @param str The string to hash
	 * @returns The hash code
	 */
	private hashCode(str: string): number {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash &= hash; // Convert to 32bit integer
		}
		return hash;
	}

	/**
	 * Save the markdown content to a file
	 * @param content The markdown content to save
	 * @param filePath The path to save the file to
	 */
	public async saveToFile(content: string, filePath: string): Promise<void> {
		try {
			// Ensure directory exists
			const dir = path.dirname(filePath);
			await fs.mkdir(dir, { recursive: true });

			// Write content to file
			await fs.writeFile(filePath, content, "utf8");
			this.status.outputFile = filePath;
			logger.info(`Saved downloaded content to ${filePath}`);
		} catch (e) {
			logger.error(
				`Error saving content to file ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
			);
			throw e; // Re-throw after logging
		}
	}
}

// --- Main Execution ---

async function main() {
	// Configuration
	const gitbookUrl = "https://support.gitcoin.co/gitcoin-knowledge-base";
	const pgConnectionString = process.env.POSTGRES_URL;
	const indexName = "gitcoin_docs"; // The name for the vector index in PostgreSQL

	if (!pgConnectionString) {
		logger.error("POSTGRES_URL environment variable is required.");
		process.exit(1);
	}

	// 1. Download Content
	const downloader = new GitbookDownloader(gitbookUrl, {
		delay: 500, // ms delay between page fetches
		maxRetries: 2,
	});
	let markdownContent = "";
	try {
		logger.info(`Starting download from: ${gitbookUrl}`);
		markdownContent = await downloader.download();
		const downloadStatus = downloader.getStatus();
		logger.info(
			`Download completed: ${downloadStatus.pagesScraped.length} unique pages processed.`,
		);
	} catch (error) {
		logger.error(
			`GitBook download failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		const downloadStatus = downloader.getStatus();
		logger.error(`Download status: ${JSON.stringify(downloadStatus)}`);
		process.exit(1);
	}

	if (!markdownContent) {
		logger.error("Markdown content is empty after download, cannot proceed.");
		process.exit(1);
	}

	// 2. Process and Store Content using Mastra
	const processor = new MastraContentProcessor(pgConnectionString, indexName, {
		chunkSize: 1000, // Characters per chunk
		chunkOverlap: 200, // Characters of overlap
		embeddingModel: "text-embedding-3-small", // OpenAI embedding model
		dimension: 1536, // Dimension size for text-embedding-3-small
	});

	try {
		logger.info(
			"Starting content processing and database storage with Mastra...",
		);
		await processor.processAndStore(markdownContent, "markdown");
		const processStatus = processor.getStatus();
		logger.info(
			`Processing completed: Generated ${processStatus.chunksGenerated} chunks, Stored ${processStatus.chunksStored} chunks in vector store.`,
		);
	} catch (error) {
		logger.error(
			`Content processing failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		const processStatus = processor.getStatus();
		logger.error(`Processor status: ${JSON.stringify(processStatus)}`);
		process.exit(1);
	}

	logger.info("Script finished successfully.");
}

// Run the script
main().catch((err) => {
	console.error("Unhandled error in main:", err);
	process.exit(1);
});
