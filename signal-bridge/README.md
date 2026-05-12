# Signal Bridge — Pi Extension

Bridge your pi coding agent to Signal messenger. Type in Signal, get pi responses back.

## Prerequisites

- **Java 25+** (macOS/Windows) — signal-cli runs on the JVM
  ```bash
  brew install openjdk
  # or download from https://adoptium.net/
  ```
- A **Signal account** with a registered phone number
- A second Signal number or the same number (linked as secondary device)

## Setup (one-time)

### 1. Install Java (if not installed)

```bash
brew install openjdk
sudo ln -sfn $(brew --prefix openjdk)/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk.jdk
```

### 2. Link your Signal account

You can either **register a new number** or **link as a secondary device** to your existing Signal account.

**Option A — Link to your existing account (recommended):**

```bash
cd ~/.pi/agent/extensions/signal-bridge
npx signal-sdk connect "Pi Bot"
```

This prints a QR code. Scan it from:
**Signal app → Settings → Linked Devices → Link New Device**

**Option B — Register a new number:**

```bash
cd ~/.pi/agent/extensions/signal-bridge
./node_modules/signal-sdk/bin/signal-cli -a +YOUR_PHONE register
./node_modules/signal-sdk/bin/signal-cli -a +YOUR_PHONE verify CODE
```

### 3. Configure in pi

Start pi, then use the slash commands:

```
/signal setup +YOUR_PHONE +ALLOWED_CONTACT_PHONE
/signal connect
```

- `+YOUR_PHONE` — the Signal number you linked/registered above
- `+ALLOWED_CONTACT_PHONE` — the phone number allowed to send messages to pi

### 4. Send a message from Signal!

Open Signal on your phone, message the linked number, and pi will respond.

## Slash Commands

| Command | Description |
|---|---|
| `/signal` | Show help |
| `/signal setup <phone> <contact>` | Configure account and first allowed contact |
| `/signal add <phone>` | Add another allowed contact |
| `/signal link` | Show device linking instructions |
| `/signal connect` | Start the bridge |
| `/signal disconnect` | Stop the bridge |
| `/signal status` | Show connection status |

## How It Works

1. Extension connects to `signal-cli` via JSON-RPC (spawned as subprocess)
2. Incoming Signal messages from allowed contacts are injected into pi as user messages
3. After pi completes its response, the assistant reply is sent back via Signal
4. Messages are prefixed with `[Signal from +number]:` so pi knows the source

## Config File

Stored at `~/.pi/.secrets/signal-bridge.json` (mode 600):

```json
{
  "account": "+15551234567",
  "allowedContacts": ["+15559876543"]
}
```

## Troubleshooting

- **"Java not found"** — Install Java 25+: `brew install openjdk`
- **Connection timeout** — Make sure you've linked/registered first
- **Messages not arriving** — Check that the sender's number is in `allowedContacts`
- **signal-cli errors** — Run `cd ~/.pi/agent/extensions/signal-bridge && ./node_modules/signal-sdk/bin/signal-cli -a +YOUR_PHONE daemon --json-rpc` manually to debug
