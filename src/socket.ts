import WebSocket from "ws";
import axios from "axios";

export interface OtUpdate {
  doc: string;
  op?: Array<{ p: number; i?: string; d?: string; u?: boolean }>;
  v: number;
  lastV?: number;
  hash?: string;
}

export interface JoinDocResult {
  docLines: string[];
  version: number;
  updates: unknown[];
  ranges: unknown;
}

function decodePackedUtf8(line: string): string {
  return Buffer.from(line, "latin1").toString("utf8");
}

function mergeSetCookies(existing: string, responseHeaders: any): string {
  const setCookie = responseHeaders['set-cookie'];
  if (!setCookie) return existing;
  
  const existingNames = new Set(existing.split(";").map((p) => p.split("=")[0].trim().toLowerCase()));
  const adds: string[] = [];
  
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const sc of cookies) {
    const first = sc.split(";")[0].trim();
    const name = first.split("=")[0].trim().toLowerCase();
    if (!name || existingNames.has(name)) continue;
    adds.push(first);
    existingNames.add(name);
  }
  
  if (!adds.length) return existing;
  return `${existing}; ${adds.join("; ")}`;
}

export class OverleafSocket {
  private ws: WebSocket | null = null;
  private nextAckId = 1;
  private pending = new Map<number, { resolve: (data: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private heartbeatInterval = 60000;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cookie: string;
  public projectStructure: any = null;

  constructor(public projectId: string, cookie: string) {
    this.cookie = cookie;
  }

  async connect(timeoutMs = 15000): Promise<void> {
    const t = Date.now();
    const hsUrl = `https://www.overleaf.com/socket.io/1/?projectId=${encodeURIComponent(this.projectId)}&t=${t}`;
    
    const hsRes = await axios.get(hsUrl, {
      headers: {
        'Cookie': this.cookie,
        'Origin': 'https://www.overleaf.com',
        'Connection': 'keep-alive'
      },
      validateStatus: () => true
    });

    if (hsRes.status !== 200) {
      throw new Error(`Socket.IO handshake returned ${hsRes.status}`);
    }

    const hsBody = hsRes.data;
    const [sid, hbStr, , transports] = hsBody.split(":");
    if (!sid || !transports?.includes("websocket")) {
      throw new Error(`Invalid handshake response: ${hsBody}`);
    }

    this.heartbeatInterval = Math.max(15000, (Number(hbStr) || 60) * 1000 - 5000);
    const upgradeCookie = mergeSetCookies(this.cookie, hsRes.headers);
    const wsUrl = `wss://www.overleaf.com/socket.io/1/websocket/${sid}`;

    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: upgradeCookie, Origin: 'https://www.overleaf.com' },
      handshakeTimeout: timeoutMs,
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const settleTimer = setTimeout(() => reject(new Error("WS upgrade timeout")), timeoutMs);
      
      ws.once("open", () => {
        clearTimeout(settleTimer);
        this.startHeartbeats();
        
        let joined = false;
        
        // Listen for joinProjectResponse
        const onMsg = (data: any) => {
          const frame = data.toString("utf8");
          if (frame.startsWith("5:::")) {
             try {
                 const obj = JSON.parse(frame.slice(4));
                 if (obj.name === "joinProjectResponse") {
                     joined = true;
                     this.projectStructure = obj.args[0].project;
                     ws.off("message", onMsg);
                     resolve();
                 }
             } catch {}
          }
        };
        ws.on("message", onMsg);
        
        // Fallback explicit emit
        setTimeout(() => {
          if (!joined) {
            this.emit("joinProject", [{ project_id: this.projectId }]).then((res: any) => {
              const proj = Array.isArray(res) ? res[0] : res;
              this.projectStructure = proj;
              resolve();
            }).catch(reject);
          }
        }, 3000);
      });
      
      ws.once("error", (err) => {
        clearTimeout(settleTimer);
        reject(err);
      });
      
      ws.on("message", (data) => this.handleFrame(data.toString("utf8")));
      
      ws.once("close", () => {
        this.stopHeartbeats();
        for (const [, p] of this.pending) p.reject(new Error("socket closed"));
        this.pending.clear();
      });
    });
  }

  private startHeartbeats() {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send("2::"); } catch {}
      }
    }, this.heartbeatInterval);
  }

  private stopHeartbeats() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private handleFrame(frame: string) {
    if (!frame) return;
    const m = frame.match(/^(\d+):([^:]*):([^:]*):?([\s\S]*)$/);
    if (!m) return;
    
    const type = m[1];
    const data = m[4];
    
    if (type === "2") {
      try { this.ws?.send("2::"); } catch {}
    } else if (type === "6") {
      const plus = data.indexOf("+");
      const ackIdStr = plus >= 0 ? data.slice(0, plus) : data;
      const ackDataRaw = plus >= 0 ? data.slice(plus + 1) : "";
      const ackId = Number(ackIdStr);
      
      const pending = this.pending.get(ackId);
      if (!pending) return;
      this.pending.delete(ackId);
      clearTimeout(pending.timer);
      
      let arr: any[] = [];
      if (ackDataRaw) {
        try { arr = JSON.parse(ackDataRaw); } catch { arr = [ackDataRaw]; }
        if (!Array.isArray(arr)) arr = [arr];
      }
      
      const err = arr[0];
      if (err) pending.reject(new Error(typeof err === "string" ? err : JSON.stringify(err)));
      else pending.resolve(arr.slice(1));
    }
  }

  async emit<T = any>(name: string, args: any[] = [], timeoutMs = 15000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("socket not open");
    const ackId = this.nextAckId++;
    const frame = `5:${ackId}+::${JSON.stringify({ name, args })}`;
    
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ackId);
        reject(new Error(`event '${name}' timed out`));
      }, timeoutMs);
      
      this.pending.set(ackId, {
        resolve: (data) => resolve((data.length <= 1 ? data[0] : data) as T),
        reject,
        timer,
      });
      
      try { this.ws!.send(frame); } catch (e) {
        clearTimeout(timer);
        this.pending.delete(ackId);
        reject(e as Error);
      }
    });
  }

  async joinDoc(docId: string): Promise<JoinDocResult> {
    const ret = await this.emit("joinDoc", [docId, { encodeRanges: true }]);
    const tuple = Array.isArray(ret) ? ret : [ret];
    const [docLinesAscii, version, updates, ranges] = tuple as [string[], number, any[], any];
    const docLines = (docLinesAscii ?? []).map(decodePackedUtf8);
    return { docLines, version: version ?? 0, updates: updates ?? [], ranges };
  }

  async leaveDoc(docId: string): Promise<void> {
    await this.emit("leaveDoc", [docId]).catch(() => {});
  }

  async applyOtUpdate(docId: string, update: OtUpdate): Promise<void> {
    await this.emit("applyOtUpdate", [docId, update]);
  }

  disconnect() {
    this.stopHeartbeats();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  resolvePathToEntity(targetPath: string): { id: string, type: 'doc' | 'file' | 'folder' } | null {
    if (!this.projectStructure) return null;
    if (targetPath === '/' || targetPath === '') return { id: this.projectStructure.rootFolder[0]._id, type: 'folder' };
    
    const parts = targetPath.split('/').filter(p => p);
    let currentFolder = this.projectStructure.rootFolder[0];
    
    for (let i = 0; i < parts.length - 1; i++) {
        const folderName = parts[i];
        const nextFolder = currentFolder.folders.find((f: any) => f.name === folderName);
        if (!nextFolder) return null;
        currentFolder = nextFolder;
    }
    
    const targetName = parts[parts.length - 1];
    
    const doc = currentFolder.docs.find((d: any) => d.name === targetName);
    if (doc) return { id: doc._id, type: 'doc' };
    
    const file = currentFolder.fileRefs?.find((f: any) => f.name === targetName);
    if (file) return { id: file._id, type: 'file' };
    
    const folder = currentFolder.folders.find((f: any) => f.name === targetName);
    if (folder) return { id: folder._id, type: 'folder' };
    
    return null;
  }

  resolveFilePathToDocId(targetPath: string): string | null {
      const entity = this.resolvePathToEntity(targetPath);
      return (entity && entity.type === 'doc') ? entity.id : null;
  }
}
