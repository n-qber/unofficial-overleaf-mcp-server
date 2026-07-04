# Unofficial Overleaf MCP Server

An unofficial Model Context Protocol (MCP) server that provides AI agents with the ability to interact with Overleaf projects directly. This server allows agents to create projects, list files, read contents, manage files, and securely edit documents in real-time using Overleaf's native Operational Transformation (ShareJS) WebSocket protocol.

## Features

- **Project Management**: Create new Overleaf projects natively.
- **File System (CRUD)**: List, upload, create, move, and delete files or folders within an Overleaf project.
- **Real-Time Document Editing**: Edits files natively without full ZIP downloads. Utilizes a reverse-engineered Socket.IO 0.9 shim and the `diff-match-patch` library to translate semantic edits into precise ShareJS `text0` Operational Transformation (OT) updates.
- **Compilation**: Trigger server-side LaTeX compilation and download the resulting PDF.

## Prerequisites

- Node.js (v18+)
- An active Overleaf account.

## Configuration

This MCP Server authenticates to Overleaf using a session cookie. You must provide the `OVERLEAF_COOKIE` environment variable to run the server.

1. Log into your Overleaf account in your browser.
2. Open the Developer Tools (F12) -> Application / Storage -> Cookies.
3. Find the `overleaf_session2` cookie.
4. Set the value as an environment variable (or include it in your MCP configuration).

### Adding to Antigravity IDE / Gemini

To use this server directly inside the Antigravity IDE or Gemini agents, add the following configuration to `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": [
        "/absolute/path/to/unofficial-overleaf-mcp-server/build/index.js"
      ],
      "env": {
        "OVERLEAF_COOKIE": "overleaf_session2=s%3A..."
      }
    }
  }
}
```

## Available MCP Tools

* `overleaf_create_project(projectName)`
* `overleaf_list_files(projectId)`
* `overleaf_read_file(projectId, filePath)`
* `overleaf_edit_file(projectId, filePath, targetContent, replacementContent)`
* `overleaf_create_doc(projectId, name, parentFolderPath)`
* `overleaf_create_folder(projectId, name, parentFolderPath)`
* `overleaf_upload_file(projectId, filePath, folderId)`
* `overleaf_move_entity(projectId, path, newParentFolderPath)`
* `overleaf_delete_entity(projectId, path)`
* `overleaf_compile_and_download(projectId, rootDocId, outputPath)`

## Security Note

This server requires your Overleaf session cookie to operate. **Do not commit your session cookie or any specific project IDs into version control.**

## Build

```bash
npm install
npm run build
```

## Usage

```bash
npm start
```
