import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import type { AxiosInstance } from "axios";
import FormData from "form-data";
import fs from "fs";
import { OverleafSocket } from "./socket.js";
import { computeOtOps } from "./edit.js";

// Initialize MCP Server
const server = new McpServer({
    name: "unofficial-overleaf-mcp-server",
    version: "1.0.0",
});

// Environment setup
const OVERLEAF_COOKIE = process.env.OVERLEAF_COOKIE;
if (!OVERLEAF_COOKIE) {
    console.error("Error: OVERLEAF_COOKIE environment variable is required.");
    process.exit(1);
}

// Axios instance with cookies
const client: AxiosInstance = axios.create({
    baseURL: "https://www.overleaf.com",
    headers: {
        "Cookie": OVERLEAF_COOKIE,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    }
});

let currentCsrfToken: string | null = null;

async function getCsrfToken(): Promise<string> {
    if (currentCsrfToken !== null) return currentCsrfToken;

    const response = await client.get("/project");
    const html = response.data;

    let match = html.match(/meta\s+name="ol-csrfToken"\s+content="([^"]+)"/i);
    if (!match) {
        match = html.match(/window\.csrfToken\s*=\s*"([^"]+)"/);
    }
    if (!match) {
        match = html.match(/content="([^"]+)"\s+name="csrf-token"/i);
    }
    if (!match) {
        const csrfRegex = /csrf[-_]?token[^>]+content=["']([^"']+)["']/i;
        match = html.match(csrfRegex);
    }

    if (match && match[1]) {
        currentCsrfToken = match[1];
        return currentCsrfToken as string;
    }
    
    throw new Error("Could not find CSRF token in the Overleaf page.");
}

async function getHeaders() {
    const csrf = await getCsrfToken();
    return {
        "x-csrf-token": csrf
    };
}

// 1. overleaf_create_project
server.tool("overleaf_create_project",
    "Creates a new blank project in Overleaf.",
    {
        projectName: z.string().describe("The name of the project. A prefix 'agent_' will automatically be prepended to avoid conflicts."),
    },
    async ({ projectName }) => {
        try {
            const finalName = projectName.startsWith("agent_") ? projectName : "agent_" + projectName;
            const headers = await getHeaders();
            const payload = {
                projectName: finalName,
                template: "none"
            };
            
            const response = await client.post("/project/new", payload, { headers });
            
            return {
                content: [{ type: "text", text: "Project successfully created!\nProject ID: " + response.data.project_id + "\nName: " + finalName }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: "Failed to create project: " + error.message + "\n" + (error.response?.data ? JSON.stringify(error.response.data) : '') }],
                isError: true
            };
        }
    }
);

// 2. overleaf_upload_file
server.tool("overleaf_upload_file",
    "Uploads a file to a specific Overleaf project.",
    {
        projectId: z.string().describe("The ID of the Overleaf project."),
        filePath: z.string().describe("The absolute path to the local file to upload."),
        folderId: z.string().optional().describe("Optional folder ID in the project to upload to.")
    },
    async ({ projectId, filePath, folderId }) => {
        try {
            if (!fs.existsSync(filePath)) {
                throw new Error("File does not exist: " + filePath);
            }

            const headers = await getHeaders();
            const formData = new FormData();
            formData.append("qqfile", fs.createReadStream(filePath));
            
            let url = "/project/" + projectId + "/upload";
            if (folderId) {
                url += "?folder_id=" + folderId;
            }
            
            const reqHeaders = {
                ...headers,
                ...formData.getHeaders()
            };

            const response = await client.post(url, formData, { headers: reqHeaders });
            
            return {
                content: [{ type: "text", text: "File uploaded successfully!\nResponse: " + JSON.stringify(response.data) }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: "Failed to upload file: " + error.message + "\n" + (error.response?.data ? JSON.stringify(error.response.data) : '') }],
                isError: true
            };
        }
    }
);

