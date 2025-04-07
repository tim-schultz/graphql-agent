
import { PgVector } from '@mastra/pg';
import { MDocument } from "@mastra/rag";
import { openai } from "@ai-sdk/openai";
import { embed, embedMany } from "ai";
import { logger } from './utils';

/**
 * Status of the content processing
 */
interface ProcessorStatus {
  status: "idle" | "processing" | "completed" | "error";
  error?: string;
  startTime?: number;
  chunksGenerated?: number;
  chunksStored?: number;
}

/**
 * Chunk data structure with document metadata
 */
interface ChunkData {
  text: string;
  id?: string;
}

/**
 * Processes content: splits into chunks, generates embeddings, and stores in a PostgreSQL database using Mastra.
 */
export class MastraContentProcessor {
  private embeddingModel: string;
  private pgVector: PgVector;
  private indexName: string;
  private chunkSize: number;
  private chunkOverlap: number;
  private status: ProcessorStatus;

  /**
   * Create a new MastraContentProcessor
   * @param pgConnectionString PostgreSQL connection string
   * @param indexName The name to use for the vector index
   * @param options Configuration options
   */
  constructor(
    pgConnectionString: string,
    indexName: string,
    options: {
      chunkSize?: number;
      chunkOverlap?: number;
      embeddingModel?: string;
      dimension?: number;
    } = {},
  ) {
    if (!pgConnectionString) throw new Error("PostgreSQL connection string is required.");
    if (!indexName) throw new Error("Index name is required.");

    // Initialize the PgVector store
    this.pgVector = new PgVector(pgConnectionString);
    this.indexName = indexName;
    this.chunkSize = options.chunkSize || 1000;
    this.chunkOverlap = options.chunkOverlap || 200;
    this.embeddingModel = options.embeddingModel || "text-embedding-3-small";
    this.status = {
      status: "idle",
      chunksGenerated: 0,
      chunksStored: 0,
    };

    // Create the index if it doesn't exist
    this.initializeIndex(options.dimension || 1536);

    if (this.chunkOverlap >= this.chunkSize) {
      logger.warn(
        `Chunk overlap (${this.chunkOverlap}) is greater than or equal to chunk size (${this.chunkSize}). Setting overlap to ${Math.floor(this.chunkSize / 5)}.`,
      );
      this.chunkOverlap = Math.floor(this.chunkSize / 5);
    }
  }

  /**
   * Initialize the vector index if it doesn't already exist
   * @param dimension The dimension size for the embedding vectors
   */
  private async initializeIndex(dimension: number): Promise<void> {
    try {
      // Try to create the index, which is a no-op if it already exists
      await this.pgVector.createIndex({
        indexName: this.indexName,
        dimension: dimension,
      });
      logger.info(`Vector index '${this.indexName}' is ready (dimension: ${dimension}).`);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      // If the error is that the index already exists, that's fine
      if (errorMsg.includes("already exists")) {
        logger.info(`Vector index '${this.indexName}' already exists.`);
      } else {
        logger.error(`Failed to initialize vector index: ${errorMsg}`);
        throw e;
      }
    }
  }

