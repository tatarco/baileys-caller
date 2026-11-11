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
import { randomBytes, createHmac } from "node:crypto";
import { resolve } from "node:path";
import { appendFileSync } from "node:fs";

import { WasmEngine } from "./wasm-engine.mjs";
import { RelayRtcTransport, type RelayListUpdatePayload } from "./relay-transport.mjs";
import { SignalingBridge } from "./signaling.mjs";
import { AudioFeeder } from "./audio-feeder.mjs";
import { CallState, type VoipSdkConfig } from "./types.mjs";

export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig } from "./types.mjs";
export { CallState } from "./types.mjs";

const SHA256_LEN = 32;

const loadBaileys = async (): Promise<any> => {
  try {
    return await import("@whiskeysockets/baileys");
  } catch {
    throw new Error(
      "Could not import @whiskeysockets/baileys. Install it as a peer dependency.",
    );
  }
};

const toBareJid = (jid: string): string => {
  if (!jid) return jid;
  const at = jid.indexOf("@");
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(":")[0];
  return `${user}@${jid.slice(at + 1)}`;
};

const computeHkdf = (
  key: Uint8Array,
  salt: Uint8Array | null,
  info: Uint8Array,
  length: number,
): Uint8Array => {
  const effectiveSalt = salt && salt.length > 0 ? Buffer.from(salt) : Buffer.alloc(SHA256_LEN, 0);
  const prk = createHmac("sha256", effectiveSalt).update(key).digest();
  const blocks = Math.ceil(length / SHA256_LEN);
  const okm = Buffer.alloc(blocks * SHA256_LEN);
  let prev = Buffer.alloc(0);
  for (let i = 1; i <= blocks; i += 1) {
    prev = createHmac("sha256", prk)
      .update(prev)
      .update(info)
      .update(Buffer.from([i]))
      .digest();
    prev.copy(okm, (i - 1) * SHA256_LEN);
  }
  return new Uint8Array(okm.buffer, okm.byteOffset, length);
};

const computeHmacSha256 = (data: Uint8Array, key: Uint8Array): Uint8Array => {
  const result = createHmac("sha256", Buffer.from(key)).update(data).digest();
  return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
};

const isCallReceiptNode = (node: any): boolean => {
  if (node?.tag !== "receipt") return false;
  const child = Array.isArray(node.content) ? node.content[0] : null;
  return !!(child?.attrs?.["call-id"] || child?.attrs?.call_id);
};

/** A live or recently-ended call. */
export class ActiveCall extends EventEmitter {
  #state: CallState = CallState.Idle;
  #endResolver!: (reason: string) => void;
  readonly #endPromise: Promise<string>;
  #endTimer: NodeJS.Timeout | null = null;
  #ended = false;

  /** @internal mirrors the source path for the audio feeder */
  _audioSource: string = "silence";

  constructor(
    public readonly callId: string,
    private readonly engine: WasmEngine,
    durationMs: number,
  ) {
    super();
    this.#endPromise = new Promise((res) => { this.#endResolver = res; });
    if (durationMs > 0) {
      this.#endTimer = setTimeout(() => this.end(), durationMs);
    }
  }

