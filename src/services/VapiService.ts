import Vapi from "@vapi-ai/web";

export class VapiService {
  private vapi: Vapi | null = null;
  private callStartTime: number = 0;

  async initializeAudio() {
    // VAPI handles audio internally — no-op
  }

  async connect(config: {
    vapiPublicKey: string;
    vapiAssistantId: string;
    onTranscription?: (text: string, isUser: boolean) => void;
    onStatusChange?: (status: string, error?: string) => void;
    onVolumeChange?: (volume: number) => void;
  }) {
    try {
      if (this.vapi) await this.disconnect();

      this.vapi = new Vapi(config.vapiPublicKey);

      this.vapi.on("call-start", () => {
        this.callStartTime = Date.now();
        config.onStatusChange?.("connected");
      });

      this.vapi.on("call-end", () => {
        const durationSeconds = Math.round((Date.now() - this.callStartTime) / 1000);
        // Report duration to server for cost tracking
        this.reportCallEnded(durationSeconds, config.vapiAssistantId);
        config.onStatusChange?.("disconnected");
      });

      this.vapi.on("speech-start", () => {
        // AI started speaking
      });

      this.vapi.on("speech-end", () => {
        // AI stopped speaking
      });

      this.vapi.on("message", (message: any) => {
        if (message.type === "transcript" && message.transcriptType === "final") {
          const isUser = message.role === "user";
          config.onTranscription?.(message.transcript, isUser);
        }
      });

      this.vapi.on("volume-level", (level: number) => {
        config.onVolumeChange?.(level);
      });

      this.vapi.on("error", (error: any) => {
        console.error("[VAPI] Error:", error);
        config.onStatusChange?.("error", error?.message || "VAPI error");
      });

      await this.vapi.start(config.vapiAssistantId);
    } catch (err: any) {
      console.error("[VAPI] Failed to connect:", err);
      config.onStatusChange?.("error", err.message || "Failed to connect");
      throw err;
    }
  }

  async disconnect() {
    if (this.vapi) {
      try {
        this.vapi.stop();
      } catch (e) {}
      this.vapi = null;
    }
  }

  private async reportCallEnded(durationSeconds: number, assistantId: string) {
    try {
      await fetch("/api/vapi/call-ended", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ durationSeconds, assistantId }),
      });
    } catch (e) {
      console.warn("[VAPI] Failed to report call cost:", e);
    }
  }
}
