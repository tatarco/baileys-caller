export declare class AudioFeeder {
    #private;
    private readonly sampleRate;
    private readonly channels;
    private readonly framesPerChunk;
    private readonly onChunk;
    private readonly source;
    droppedChunks: number;
    underflowChunks: number;
    bytesProduced: number;
    chunksEmitted: number;
    constructor(sampleRate: number, channels: number, framesPerChunk: number, onChunk: (chunk: Float32Array) => void, source?: string);
    start: () => void;
    /** Live mode: queue mono PCM at the feeder's sample rate. */
    enqueue: (pcm: Float32Array) => void;
    /** Drop everything queued (e.g. the caller started talking). */
    clear: () => void;
    /** Seconds of audio still queued. */
    get queuedSeconds(): number;
    stop: () => void;
}