  get state(): CallState { return this.#state; }

  end = (): void => {
    if (this.#ended) return;
    try { this.engine.endCall(0, true); } catch {}
    this._forceEnd("hangup"); // resolves waitForEnd(); previously it hung forever
  };

  /** @internal set by VoipClient once the WASM starts capture */
  _feeder: AudioFeeder | null = null;
  #pendingPlay: Float32Array[] = [];

  /** @internal */
  _attachFeeder = (feeder: AudioFeeder | null): void => {
    this._feeder = feeder;
    if (feeder) for (const p of this.#pendingPlay.splice(0)) feeder.enqueue(p);
  };

  /**
   * Live mode (`audioSource: "live"`): queue mono PCM to speak into the call.
   * Resampled linearly to the call's capture rate when `sampleRate` differs.
   */
  play = (pcm: Float32Array, sampleRate = 16000): void => {
    const target = this._captureRate;
    const data = sampleRate === target ? pcm : resampleLinear(pcm, sampleRate, target);
    if (this._feeder) this._feeder.enqueue(data); else this.#pendingPlay.push(data);
  };

  /** Drop queued speech immediately (barge-in). */
  stopPlayback = (): void => { this.#pendingPlay = []; this._feeder?.clear(); };

  /** Seconds of speech still queued to play. */
  get playbackQueuedSeconds(): number { return this._feeder?.queuedSeconds ?? 0; }

  /** @internal */
  _captureRate = 16000;

  /** Answer an inbound call (from the client's `incoming` event). */
  accept = (opts: { audioSource?: string } = {}): void => {
    if (opts.audioSource) this._audioSource = opts.audioSource;
    const status = this.engine.acceptCall(true, false);
    if (status !== 0 && status !== undefined) this.emit("error", new Error(`acceptCall failed: ${status}`));
  };

  mute = (muted: boolean): void => {
    try { this.engine.setMute(muted); } catch {}
  };

  waitForEnd = (): Promise<string> => this.#endPromise;

  /** @internal — called by VoipClient on WASM call-state change */
  _updateState = (state: number): void => {
    this.#state = state as CallState;
    if (state === CallState.PreacceptReceived) this.emit("ringing");
    else if (state === CallState.Active) this.emit("connected");
    else if (state === CallState.Idle || state === CallState.Ending) {
      this._forceEnd("ended");
    }
  };

  /** @internal */
  _emitAudio = (pcm: Float32Array): void => { this.emit("audio", pcm); };

  /** @internal */
  _forceEnd = (reason: string): void => {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#endTimer) { clearTimeout(this.#endTimer); this.#endTimer = null; }
    this.emit("ended", reason);
    this.#endResolver(reason);
  };
}

/** Linear resampler; good enough for speech. */
export const resampleLinear = (pcm: Float32Array, from: number, to: number): Float32Array => {
  const out = new Float32Array(Math.floor((pcm.length * to) / from));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * step, i0 = Math.floor(x), f = x - i0;
    out[i] = (pcm[i0] ?? 0) * (1 - f) + (pcm[i0 + 1] ?? pcm[i0] ?? 0) * f;
  }
  return out;
};

/** Top-level client. Connects to WhatsApp and lets you place calls. */
export class VoipClient extends EventEmitter {
  readonly #config: VoipSdkConfig;
  #engine: WasmEngine | null = null;
  get engine(): WasmEngine | null { return this.#engine; }
  #relay: RelayRtcTransport | null = null;
  #signaling: SignalingBridge | null = null;
  #sock: any = null;
  #activeCall: ActiveCall | null = null;
  #baileys: any = null;

  // Capture state populated when WASM negotiates audio params
  #capturePtr = 0;
  #captureChunkBytes = 0;
  #captureSampleRate = 16000;
  #captureChannels = 1;
  #captureFramesPerChunk = 320;
  #feeder: AudioFeeder | null = null;

  constructor(config: VoipSdkConfig) {
    super();
    this.#config = config;
  }

  /** Connect to WhatsApp and bring up the WASM VoIP stack. */
  connect = async (): Promise<void> => {
    this.#baileys = await loadBaileys();
    const { useMultiFileAuthState, default: makeWASocket, DisconnectReason } = this.#baileys;
    const makeSocket: (opts: any) => any =
      makeWASocket ?? this.#baileys.makeWASocket ?? this.#baileys;

    const authDir = resolve(this.#config.authDir);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const silentLogger: any = {
      level: "silent",
      child: () => silentLogger,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    };

    // WA rejects stale built-in versions with 405, so always ask for the current one.
    const { version } = await this.#baileys.fetchLatestWaWebVersion({});
    const createSocket = () => makeSocket({
      version,
      auth: state,
      emitOwnEvents: true,
      logger: silentLogger,
    });

    // Connect with auto-reconnect on the post-QR 515 stream-error path.
    await new Promise<void>((resolveOpen, rejectOpen) => {
      let opened = false;
      let retries = 0;
      const maxRetries = 5;

      const connectSocket = () => {
        this.#sock = createSocket();
        this.#sock.ev.on("creds.update", saveCreds);

        process.removeAllListeners("uncaughtException");
        process.on("uncaughtException", (err: any) => {
          const code = err?.output?.statusCode ?? err?.data?.attrs?.code;
          if ((code === 515 || code === "515") && !opened && retries < maxRetries) {
            retries += 1;
            setTimeout(connectSocket, 1500);
          } else if (!opened) {
            rejectOpen(err);
          }
        });

        this.#sock.ev.on("connection.update", (update: any) => {
          if (update.qr) {
            void import("qrcode-terminal")
              .then((qrt) => (qrt.default ?? qrt).generate(update.qr, { small: true }))
              .catch(() => {
                console.log("Scan this QR code in WhatsApp > Linked Devices:");
                console.log(update.qr);
              });
          }
          if (update.connection === "open") {
            opened = true;
            process.removeAllListeners("uncaughtException");
            resolveOpen();
            return;
          }
          if (update.connection === "close" && !opened) {
            const statusCode = update.lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect =
              statusCode === 515 || statusCode === DisconnectReason?.restartRequired;
            if (shouldReconnect && retries < maxRetries) {
              retries += 1;
              setTimeout(connectSocket, 1000);
            } else {
              rejectOpen(update.lastDisconnect?.error ?? new Error("socket closed before open"));
            }
          }
        });
      };

      connectSocket();
    });

    this.#signaling = new SignalingBridge({ sock: this.#sock });
    await this.#signaling.init();

    this.#relay = new RelayRtcTransport({
      onTransportMessage: (data, ip, port) => this.#engine?.handleOnTransportMessage(data, ip, port),
      onIceRtt: (rttMs, ip, port) => this.#engine?.updateIceRtt(rttMs, ip, port),
    });

    this.#engine = new WasmEngine({
      enableLogs: !!process.env.CALL_WASM_LOG,
      callbacks: {
        onLog: (level, msg) => { if (process.env.CALL_WASM_LOG) appendFileSync(process.env.CALL_WASM_LOG, `${level} ${msg}\n`); },
        onSignalingXmpp: (peerJid, callId, xmlPayload) =>
          this.#signaling!.sendSignaling(peerJid, callId, xmlPayload),
        onCallEvent: (eventType, eventData) => this.#handleCallEvent(eventType, eventData),
        sendDataToRelay: (data, ip, port) => this.#relay!.send(data, ip, port),
        onAudioCaptureInit: (config) => this.#handleAudioCaptureInit(config),
        onAudioCaptureStart: () => this.#handleAudioCaptureStart(),
        onAudioCaptureStop: () => this.#handleAudioCaptureStop(),
        onAudioPlaybackData: (audioData) => this.#activeCall?._emitAudio(audioData),
        cryptoHkdf: computeHkdf,
        hmacSha256: computeHmacSha256,
      },
    });

    await this.#engine.initialize();
    this.#signaling.attachEngine(this.#engine);

    const selfPnJid = this.#sock.authState.creds.me?.id;
    const selfLidJid = this.#sock.authState.creds.me?.lid;
    this.#engine.initVoipStack(selfPnJid, toBareJid(selfPnJid), selfLidJid);
    await this.#engine.waitForVoipStackReady();
    try { this.#engine.updateNetworkMedium(2, 0); } catch {}

    this.#sock.ws.on("CB:call", (node: any) => {
      if (process.env.CALL_DEBUG) console.log("[call] CB:call", node?.content?.[0]?.tag, JSON.stringify(node?.attrs));
      this.#signaling!.processIncomingCall(node, this.#engine!, this.#activeCall?.callId ?? "");
    });
    this.#sock.ws.on("CB:receipt", (node: any) => {
      if (!isCallReceiptNode(node)) return;
      this.#signaling!.processIncomingReceipt(node, this.#engine!, this.#activeCall?.callId ?? "");
    });
  };

  /** Place an outbound voice call. */
  call = async (
    phoneNumber: string,
    opts: { audioSource?: string; durationMs?: number } = {},
  ): Promise<ActiveCall> => {
    if (!this.#engine || !this.#signaling) throw new Error("Not connected. Call connect() first.");
    if (this.#activeCall) throw new Error("A call is already active.");

    const targetNumber = phoneNumber.replace(/\D/g, "");
    const targetPnJid = `${targetNumber}@s.whatsapp.net`;
    const durationMs = opts.durationMs ?? 120_000;
    const audioSource = opts.audioSource ?? "silence";

    const peerLid = await this.#signaling.resolveLid(targetPnJid);
    if (!peerLid) throw new Error(`Could not resolve LID for ${targetPnJid}`);

    for (const jid of [targetPnJid, peerLid]) {
      try { await this.#sock.presenceSubscribe(jid); } catch {}
    }
    await new Promise((r) => setTimeout(r, 750));

    const peerDeviceJids = await this.#signaling.discoverPeerDevices(peerLid);
    const deviceList = peerDeviceJids.length ? peerDeviceJids : [toBareJid(peerLid)];

    await this.#signaling.ensureSessionsForPeers(deviceList);

    await new Promise((r) => setTimeout(r, 500));
    await this.#signaling.issueTcToken(peerLid);
    const tcToken = await this.#signaling.ensureTcToken(peerLid, targetPnJid);

    const callId = ("00" + randomBytes(16).toString("hex").slice(2)).toUpperCase();

    const call = new ActiveCall(callId, this.#engine, durationMs);
    call._audioSource = audioSource;
    this.#trackCall(call);

    this.#engine.startCall({
      peerJid: peerLid,
      peerPn: targetPnJid,
      peerList: deviceList,
      callId,
      isVideo: false,
      isLidCall: true,
      isFromDialer: false,
      extraData: tcToken,
    });

    return call;
  };

  /** Tear down the WhatsApp socket and release resources. */
  disconnect = (): void => {
    this.#activeCall?._forceEnd("disconnect");
    this.#activeCall = null;
    this.#relay?.closeAll();
    this.#engine?.destroy();
    this.#sock?.end?.();
    this.#engine = null;
    this.#relay = null;
    this.#signaling = null;
    this.#sock = null;
  };

  // ─── private ──────────────────────────────────────────────────────────────

  /** One call at a time; free the slot when it ends so the next call (in or out) can start. */
  #trackCall = (call: ActiveCall): void => {
    this.#activeCall = call;
    call.once("ended", () => { if (this.#activeCall === call) this.#activeCall = null; });
  };

  #handleCallEvent = (eventType: number, eventData?: string): void => {
    if (process.env.CALL_DEBUG && eventType !== 16) console.log("[call] event", eventType, String(eventData ?? "").slice(0, 200));
    if (eventType === 16 && eventData) {
      try {
        const parsed = JSON.parse(eventData);
        const info = parsed.call_info ?? parsed.callInfo ?? {};
        const callState = Number(info.call_state ?? info.callState ?? 0);
        if (process.env.CALL_DEBUG) console.log("[call] info", eventData);
        if (!this.#activeCall && callState === CallState.ReceivedCall) {
          const callId = String(info.call_id ?? info.callId ?? "");
          const peerJid = String(info.peer_jid ?? info.peerJid ?? info.creator_jid ?? "");
          const call = new ActiveCall(callId, this.#engine!, 0);
          this.#trackCall(call);
          // Backstop: if a ringing call is never accepted and no end state arrives, free the slot.
          setTimeout(() => { if (call.state === CallState.ReceivedCall) call._forceEnd("missed"); }, 60_000).unref();
          this.emit("incoming", call, { peerJid, info });
        }
        this.#activeCall?.emit("info", info); // raw call_info: participants, group_jid, is_group_call, ...
        this.#activeCall?._updateState(callState);
      } catch {}
    } else if (eventType === 156 && eventData) {
      try {
        const update = JSON.parse(eventData) as RelayListUpdatePayload;
        this.#relay?.updateRelayList(update);
      } catch {}
    } else if (eventType === 2 && this.#activeCall?.state !== CallState.ReceivedCall) {
      // Event 2 also fires right after an inbound offer; only treat it as a hangup once the call is past ringing.
      this.#activeCall?._forceEnd("remote_end");
    }
  };

  #handleAudioCaptureInit = (config: {
    sampleRate: number; channels: number; bitsPerSample: number; framesPerChunk: number;
  }): void => {
    if (!this.#engine) return;
    this.#captureSampleRate = config.sampleRate || 16000;
    this.#captureChannels = config.channels || 1;
    this.#captureFramesPerChunk = config.framesPerChunk || 320;
    const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
    this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
    this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
  };

  #handleAudioCaptureStart = (): void => {
    if (!this.#engine || !this.#capturePtr) return;
    const audioSource = this.#activeCall?._audioSource ?? "silence";
    if (this.#activeCall) this.#activeCall._captureRate = this.#captureSampleRate;
    this.#feeder = new AudioFeeder(
      this.#captureSampleRate,
      this.#captureChannels,
      this.#captureFramesPerChunk,
      (chunk) => {
        if (this.#engine && this.#capturePtr) this.#engine.sendAudioData(chunk, this.#capturePtr);
      },
      audioSource,
    );
    this.#feeder.start();
    this.#activeCall?._attachFeeder(this.#feeder);
  };

  #handleAudioCaptureStop = (): void => {
    this.#activeCall?._attachFeeder(null);
    this.#feeder?.stop();
    this.#feeder = null;
    if (this.#engine && this.#capturePtr) {
      try { this.#engine.free(this.#capturePtr); } catch {}
      this.#capturePtr = 0;
    }
  };
}
