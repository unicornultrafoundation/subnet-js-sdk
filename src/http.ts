import { createLibp2p, Libp2p } from "libp2p";
import { webTransport } from "@libp2p/webtransport";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { pushable } from "it-pushable";
import { pipe } from "it-pipe";
import PQueue from "p-queue";
import { Multiaddr, multiaddr } from "@multiformats/multiaddr";

/**
 * A client for managing libp2p connections and performing HTTP-like requests.
 * 
 * This class provides an abstraction over the libp2p library, allowing users
 * to create a libp2p node and perform HTTP-like requests to peers using the
 * `Libp2pHttpClient`.
 */
export class P2PClient {
  node: Libp2p; // The libp2p instance managed by this client
  private clientCache: Map<string, Libp2pHttpClient>; // Cache for Libp2pHttpClient instances

  /**
   * Constructs a new P2PClient instance.
   * 
   * @param libp2p - The libp2p instance to be managed by this client.
   */
  constructor(libp2p: Libp2p) {
    this.node = libp2p;
    this.clientCache = new Map(); // Initialize the cache
  }

  /**
   * Creates and starts a new libp2p node, then returns a P2PClient instance.
   * 
   * This method initializes a libp2p node with specific configurations such as
   * transports, connection encrypters, and stream muxers. The node is started
   * before being wrapped in a `P2PClient` instance.
   * 
   * @returns A Promise that resolves to a new `P2PClient` instance.
   */
  static async create() {
    const node = await createLibp2p({
      addresses: { listen: [] },
      transports: [webTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionGater: {
        denyDialMultiaddr: async () => false,
        denyInboundConnection: async () => false,
        denyOutboundConnection: async () => false,
      },
    });

    await node.start();

    return new P2PClient(node);
  }

  /**
   * Retrieves an instance of `Libp2pHttpClient` or creates a new one if it doesn't exist in the cache.
   * 
   * This method initializes a `Libp2pHttpClient` with the provided peer ID, application ID, and port.
   * If a client for the same peer, appId, and port already exists in the cache, it is returned instead
   * of creating a new one. Otherwise, a new client is created, connected, and cached.
   * 
   * @param peerId - The multiaddress of the target peer.
   * @param appId - The application identifier for the protocol.
   * @param port - The port number for the connection.
   * @returns A Promise that resolves to a connected `Libp2pHttpClient` instance.
   */
  async getHttpClient(peerId: string, appId: string, port: number) {
    const cacheKey = `${peerId}-${appId}-${port}`;
    if (this.clientCache.has(cacheKey)) {
      return this.clientCache.get(cacheKey)!; // Return cached client
    }

    const cli = new Libp2pHttpClient(this.node, peerId, appId, port);
    await cli.connect();

    // Set a callback to remove the client from the cache if the stream is closed
    cli.setOnCloseCallback(() => {
      this.clientCache.delete(cacheKey);
    });

    this.clientCache.set(cacheKey, cli); // Cache the new client
    return cli;
  }
}

/**
 * A client for sending HTTP-like requests over the libp2p protocol.
 * 
 * This class establishes a connection to a peer using libp2p and allows
 * sending HTTP requests in the HTTP/1.1 format. It handles request encoding,
 * response parsing, and connection management.
 */
class Libp2pHttpClient {
  node: Libp2p; // The libp2p instance used for communication
  peerId: Multiaddr; // The multiaddress of the target peer
  appId: string; // Application identifier for the protocol
  port: number; // Port number for the connection
  stream: any; // The stream used for communication
  encoder: TextEncoder; // Encoder for converting strings to Uint8Array
  decoder: TextDecoder; // Decoder for converting Uint8Array to strings
  queue: PQueue; // Queue to ensure sequential request processing
  source: any; // Pushable source for sending data
  responseQueue: any[]; // Queue to handle responses for requests
  buffer: string; // Buffer to store incoming data for processing
  private onCloseCallback: () => void; // Callback to handle stream closure

  /**
   * Constructs a new Libp2pHttpClient instance.
   * 
   * @param node - The libp2p instance.
   * @param peerId - The multiaddress of the target peer.
   * @param appId - The application identifier for the protocol.
   * @param port - The port number for the connection.
   */
  constructor(node: Libp2p, peerId: string, appId: string, port: number) {
    this.node = node;
    this.peerId = multiaddr(peerId);
    this.stream = null;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.appId = appId;
    this.port = port;
    this.queue = new PQueue({ concurrency: 1 }); // Đảm bảo xử lý tuần tự
    this.source = null;
    this.responseQueue = [];
    this.buffer = "";
    this.onCloseCallback = () => {}; // Initialize with a no-op callback
  }

  /**
   * Sets a callback to be invoked when the stream is closed.
   * 
   * @param callback - The function to call when the stream is closed.
   */
  setOnCloseCallback(callback: () => void) {
    this.onCloseCallback = callback;
  }

  /**
   * Establishes a connection to the target peer if not already connected.
   * 
   * This method dials the target peer using the specified protocol and sets up
   * a stream for communication. It also initializes the pushable source and
   * starts processing incoming responses.
   */
  async connect() {
    if (!this.stream) {
      this.stream = await this.node.dialProtocol(
        this.peerId,
        `/x/proxy/reverse/0.0.1/tcp/${this.appId}/${this.port}`
      );
      this.source = pushable();
      pipe(this.source, this.stream.sink);
      this.processResponses();

      // Listen for stream closure and invoke the callback
      this.stream.closeRead = () => {
        this.onCloseCallback();
      };
    }
  }

