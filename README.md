# CodeDeck CLI Bridge Docker

A lightweight Docker setup to run the CodeDeck CLI bridge with automated GitHub authentication, Git identity configuration, and automatic repository cloning.

## Features

* **Automated Git Auth:** Seamlessly injects `GITHUB_TOKEN` to handle private and public repositories without interactive prompts.
* **Persistent Workspaces:** Automatically clones or pulls your target `GIT_REPO` into the data volume on startup.
* **Pre-configured Identity:** Sets up Git `user.name` and `user.email` automatically inside the container.
* **Ready-to-Run:** Designed for seamless pairing with the CodeDeck mobile app via Nostr relays.

## Environment Variables

Create a `.env` file in the root directory with the following variables:

`Use your own values for the placeholders below`
```env
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...
GITHUB_TOKEN=ghp_...
GIT_USER=your_username
GIT_EMAIL=your_email@example.com
GIT_REPO=https://github.com/your-username/your-repo.git
```

## Quick Start

1. Build and start the container using Docker Compose:
```bash
docker compose up -d --build
```

2. Check the logs to scan the pairing QR code with your CodeDeck app:
```bash
docker compose logs -f codedeck-bridge
```

## Related repos

- [codedeck-next-mobile](https://github.com/JeroenOnNostr/codedeck-next-mobile) — Android app
- [codedeck-next-bridge](https://github.com/JeroenOnNostr/codedeck-next-bridge) — headless CLI / VPS bridge