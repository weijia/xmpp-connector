# OpenClaw XMPP Connector

XMPP channel plugin for OpenClaw — supports username/password authentication and message exchange.

## Features

- Supports XMPP messaging with username/password authentication
- Real-time message receiving and sending
- Integration with OpenClaw Gateway for AI responses
- Configurable server settings
- Debug mode for troubleshooting

## Installation

```bash
npm install openclaw-xmpp-connector
```

## Configuration

Add the following configuration to your OpenClaw config file:

```json
{
  "channels": {
    "xmpp-connector": {
      "username": "your-username",
      "password": "your-password",
      "server": "xmpp-server.com",
      "port": 5222,
      "gatewayToken": "your-openclaw-gateway-token",
      "debug": false
    }
  }
}
```

## Usage

Once configured, the XMPP connector will automatically:

1. Connect to the specified XMPP server
2. Send online presence
3. Receive incoming messages
4. Process messages through OpenClaw Gateway
5. Send AI responses back to the sender

## Development

### Prerequisites

- Node.js 14+
- OpenClaw Gateway running on localhost:18789

### Testing

```bash
# Run the test script
node simple-test.js
```

### Building

No build is required as the plugin uses TypeScript directly with jiti.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Repository

[https://github.com/weijia/xmpp-connector](https://github.com/weijia/xmpp-connector)