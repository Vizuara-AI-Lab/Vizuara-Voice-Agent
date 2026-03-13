import { AudioService } from "./AudioService";
import { LatencyTracker } from "./LatencyTracker";

const VOICE_MAP: Record<string, string> = {
  Puck: "alloy",
  Charon: "echo",
  Kore: "coral",
  Fenrir: "ash",
  Zephyr: "sage",
};

export class OpenAIRealtimeService {
  private ws: WebSocket | null = null;
  private audioService: AudioService;
  private latencyTracker = new LatencyTracker();
  private modelSpeaking = false;

  constructor() {
    this.audioService = new AudioService(24000);
  }

  async initializeAudio() {
    await this.audioService.initialize();
  }

  async connect(config: {
    serverUrl?: string;
    systemInstruction: string;
    voiceName: string;
    silenceDurationMs?: number;
    transcriptionLanguage?: string;
    openaiModel?: string;
    onTranscription?: (text: string, isUser: boolean) => void;
    onStatusChange?: (status: string, error?: string) => void;
    onVolumeChange?: (volume: number) => void;
    onTimeWarning?: () => void;
    onTimeExceeded?: () => void;
    delayMicUntilGreeting?: boolean;
  }) {
    try {
      if (this.ws) await this.disconnect();
      this.latencyTracker.reset();

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const model = config.openaiModel || "gpt-4o-realtime-preview";
      const base = config.serverUrl
        ? config.serverUrl.replace(/^http/, "ws")
        : `${protocol}//${window.location.host}`;
      const wsUrl = `${base}/ws/openai-realtime?model=${model}`;

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log("[OpenAI] WebSocket to proxy opened");
      };

      this.ws.onclose = () => {
        config.onStatusChange?.("disconnected");
        this.audioService.stopRecording();
      };

      this.ws.onerror = (ev) => {
        console.error("[OpenAI] WebSocket error:", ev);
        config.onStatusChange?.("error", "WebSocket connection failed");
      };

      let currentModelTranscript = "";
      let currentModelText = "";

      const openaiVoice = VOICE_MAP[config.voiceName] || "sage";
      const transcriptionConfig: any = { model: "whisper-1" };
      if (config.transcriptionLanguage) {
        transcriptionConfig.language = config.transcriptionLanguage;
      }

      const sessionConfig: any = {
        modalities: ["text", "audio"],
        instructions: config.systemInstruction,
        voice: openaiVoice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: transcriptionConfig,
        turn_detection: {
          type: "server_vad",
          threshold: 0.8,
          prefix_padding_ms: 500,
          silence_duration_ms: config.silenceDurationMs ?? 500,
        },
        input_audio_noise_reduction: { type: "near_field" },
      };

      const sessionUpdate: any = {
        type: "session.update",
        session: sessionConfig,
      };

      let sessionConfigured = false;
      let micStarted = false;

      const startMic = () => {
        if (micStarted) return;
        micStarted = true;
        this.audioService.startRecording(
          (base64Data) => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(
                JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: base64Data,
                })
              );
            }
          },
          (volume: number) => {
            config.onVolumeChange?.(volume);
          }
        );
      };

      this.ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case "proxy.connected": {
            this.ws?.send(JSON.stringify(sessionUpdate));
            break;
          }

          case "proxy.error": {
            config.onStatusChange?.("error", msg.error || "Proxy error");
            break;
          }

          case "proxy.time_warning": {
            console.log(`[OpenAI] Time warning: ${msg.remainingSeconds}s remaining`);
            config.onTimeWarning?.();
            break;
          }

          case "proxy.time_exceeded": {
            console.log(`[OpenAI] Time limit exceeded after ${msg.durationSeconds}s`);
            config.onTimeExceeded?.();
            break;
          }

          case "session.created": {
            this.ws?.send(JSON.stringify(sessionUpdate));
            break;
          }

          case "session.updated": {
            if (!sessionConfigured) {
              sessionConfigured = true;
              config.onStatusChange?.("connected");
              if (!config.delayMicUntilGreeting) {
                startMic();
              }
            }
            break;
          }

          case "response.audio.delta": {
            if (msg.delta) {
              this.modelSpeaking = true;
              this.latencyTracker.onFirstModelAudio();
              this.audioService.playAudioChunk(msg.delta);
            }
            break;
          }

          case "response.audio_transcript.delta": {
            if (msg.delta) currentModelTranscript += msg.delta;
            break;
          }

          case "response.audio_transcript.done": {
            if (currentModelTranscript) {
              config.onTranscription?.(currentModelTranscript, false);
              currentModelTranscript = "";
            }
            break;
          }

          case "response.text.delta": {
            if (msg.delta) currentModelText += msg.delta;
            break;
          }

          case "response.text.done": {
            if (currentModelText) {
              config.onTranscription?.(currentModelText, false);
              currentModelText = "";
            }
            break;
          }

          case "conversation.item.input_audio_transcription.completed": {
            if (msg.transcript) {
              config.onTranscription?.(msg.transcript, true);
            }
            break;
          }

          case "input_audio_buffer.speech_started": {
            this.modelSpeaking = false;
            this.audioService.stopPlayback();
            this.latencyTracker.onSpeechStarted();
            break;
          }

          case "input_audio_buffer.speech_stopped": {
            this.latencyTracker.onSpeechStopped();
            break;
          }

          case "response.done": {
            this.modelSpeaking = false;
            if (msg.response?.status === "failed") {
              console.error("[OpenAI] Response failed:", JSON.stringify(msg.response?.status_details));
              // Retry: trigger a new response so the agent doesn't go silent
              if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: "response.create" }));
              }
            }
            this.latencyTracker.onTurnComplete();
            currentModelTranscript = "";
            currentModelText = "";
            if (!micStarted) startMic();
            break;
          }

          case "error": {
            console.error("[OpenAI] Error:", msg.error);
            // Only treat session-level errors as fatal; per-turn errors are recoverable
            const fatalCodes = ["session_expired", "invalid_api_key", "quota_exceeded"];
            if (fatalCodes.includes(msg.error?.code)) {
              config.onStatusChange?.("error", msg.error?.message || "OpenAI error");
            } else {
              console.warn("[OpenAI] Recoverable error, continuing session:", msg.error?.code);
            }
            break;
          }
        }
      };
    } catch (err: any) {
      console.error("Failed to connect to OpenAI Realtime:", err);
      config.onStatusChange?.("error", err.message || "Failed to connect");
      throw err;
    }
  }

  triggerGreeting() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "response.create" }));
    }
  }

  getLatencyTracker(): LatencyTracker {
    return this.latencyTracker;
  }

  async disconnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    this.audioService.stopRecording();
  }
}