// 3. overleaf_compile_and_download
server.tool("overleaf_compile_and_download",
    "Compiles the Overleaf project and downloads the resulting PDF.",
    {
        projectId: z.string().describe("The ID of the Overleaf project."),
        rootDocId: z.string().describe("The ID of the root document (e.g., main.tex)."),
        outputPath: z.string().describe("The absolute local path where the PDF should be saved.")
    },
    async ({ projectId, rootDocId, outputPath }) => {
        try {
            const headers = await getHeaders();
            
            const compilePayload = {
                rootDoc_id: rootDocId,
                rootResourcePath: "main.tex",
                draft: false,
                check: "silent",
                incrementalCompilesEnabled: true,
                stopOnFirstError: false
            };
            
            const compileRes = await client.post("/project/" + projectId + "/compile?auto_compile=true&enable_pdf_caching=true", compilePayload, { headers });
            
            const pdfUrl = "/project/" + projectId + "/output/output.pdf?compileGroup=standard";
            
            const pdfRes = await client.get(pdfUrl, {
                responseType: "stream"
            });
            
            const writer = fs.createWriteStream(outputPath);
            pdfRes.data.pipe(writer);
            
            await new Promise<void>((resolve, reject) => {
                writer.on('finish', () => resolve());
                writer.on('error', reject);
            });
            
            return {
                content: [{ type: "text", text: "Project compiled and PDF downloaded successfully to: " + outputPath }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: "Failed to compile/download: " + error.message + "\n" + (error.response?.data ? JSON.stringify(error.response.data) : '') }],
                isError: true
            };
        }
    }
);

// 4. overleaf_read_file
server.tool("overleaf_read_file",
    "Reads the full contents of a file in an Overleaf project.",
    {
        projectId: z.string().describe("The ID of the Overleaf project."),
        filePath: z.string().describe("The path of the document (e.g., main.tex or folder/file.tex)."),
    },
    async ({ projectId, filePath }) => {
        const socket = new OverleafSocket(projectId, OVERLEAF_COOKIE);
        try {
            await socket.connect();
            const docId = socket.resolveFilePathToDocId(filePath);
            if (!docId) {
                socket.disconnect();
                return { content: [{ type: "text", text: `File not found in project: ${filePath}` }], isError: true };
            }
            const result = await socket.joinDoc(docId);
            socket.disconnect();
            
            return {
                content: [{ type: "text", text: result.docLines.join("\n") }]
            };
        } catch (error: any) {
            socket.disconnect();
            return {
                content: [{ type: "text", text: "Failed to read file: " + error.message }],
                isError: true
            };
        }
    }
);

// 5. overleaf_edit_file
server.tool("overleaf_edit_file",
    "Edits a file in an Overleaf project using Operational Transformation. You can either replace a specific chunk of text, or replace the entire file content.",
    {
        projectId: z.string().describe("The ID of the Overleaf project."),
        filePath: z.string().describe("The path of the document to edit (e.g., main.tex)."),
        targetContent: z.string().optional().describe("The exact existing text you want to replace. If omitted, the entire file will be replaced by replacementContent."),
        replacementContent: z.string().describe("The new text to insert."),
    },
    async ({ projectId, filePath, targetContent, replacementContent }) => {
        const socket = new OverleafSocket(projectId, OVERLEAF_COOKIE);
        try {
            await socket.connect();
            const docId = socket.resolveFilePathToDocId(filePath);
            if (!docId) {
                socket.disconnect();
                return { content: [{ type: "text", text: `File not found in project: ${filePath}` }], isError: true };
            }
            const { docLines, version } = await socket.joinDoc(docId);
            const oldFullText = docLines.join("\n");
            
            let newFullText = replacementContent;
            if (targetContent) {
                if (!oldFullText.includes(targetContent)) {
                    socket.disconnect();
                    return {
                        content: [{ type: "text", text: "Error: targetContent was not found in the document." }],
                        isError: true
                    };
                }
                newFullText = oldFullText.replace(targetContent, replacementContent);
            }

            const ops = computeOtOps(oldFullText, newFullText);
            
            if (!ops || ops.length === 0) {
                socket.disconnect();
                return {
                    content: [{ type: "text", text: "No changes needed (target matches replacement)." }]
                };
            }

            await socket.applyOtUpdate(docId, {
                doc: docId,
                v: version,
                op: ops
            });

            socket.disconnect();
            return {
                content: [{ type: "text", text: "File successfully updated via Operational Transformation!" }]
            };
        } catch (error: any) {
            socket.disconnect();
            return {
                content: [{ type: "text", text: "Failed to edit file: " + error.message }],
                isError: true
            };
        }
    }
);

