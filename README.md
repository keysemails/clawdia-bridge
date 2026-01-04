# Claudia Bridge

HTTP bridge that allows **Claudia** (a Vapi voice assistant) to communicate with **Clawdius** (an AI assistant running on Clawdis).

## What is this?

When you call Claudia on the phone, she can ask Clawdius questions on your behalf. This bridge handles that communication.

```
You (phone call)
    ↓
Claudia (Vapi voice AI)
    ↓ function call: ask_clawdius
Claudia Bridge (this service)
    ↓ forwards question
Clawdius
    ↓ processes & responds
Claudia Bridge
    ↓ returns answer
Claudia
    ↓ speaks response
You
```

## Quick Start

```bash
# Clone
git clone https://github.com/alejandroOPI/claudia-bridge.git
cd claudia-bridge

# Set environment variables
export BRIDGE_PORT=3847
export BRIDGE_TOKEN=your-secret-token

# Run
npm start
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_PORT` | `3847` | Port to listen on |
| `BRIDGE_TOKEN` | `claudia-secret-token` | Bearer token for authentication |
| `CLAWDIUS_WEBHOOK` | `null` | Optional webhook URL to notify Clawdius |

## API Endpoints

### POST /ask

Claudia calls this endpoint to ask Clawdius a question.

**Headers:**
```
Authorization: Bearer your-secret-token
Content-Type: application/json
```

**Request:**
```json
{
  "question": "What's on my calendar today?",
  "context": "User is Alejandro, calling from phone"
}
```

**Response:**
```json
{
  "answer": "You have 3 meetings today...",
  "timestamp": "2026-01-04T15:30:00Z"
}
```

### POST /respond/:requestId

Clawdius calls this endpoint to respond to a pending question.

**Request:**
```json
{
  "answer": "You have 3 meetings: standup at 10am, lunch at 1pm, review at 4pm."
}
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "service": "claudia-bridge",
  "pendingRequests": 0,
  "timestamp": "2026-01-04T15:30:00Z"
}
```

### GET /pending

List pending requests (for debugging).

## Exposing to the Internet

The bridge needs to be accessible from the internet for Vapi to call it.

### Option 1: Tailscale Funnel (Recommended)

```bash
# Start the server
npm start

# In another terminal, expose via Tailscale
tailscale funnel 3847
```

Your URL will be: `https://your-machine.tail[xxx].ts.net/`

### Option 2: ngrok

```bash
npm start
ngrok http 3847
```

### Option 3: Deploy to Cloud

Deploy to Railway, Render, Fly.io, etc.

## Configuring Vapi

Add this tool to your Claudia assistant in the Vapi dashboard:

```json
{
  "type": "function",
  "function": {
    "name": "ask_clawdius",
    "description": "Ask Clawdius for information or to perform an action. Use this when you need to check calendar, emails, weather, or any information that Clawdius has access to.",
    "parameters": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string",
          "description": "The question or request for Clawdius"
        }
      },
      "required": ["question"]
    }
  },
  "server": {
    "url": "https://your-server.com/ask",
    "headers": {
      "Authorization": "Bearer your-secret-token"
    }
  }
}
```

## How the Flow Works

1. You call Claudia's phone number
2. You ask: "What's on my calendar today?"
3. Claudia recognizes she needs to ask Clawdius
4. Claudia calls `POST /ask` with your question
5. The bridge creates a pending request and logs it
6. Clawdius sees the pending request and processes it
7. Clawdius calls `POST /respond/:id` with the answer
8. The bridge returns the answer to Claudia
9. Claudia speaks the answer to you

## Integration with Clawdis

The bridge logs all questions with `CLAWDIUS_QUESTION` level. Configure your Clawdis instance to:

1. Watch the bridge logs, or
2. Receive webhook notifications (set `CLAWDIUS_WEBHOOK`), or
3. Poll `GET /pending` for new questions

## Development

```bash
# Run with auto-reload
npm run dev

# Test locally
curl http://localhost:3847/health

curl -X POST http://localhost:3847/ask \
  -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"question": "What time is it?"}'
```

## License

MIT
