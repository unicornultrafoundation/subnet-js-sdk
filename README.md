# Subnet JS SDK

This project provides a JavaScript SDK for interacting with a libp2p-based network. It includes an HTTP-like client for sending requests over the libp2p protocol.

## Features

- Manage libp2p connections.
- Perform HTTP-like requests to peers using the `Libp2pHttpClient`.
- Cache HTTP clients to avoid redundant connections.
- Automatically handle stream closures and cache cleanup.

## Installation

Install the required dependencies using npm or yarn:

```bash
npm install
# or
yarn install
```

## Usage

### Creating a P2P Client

To start using the SDK, first create a `P2PClient` instance:

```typescript
import { P2PClient } from "./src/http";

async function main() {
  const p2pClient = await P2PClient.create();
  console.log("P2P Client initialized");
}

main();
```

### Creating or Retrieving an HTTP Client

Use the `getHttpClient` method to create or retrieve a cached `Libp2pHttpClient` for a specific peer, app ID, and port:

```typescript
async function main() {
  const p2pClient = await P2PClient.create();

  const peerId = "/ip4/127.0.0.1/tcp/4001/p2p/QmPeerId";
  const appId = "1";
  const port = 80;

  const httpClient = await p2pClient.getHttpClient(peerId, appId, port);
  console.log("HTTP Client connected");
}

main();
```

### Sending HTTP Requests

Once you have a `Libp2pHttpClient` instance, you can send HTTP-like requests using the `fetch` method:

```typescript
async function main() {
  const p2pClient = await P2PClient.create();

  const peerId = "/ip4/127.0.0.1/tcp/4001/p2p/QmPeerId";
  const appId = "1";
  const port = 80;

  const httpClient = await p2pClient.getHttpClient(peerId, appId, port);

  const response = await httpClient.fetch("/", {
    method: "GET",
    headers: {
      "Custom-Header": "ExampleValue",
    },
  });

  console.log("Response status:", response.status);
  console.log("Response body:", await response.text());
}

main();
```

### Handling Stream Closures

The SDK automatically removes cached HTTP clients when their streams are closed. You don't need to manually manage the cache.

## Development

### Running Tests

To run tests, use the following command:

```bash
npm test
```

### Linting

To lint the code, use:

```bash
npm run lint
```

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