  /**
   * Processes the content and stores it in the database.
   * @param content The content to process.
   * @param contentType The type of content ('text', 'html', 'markdown', or 'json')
   */
  public async processAndStore(
    content: string, 
    contentType: 'text' | 'html' | 'markdown' | 'json' = 'text'
  ): Promise<void> {
    if (!content || !content.trim()) {
      logger.warn("Content is empty, skipping processing and storage.");
      this.status.status = "completed";
      return;
    }

    this.status.status = "processing";
    this.status.startTime = Date.now();
    this.status.chunksGenerated = 0;
    this.status.chunksStored = 0;
    this.status.error = undefined;

    try {
      // 1. Create MDocument from the content
      let doc;
      switch (contentType) {
        case 'html':
          doc = MDocument.fromHTML(content);
          break;
        case 'markdown':
          doc = MDocument.fromMarkdown(content);
          break;
        case 'json':
          doc = MDocument.fromJSON(content);
          break;
        case 'text':
        default:
          doc = MDocument.fromText(content);
          break;
      }

      // 2. Split content into chunks using Mastra's chunking strategy
      logger.info(
        `Splitting content into chunks (size: ${this.chunkSize}, overlap: ${this.chunkOverlap})...`,
      );
      const chunks = await doc.chunk({
        strategy: "recursive",  // Smart splitting based on content structure
        size: this.chunkSize,
        overlap: this.chunkOverlap,
        separator: "\n",
      });

      if (chunks.length === 0) {
        logger.warn("No chunks were generated from the content.");
        this.status.status = "completed";
        return;
      }
      logger.info(`Generated ${chunks.length} chunks.`);
      this.status.chunksGenerated = chunks.length;

      // 3. Generate embeddings with OpenAI using ai SDK
      logger.info(`Generating embeddings using model: ${this.embeddingModel}...`);
      const { embeddings } = await embedMany({
        model: openai.embedding(this.embeddingModel),
        values: chunks.map(chunk => chunk.text),
      });

      logger.info(`Successfully generated embeddings for ${embeddings.length} chunks.`);

      if (embeddings.length === 0) {
        logger.error("No embeddings were generated. Aborting database insertion.");
        throw new Error("Embedding generation failed for all chunks.");
      }

      // 4. Store chunks and embeddings in the database
      logger.info(`Storing ${embeddings.length} chunks with embeddings in the database...`);
      
      // Prepare chunks with metadata
      const chunkMetadata = chunks.map(chunk => ({
        text: chunk.text,
        id: chunk.id_
      }));

      // Upsert embeddings using Mastra's PgVector
      await this.pgVector.upsert({
        indexName: this.indexName,
        vectors: embeddings,
        metadata: chunkMetadata,
      });

      this.status.chunksStored = embeddings.length;
      logger.info(`Successfully stored ${this.status.chunksStored} chunks in the database.`);
      this.status.status = "completed";
    } catch (e) {
      this.status.status = "error";
      this.status.error = e instanceof Error ? e.message : String(e);
      logger.error(`Content processing failed: ${this.status.error}`);
      throw e; // Re-throw after setting status
    }
  }

  /**
   * Process a single string - generate embedding and store in database.
   * @param text The string to process
   * @returns True if processing and storage was successful, false otherwise
   */
  public async processAndStoreSingleString(text: string): Promise<boolean> {
    if (!text || !text.trim()) {
      logger.warn("Empty text provided for processing.");
      return false;
    }

    try {
      // Generate embedding with OpenAI
      const { embedding } = await embed({
        value: text,
        model: openai.embedding(this.embeddingModel),
      });

      if (!embedding || embedding.length === 0) {
        logger.error("Failed to generate embedding for single string.");
        return false;
      }

      // Store in database using Mastra PgVector
      await this.pgVector.upsert({
        indexName: this.indexName,
        vectors: [embedding],
        metadata: [{ text, id: Date.now().toString() }],
      });

      logger.info("Successfully processed and stored single string.");
      return true;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      logger.error(`Error processing and storing single string: ${errorMsg}`);
      return false;
    }
  }

  /**
   * Query the vector store for similar content
   * @param queryText The text to search for
   * @param topK The number of results to return
   * @returns Array of search results with similarity scores
   */
  public async querySimilarContent(queryText: string, topK: number = 5): Promise<any[]> {
    try {
      // Generate embedding for the query
      const { embedding } = await embed({
        value: queryText,
        model: openai.embedding(this.embeddingModel),
      });

      // Query the vector store
      const results = await this.pgVector.query({
        indexName: this.indexName,
        queryVector: embedding,
        topK: topK,
      });

      return results;
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      logger.error(`Error querying similar content: ${errorMsg}`);
      return [];
    }
  }

  /**
   * Get the current status of the processing operation.
   * @returns The processor status.
   */
  public getStatus(): ProcessorStatus {
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
}

/**
 * Helper function to embed a single string and store it in the vector database
 * @param pgConnectionString PostgreSQL connection string
 * @param indexName The name of the vector index
 * @param textToEmbed The text to embed and store
 */
export async function embedSingleString(
  pgConnectionString: string,
  indexName: string,
  textToEmbed: string,
) {
  try {
    if (!pgConnectionString) {
      console.error("PostgreSQL connection string is required");
      return false;
    }

    // Create an instance of MastraContentProcessor
    const processor = new MastraContentProcessor(
      pgConnectionString,
      indexName
    );

    // Process and store the string
    const success = await processor.processAndStoreSingleString(textToEmbed);
    console.log(
      `Processing and storing single string: ${success ? "Successful" : "Failed"}`,
    );
    return success;
  } catch (error) {
    console.error("Error in embedSingleString:", error);
    return false;
  }
}