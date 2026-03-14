import Vapi from "@vapi-ai/web";

export class VapiService {
  private vapi: Vapi | null = null;
  private callStartTime: number = 0;
  private callId: string | null = null;
  private serverUrl: string = "";

  getCallId(): string | null {
    return this.callId;
  }

  async initializeAudio() {
    // Explicitly probe mic access so a denied/missing permission surfaces
    // as a clear error before VAPI silently starts without user audio.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  }

  async connect(config: {
    serverUrl?: string;
    vapiPublicKey: string;
    vapiAssistantId: string;
    onTranscription?: (text: string, isUser: boolean) => void;
    onStatusChange?: (status: string, error?: string) => void;
    onVolumeChange?: (volume: number) => void;
  }) {
    try {
      if (this.vapi) await this.disconnect();
      this.serverUrl = config.serverUrl || "";

      this.callId = null;
      this.vapi = new Vapi(config.vapiPublicKey);

      this.vapi.on("call-start", () => {
        this.callStartTime = Date.now();
        // Try to capture call ID from the VAPI instance
        try {
          const id = (this.vapi as any)?.call?.id;
          if (id) this.callId = id;
        } catch {}
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
        // Capture call ID from any message that contains it
        if (!this.callId && message?.call?.id) {
          this.callId = message.call.id;
        }
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

      const call = await this.vapi.start(config.vapiAssistantId, {
        transcriber: {
          provider: "deepgram",
          model: "nova-2",
          language: "en",
          endpointing: 400,
        },
        // Stop speaking: react quickly when user interrupts (VAD-based, 0 words)
        // but require 0.3s of voice activity to avoid false triggers from noise
        stopSpeakingPlan: {
          numWords: 0,
          voiceSeconds: 0.3,
          backoffSeconds: 1.0,
        },
        // Start speaking: wait a bit after user stops to capture full utterance
        startSpeakingPlan: {
          waitSeconds: 0.6,
          smartEndpointingEnabled: true,
        },
        backgroundDenoisingEnabled: true,
      } as any);
      this.callId = (call as any)?.id || null;
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
    // Don't clear callId here — widget needs it for feedback submission
    // It gets reset on next connect() call
  }

  private async reportCallEnded(durationSeconds: number, assistantId: string) {
    try {
      await fetch(`${this.serverUrl}/api/vapi/call-ended`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ durationSeconds, assistantId }),
      });
    } catch (e) {
      console.warn("[VAPI] Failed to report call cost:", e);
    }
  }
}