// 6. overleaf_list_files
server.tool("overleaf_list_files",
    "Lists all files and folders in an Overleaf project.",
    {
        projectId: z.string().describe("The ID of the Overleaf project."),
    },
    async ({ projectId }) => {
        const socket = new OverleafSocket(projectId, OVERLEAF_COOKIE);
        try {
            await socket.connect();
            
            // Format the tree
            const lines: string[] = [];
            const printFolder = (folder: any, prefix: string = "") => {
                for (const doc of folder.docs || []) {
                    lines.push(`${prefix}${doc.name}`);
                }
                for (const file of folder.fileRefs || []) {
                    lines.push(`${prefix}${file.name} (Binary/Image)`);
                }
                for (const sub of folder.folders || []) {
                    lines.push(`${prefix}${sub.name}/`);
                    printFolder(sub, prefix + sub.name + "/");
                }
            };
            
            if (socket.projectStructure && socket.projectStructure.rootFolder && socket.projectStructure.rootFolder.length > 0) {
                printFolder(socket.projectStructure.rootFolder[0]);
            }
            
            socket.disconnect();
            return {
                content: [{ type: "text", text: lines.join("\n") || "Project is empty." }]
            };
        } catch (error: any) {
            socket.disconnect();
            return {
                content: [{ type: "text", text: "Failed to list files: " + error.message }],
                isError: true
            };
        }
    }
);

// 7. overleaf_create_doc
server.tool("overleaf_create_doc",
    "Creates a new blank document in an Overleaf project.",
    {
        projectId: z.string().describe("The ID of the Overleaf project."),
        name: z.string().describe("The name of the new document (e.g. 'newfile.tex')."),
        parentFolderPath: z.string().optional().describe("The path of the parent folder. Leave empty for root."),
    },
    async ({ projectId, name, parentFolderPath }) => {
        try {
            const socket = new OverleafSocket(projectId, OVERLEAF_COOKIE);
            await socket.connect();
            let parent_folder_id = socket.projectStructure?.rootFolder[0]?._id;
            
            if (parentFolderPath && parentFolderPath !== "/" && parentFolderPath !== "") {
                const entity = socket.resolvePathToEntity(parentFolderPath);
                if (!entity || entity.type !== "folder") {
                    socket.disconnect();
                    return { content: [{ type: "text", text: `Parent folder not found: ${parentFolderPath}` }], isError: true };
                }
                parent_folder_id = entity.id;
            }
            socket.disconnect();

            const headers = await getHeaders();
            const response = await client.post(`/project/${projectId}/doc`, {
                name,
                parent_folder_id
            }, { headers });
            
            return {
                content: [{ type: "text", text: `Document created successfully! ID: ${response.data._id}` }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: "Failed to create document: " + error.message }],
                isError: true
            };
        }
    }
);

