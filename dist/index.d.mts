/**
 * baileys-caller — WhatsApp voice calling for Node.js.
 *
 * Wraps WhatsApp Web's official VoIP WASM stack and routes signaling through
 * Baileys. Public surface:
 *
 *   const client = new VoipClient({ authDir })
 *   await client.connect()
 *   const call = await client.call("12345678901", { audioSource: "./hi.mp3" })
 *
 * @author ShellTear
 */
import { EventEmitter } from "node:events";
import { WasmEngine } from "./wasm-engine.mjs";
import { AudioFeeder } from "./audio-feeder.mjs";
import { CallState, type VoipSdkConfig } from "./types.mjs";
export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig } from "./types.mjs";
export { CallState } from "./types.mjs";
/** A live or recently-ended call. */
export declare class ActiveCall extends EventEmitter {
    #private;
    readonly callId: string;
    private readonly engine;
    /** @internal mirrors the source path for the audio feeder */
    _audioSource: string;
    constructor(callId: string, engine: WasmEngine, durationMs: number);
    get state(): CallState;
    end: () => void;
    /** @internal set by VoipClient once the WASM starts capture */
    _feeder: AudioFeeder | null;
    /** @internal */
    _attachFeeder: (feeder: AudioFeeder | null) => void;
    /**
     * Live mode (`audioSource: "live"`): queue mono PCM to speak into the call.
     * Resampled linearly to the call's capture rate when `sampleRate` differs.
     */
    play: (pcm: Float32Array, sampleRate?: number) => void;
    /** Drop queued speech immediately (barge-in). */
    stopPlayback: () => void;
    /** Seconds of speech still queued to play. */
    get playbackQueuedSeconds(): number;
    /** @internal */
    _captureRate: number;
    /** Answer an inbound call (from the client's `incoming` event). */
    accept: (opts?: {
        audioSource?: string;
    }) => void;
    mute: (muted: boolean) => void;
    waitForEnd: () => Promise<string>;
    /** @internal — called by VoipClient on WASM call-state change */
    _updateState: (state: number) => void;
    /** @internal */
    _emitAudio: (pcm: Float32Array) => void;
    /** @internal */
    _forceEnd: (reason: string) => void;
}
/** Linear resampler; good enough for speech. */
export declare const resampleLinear: (pcm: Float32Array, from: number, to: number) => Float32Array;
/** Top-level client. Connects to WhatsApp and lets you place calls. */
export declare class VoipClient extends EventEmitter {
    #private;
    get engine(): WasmEngine | null;
    constructor(config: VoipSdkConfig);
    /** Connect to WhatsApp and bring up the WASM VoIP stack. */
    connect: () => Promise<void>;
    /** Place an outbound voice call. */
    call: (phoneNumber: string, opts?: {
        audioSource?: string;
        durationMs?: number;
    }) => Promise<ActiveCall>;
    /** Tear down the WhatsApp socket and release resources. */
    disconnect: () => void;
}
