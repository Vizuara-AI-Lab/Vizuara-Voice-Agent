import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: ".env.local" });

const app = express();
const PORT = parseInt(process.env.PORT || "3000");

// --- Serve static files (production build) ---
app.use(express.static(path.join(import.meta.dirname, "dist")));

// --- Health check ---
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// --- SPA fallback ---
app.get("*", (_req, res) => {
  res.sendFile(path.join(import.meta.dirname, "dist", "index.html"));
});

// --- HTTP Server + WebSocket ---
const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url!, `http://${request.headers.host}`).pathname;

  if (pathname === "/ws/openai-realtime") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  }
});

// --- OpenAI Realtime Proxy ---
wss.on("connection", (clientWs, req) => {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    clientWs.send(
      JSON.stringify({ type: "proxy.error", error: "OPENAI_API_KEY not set on server" })
    );
    clientWs.close();
    return;
  }

  console.log("[OpenAI Proxy] Client connected, opening upstream...");

  const clientUrl = new URL(req.url!, `http://${req.headers.host}`);
  const requestedModel = clientUrl.searchParams.get("model") || "gpt-4o-realtime-preview";
  const allowedModels = ["gpt-4o-realtime-preview", "gpt-4o-mini-realtime-preview"];
  const model = allowedModels.includes(requestedModel)
    ? requestedModel
    : "gpt-4o-realtime-preview";

  const upstreamUrl = `wss://api.openai.com/v1/realtime?model=${model}`;
  console.log(`[OpenAI Proxy] Using model: ${model}`);

  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  upstream.on("open", () => {
    console.log("[OpenAI Proxy] Upstream connected");
    clientWs.send(JSON.stringify({ type: "proxy.connected" }));
  });

  upstream.on("message", (data) => {
    const str = data.toString();
    try {
      const parsed = JSON.parse(str);
      if (
        ["session.created", "session.updated", "error", "response.done"].includes(parsed.type)
      ) {
        console.log(
          `[OpenAI Proxy] Upstream >> ${parsed.type}`,
          parsed.type === "error" ? parsed.error : ""
        );
      }
    } catch {}
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(str);
    }
  });

  upstream.on("close", (code, reason) => {
    console.log(`[OpenAI Proxy] Upstream closed: ${code} ${reason}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close();
    }
  });

  upstream.on("error", (err) => {
    console.error("[OpenAI Proxy] Upstream error:", err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: "proxy.error", error: err.message }));
      clientWs.close();
    }
  });

  clientWs.on("message", (data) => {
    const str = data.toString();
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === "session.update") {
        console.log(
          `[OpenAI Proxy] Client >> session.update modalities=${JSON.stringify(parsed.session?.modalities)}`
        );
      }
    } catch {}
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(str);
    }
  });

  clientWs.on("close", () => {
    console.log("[OpenAI Proxy] Client disconnected");
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n  Voice Agent server running on http://localhost:${PORT}\n`);
});
