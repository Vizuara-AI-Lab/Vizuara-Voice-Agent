/**
 * Audio capture & playback for OpenAI Realtime API (24kHz PCM16).
 */
export class AudioService {
  private playbackContext: AudioContext | null = null;
  private recordingContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private nextStartTime: number = 0;

  private activeSources: Set<AudioBufferSourceNode> = new Set();
  private readonly BUFFER_TIME = 0.05;
  private readonly recordingSampleRate: number;

  constructor(recordingSampleRate: number = 24000) {
    this.recordingSampleRate = recordingSampleRate;
  }

  async initialize() {
    if (!this.playbackContext) {
      this.playbackContext = new AudioContext({ sampleRate: 24000 });
    }
    if (!this.recordingContext) {
      this.recordingContext = new AudioContext({ sampleRate: this.recordingSampleRate });
    }

    if (this.playbackContext.state === "suspended") {
      await this.playbackContext.resume();
    }
    if (this.recordingContext.state === "suspended") {
      await this.recordingContext.resume();
    }
  }

  async startRecording(
    onAudioData: (base64Data: string) => void,
    onVolumeChange?: (volume: number) => void
  ) {
    await this.initialize();
    if (!this.recordingContext) return;

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.source = this.recordingContext.createMediaStreamSource(this.stream);

    this.processor = this.recordingContext.createScriptProcessor(2048, 1, 1);

    this.source.connect(this.processor);
    this.processor.connect(this.recordingContext.destination);

    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);

      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += inputData[i] * inputData[i];
      }
      const rms = Math.sqrt(sum / inputData.length);
      onVolumeChange?.(rms);

      const pcmData = this.floatTo16BitPCM(inputData);
      const base64Data = this.arrayBufferToBase64(pcmData);
      onAudioData(base64Data);
    };
  }

  stopPlayback() {
    this.activeSources.forEach((source) => {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {}
    });
    this.activeSources.clear();
    this.nextStartTime = 0;
  }

  stopRecording() {
    this.stopPlayback();
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.recordingContext) {
      this.recordingContext.close();
      this.recordingContext = null;
    }
    if (this.playbackContext) {
      this.playbackContext.close();
      this.playbackContext = null;
    }
  }

  playAudioChunk(base64Data: string) {
    if (!this.playbackContext) return;

    const arrayBuffer = this.base64ToArrayBuffer(base64Data);
    const float32Data = this.pcm16ToFloat32(arrayBuffer);

    const audioBuffer = this.playbackContext.createBuffer(1, float32Data.length, 24000);
    audioBuffer.getChannelData(0).set(float32Data);

    const source = this.playbackContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.playbackContext.destination);

    const currentTime = this.playbackContext.currentTime;

    if (this.nextStartTime < currentTime + this.BUFFER_TIME) {
      this.nextStartTime = currentTime + this.BUFFER_TIME;
    }

    source.onended = () => {
      this.activeSources.delete(source);
    };

    this.activeSources.add(source);
    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
  }

  private floatTo16BitPCM(input: Float32Array): ArrayBuffer {
    const buffer = new ArrayBuffer(input.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  private pcm16ToFloat32(buffer: ArrayBuffer): Float32Array {
    const view = new DataView(buffer);
    const length = buffer.byteLength / 2;
    const result = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      result[i] = view.getInt16(i * 2, true) / 0x8000;
    }
    return result;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