  /**
   * Sends an HTTP request to the specified URL using the libp2p protocol.
   * 
   * @param url - The target URL for the HTTP request.
   * @param options - Optional configuration for the request, including:
   *   - method: The HTTP method (e.g., GET, POST). Defaults to "GET".
   *   - headers: A record of HTTP headers to include in the request.
   *   - body: The request body as a string (for methods like POST).
   *   - timeout: The maximum time (in milliseconds) to wait for a response.
   * @returns A Promise that resolves to a Response object containing the server's response.
   * 
   * This method ensures that a connection is established before sending the request.
   * It constructs the HTTP request string in the HTTP/1.1 format, including headers and body.
   * The response is parsed and returned as a Response object.
   */
  async fetch(
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      timeout?: number; // Timeout in milliseconds
    } = {}
  ): Promise<Response> {
    // Ensure the connection is established before sending the request
    await this.connect();

    // Set the HTTP method, defaulting to "GET" if not provided
    const method = options.method ? options.method.toUpperCase() : "GET";

    // Define default headers for the request
    const defaultHeaders: Record<string, string> = {
      Host: "localhost",
      Connection: "keep-alive",
      "User-Agent": "libp2p-client",
    };

    // Merge default headers with any headers provided in the options
    const headers = { ...defaultHeaders, ...options.headers };

    // Construct the HTTP/1.1 request string, including headers and body
    let request = `${method} ${url} HTTP/1.1\r\n`;
    for (const key in headers) {
      request += `${key}: ${headers[key]}\r\n`;
    }

    // Add Content-Length and body content if a body is provided
    if (options.body) {
      request += `Content-Length: ${Buffer.byteLength(
        options.body,
        "utf-8"
      )}\r\n`;
    }
    request += `\r\n`;

    // Append the body content to the request if provided
    if (options.body) {
      request += options.body;
    }

    // Send the request and return a Promise that resolves when a response is received
    return new Promise<Response>((resolve, reject) => {
      // Set up a timeout if specified
      const timeout = options.timeout || 5000; // Default timeout of 5 seconds
      let timeoutId: NodeJS.Timeout | null = null;

      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          reject(new Error("Request timed out"));
        }, timeout);
      }

      // Register a callback to handle the raw response
      this.responseQueue.push((rawResponse: string) => {
        if (timeoutId) clearTimeout(timeoutId); // Clear the timeout if the response is received
        try {
          // Parse the raw response into a Response object
          const response = this.parseHttpResponse(rawResponse);
          resolve(response);
        } catch (error) {
          reject(error);
        }
      });

      // Push the encoded request data to the source
      this.source.push(this.encoder.encode(request));
    });
  }

  /**
   * Processes incoming responses from the stream.
   * 
   * This method reads data from the stream, parses HTTP responses, and resolves
   * the corresponding promises in the response queue.
   */
  async processResponses() {
    for await (const msg of this.stream.source) {
      this.buffer += this.decoder.decode(msg.subarray(), { stream: true });

      while (true) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;

        const headers = this.buffer.slice(0, headerEnd + 4);
        const contentMatch = headers.match(/Content-Length: (\d+)/i);
        let contentLength = contentMatch ? parseInt(contentMatch[1], 10) : null;

        if (
          contentLength === null &&
          headers.includes("Transfer-Encoding: chunked")
        ) {
          contentLength = this.parseChunkedLength(headerEnd + 4);
        }
        if (contentLength === null) break;

        const totalLength = headerEnd + 4 + contentLength;
        if (this.buffer.length < totalLength) break;

        const response = this.buffer.slice(0, totalLength);
        this.buffer = this.buffer.slice(totalLength).trimStart();

        if (this.responseQueue.length > 0) {
          const resolve = this.responseQueue.shift();
          resolve(response.replace(/^\s+/, ""));
        } else {
          console.warn("⚠️ Response received but no matching request in queue");
        }
      }
    }
  }

  /**
   * Parses the length of a chunked transfer encoding response.
   * 
   * @param startIndex - The starting index of the chunked data in the buffer.
   * @returns The total length of the chunked response, or null if parsing fails.
   */
  parseChunkedLength(startIndex: number) {
    let length = 0;
    let index = startIndex;
    while (true) {
      const nextCRLF = this.buffer.indexOf("\r\n", index);
      if (nextCRLF === -1) return null;
      const chunkSize = parseInt(this.buffer.slice(index, nextCRLF), 16);
      if (isNaN(chunkSize)) return null;
      length += chunkSize;
      if (chunkSize === 0) break;
      index = nextCRLF + 2 + chunkSize;
    }
    return length;
  }

  /**
   * Parses a raw HTTP response string into a Response object.
   * 
   * @param rawResponse - The raw HTTP response string.
   * @returns A Response object containing the parsed status, headers, and body.
   */
  parseHttpResponse(rawResponse: string) {
    const [headerBlock, ...bodyParts] = rawResponse.split("\r\n\r\n");
    const headerLines = headerBlock.split("\r\n");
    const statusLine = headerLines.shift();
    const [, status, statusText] =
      statusLine?.match(/HTTP\/\d+\.\d+ (\d+) (.+)/) || [];

    const headers = new Headers();
    for (const line of headerLines) {
      const [key, value] = line.split(": ", 2);
      if (key && value) headers.append(key, value);
    }

    const body = new Blob([bodyParts.join("\r\n\r\n")]); // Trả về dạng Blob
    return new Response(body, {
      status: parseInt(status, 10),
      statusText,
      headers,
    });
  }
}
