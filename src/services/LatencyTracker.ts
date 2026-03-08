export interface TurnMetrics {
  turnNumber: number;
  userSpeakingMs: number | null;
  modelProcessingMs: number | null;
  modelSpeakingMs: number | null;
  turnaroundMs: number;
  wasInterrupted: boolean;
}

export interface SessionSummary {
  turns: TurnMetrics[];
  totalTurns: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  medianLatencyMs: number;
  avgModelProcessingMs: number | null;
  trend: "increasing" | "decreasing" | "stable" | "not_enough_data";
}

type Phase = "IDLE" | "WAITING_FOR_SPEECH" | "USER_SPEAKING" | "WAITING_FOR_MODEL" | "MODEL_SPEAKING";

export class LatencyTracker {
  private turns: TurnMetrics[] = [];
  private turnCounter = 0;
  private phase: Phase = "IDLE";

  private prevTurnCompleteTime: number | null = null;
  private userSpeechStartTime: number | null = null;
  private userSilenceTime: number | null = null;
  private firstModelAudioTime: number | null = null;
  private silenceStartTime: number | null = null;

  onTurnComplete(): void {
    const now = performance.now();

    if (this.phase === "MODEL_SPEAKING" && this.prevTurnCompleteTime !== null) {
      this.turnCounter++;
      const turnaround = Math.round(now - this.prevTurnCompleteTime);

      let userSpeakingMs: number | null = null;
      let modelProcessingMs: number | null = null;
      let modelSpeakingMs: number | null = null;

      if (this.userSpeechStartTime !== null && this.userSilenceTime !== null) {
        userSpeakingMs = Math.round(this.userSilenceTime - this.userSpeechStartTime);
      }
      if (this.userSilenceTime !== null && this.firstModelAudioTime !== null) {
        modelProcessingMs = Math.round(this.firstModelAudioTime - this.userSilenceTime);
      }
      if (this.firstModelAudioTime !== null) {
        modelSpeakingMs = Math.round(now - this.firstModelAudioTime);
      }

      this.turns.push({
        turnNumber: this.turnCounter,
        userSpeakingMs,
        modelProcessingMs,
        modelSpeakingMs,
        turnaroundMs: turnaround,
        wasInterrupted: false,
      });
    }

    this.prevTurnCompleteTime = now;
    this.phase = "WAITING_FOR_SPEECH";
    this.userSpeechStartTime = null;
    this.userSilenceTime = null;
    this.firstModelAudioTime = null;
    this.silenceStartTime = null;
  }

  onFirstModelAudio(): void {
    if (
      this.phase !== "WAITING_FOR_MODEL" &&
      this.phase !== "USER_SPEAKING" &&
      this.phase !== "WAITING_FOR_SPEECH"
    )
      return;
    if (this.prevTurnCompleteTime === null) return;

    const now = performance.now();
    this.firstModelAudioTime = now;

    if (this.userSilenceTime === null && this.userSpeechStartTime !== null) {
      this.userSilenceTime = now;
    }

    this.phase = "MODEL_SPEAKING";
  }

  onSpeechStarted(): void {
    if (this.phase !== "WAITING_FOR_SPEECH") return;
    this.userSpeechStartTime = performance.now();
    this.phase = "USER_SPEAKING";
    this.silenceStartTime = null;
  }

  onSpeechStopped(): void {
    if (this.phase !== "USER_SPEAKING") return;
    this.userSilenceTime = performance.now();
    this.phase = "WAITING_FOR_MODEL";
  }

  reset(): void {
    this.turns = [];
    this.turnCounter = 0;
    this.phase = "IDLE";
    this.prevTurnCompleteTime = null;
    this.userSpeechStartTime = null;
    this.userSilenceTime = null;
    this.firstModelAudioTime = null;
    this.silenceStartTime = null;
  }
}