// 8. overleaf_create_folder
server.tool("overleaf_create_folder",
    "Creates a new folder in an Overleaf project.",
    {
        projectId: z.string().describe("The ID of the Overleaf project."),
        name: z.string().describe("The name of the new folder."),
        parentFolderPath: z.string().optional().describe("The path of the parent folder. Leave empty for root."),
    },
    async ({ projectId, name, parentFolderPath }) => {
        try {
            const socket = new OverleafSocket(projectId, OVERLEAF_COOKIE);
            await socket.connect();
            let parent_folder_id = socket.projectStructure?.rootFolder[0]?._id;
            
            if (parentFolderPath && parentFolderPath !== "/" && parentFolderPath !== "") {
                const entity = socket.resolvePathToEntity(parentFolderPath);
                if (!entity || entity.type !== "folder") {
                    socket.disconnect();
                    return { content: [{ type: "text", text: `Parent folder not found: ${parentFolderPath}` }], isError: true };
                }
                parent_folder_id = entity.id;
            }
            socket.disconnect();

            const headers = await getHeaders();
            const response = await client.post(`/project/${projectId}/folder`, {
                name,
                parent_folder_id
            }, { headers });
            
            return {
                content: [{ type: "text", text: `Folder created successfully! ID: ${response.data._id}` }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: "Failed to create folder: " + error.message }],
                isError: true
            };
        }
    }
);

// 9. overleaf_delete_entity
server.tool("overleaf_delete_entity",
    "Deletes a document, file, or folder from an Overleaf project.",
    {
        projectId: z.string().describe("The ID of the Overleaf project."),
        path: z.string().describe("The full path to the entity to delete (e.g. 'main.tex' or 'folder/image.png')."),
    },
    async ({ projectId, path }) => {
        try {
            const socket = new OverleafSocket(projectId, OVERLEAF_COOKIE);
            await socket.connect();
            const entity = socket.resolvePathToEntity(path);
            socket.disconnect();
            
            if (!entity) {
                return { content: [{ type: "text", text: `Entity not found: ${path}` }], isError: true };
            }

            const headers = await getHeaders();
            let url = `/project/${projectId}/${entity.type}/${entity.id}`;
            await client.delete(url, { headers });
            
            return {
                content: [{ type: "text", text: `Successfully deleted ${entity.type} at ${path}` }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: "Failed to delete: " + error.message }],
                isError: true
            };
        }
    }
);

// 10. overleaf_move_entity
server.tool("overleaf_move_entity",
    "Moves a document, file, or folder to a new folder.",
    {
        projectId: z.string().describe("The ID of the Overleaf project."),
        path: z.string().describe("The full path to the entity to move (e.g. 'main.tex')."),
        newParentFolderPath: z.string().describe("The path to the destination folder (e.g. 'my-folder'). Use '/' for root."),
    },
    async ({ projectId, path, newParentFolderPath }) => {
        try {
            const socket = new OverleafSocket(projectId, OVERLEAF_COOKIE);
            await socket.connect();
            
            const entity = socket.resolvePathToEntity(path);
            if (!entity) {
                socket.disconnect();
                return { content: [{ type: "text", text: `Entity not found: ${path}` }], isError: true };
            }
            
            let destFolderId = socket.projectStructure?.rootFolder[0]?._id;
            if (newParentFolderPath && newParentFolderPath !== "/" && newParentFolderPath !== "") {
                const destEntity = socket.resolvePathToEntity(newParentFolderPath);
                if (!destEntity || destEntity.type !== "folder") {
                    socket.disconnect();
                    return { content: [{ type: "text", text: `Destination folder not found: ${newParentFolderPath}` }], isError: true };
                }
                destFolderId = destEntity.id;
            }
            
            socket.disconnect();

            const headers = await getHeaders();
            const url = `/project/${projectId}/${entity.type}/${entity.id}/move`;
            await client.post(url, { folder_id: destFolderId }, { headers });
            
            return {
                content: [{ type: "text", text: `Successfully moved ${path} to ${newParentFolderPath}` }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: "Failed to move: " + error.message }],
                isError: true
            };
        }
    }
);

// Start the server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Unofficial Overleaf MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
