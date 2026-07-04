import puppeteer from "puppeteer";
import { io } from "socket.io-client";
import { spawn } from "child_process";
import dgram from "dgram";
import { RTCPeerConnection, MediaStreamTrack } from "werift";

// ============================================
// CONFIG — loaded from .env via Node --env-file
// ============================================
const DISPLAY    = process.env.DISPLAY_NUM  || ":99";
const WIDTH      = parseInt(process.env.BROWSER_WIDTH  || "1280");
const HEIGHT     = parseInt(process.env.BROWSER_HEIGHT || "720");
const RTP_PORT   = parseInt(process.env.RTP_PORT       || "5004");
const AUDIO_PORT = parseInt(process.env.AUDIO_PORT     || "5005");
const SOCKET_URL = process.env.SOCKET_URL   || "http://host.docker.internal:3000";
const ROOM_ID    = process.env.ROOM_ID      || "room-100";

console.log(`[Config] ${WIDTH}x${HEIGHT} | Display: ${DISPLAY} | Room: ${ROOM_ID}`);
console.log(`[Config] Video RTP: ${RTP_PORT} | Audio RTP: ${AUDIO_PORT}`);

// ============================================
// WEBRTC STUN CONFIG
// ============================================
const peerConfiguration = {
  iceServers: [
    { urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] },
  ],
};

// ============================================
// SOCKET
// ============================================
const socket = io(SOCKET_URL);
socket.on("connect", () => {
  console.log(`[Socket] Connected. ID: ${socket.id}`);
  startVirtualBrowser();
});
socket.on("connect_error", (err) => console.error(`[Socket] Error: ${err.message}`));

// ============================================
// HELPERS
// ============================================
function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================
// MAIN BOOT SEQUENCE
// ============================================
async function startVirtualBrowser() {

  // ── 1. Xvfb Virtual Display ──────────────────────────────────────────────
  console.log(`1. Starting Xvfb ${WIDTH}x${HEIGHT} on ${DISPLAY}...`);
  const xvfb = spawn("Xvfb", [
    DISPLAY, "-screen", "0", `${WIDTH}x${HEIGHT}x24`,
    "-ac", "+extension", "GLX", "+render", "-noreset",
  ]);
  xvfb.stderr.on("data", (d) => process.stdout.write(`[Xvfb] ${d}`));
  await waitMs(1200);

  // ── 2. PulseAudio Virtual Audio Sink ─────────────────────────────────────
  // Why: Chromium outputs audio to the system sound server.
  // We create a virtual PulseAudio "null sink" — a fake speaker.
  // FFmpeg then captures the monitor (loopback) of that sink.
  console.log("2. Starting PulseAudio virtual audio sink...");

  // Write a daemon.conf that forces 48000Hz system-wide BEFORE starting PA.
  // This is the correct way to set sample rate — not via CLI flags.
  // PulseAudio reads ~/.config/pulse/daemon.conf on startup.
  const paConfigDir  = "/root/.config/pulse";
  const paConfigFile = `${paConfigDir}/daemon.conf`;
  const paConfig = [
    "default-sample-rate = 48000",
    "alternate-sample-rate = 48000",
    "default-sample-channels = 2",
    "default-sample-format = float32le",
    "resample-method = speex-float-5", // High-quality resampler as fallback
    "exit-idle-time = -1",
  ].join("\n");

  // Ensure config directory exists and write the config
  const { execSync } = await import("child_process");
  try {
    execSync(`mkdir -p ${paConfigDir}`);
    execSync(`echo '${paConfig}' > ${paConfigFile}`);
    console.log("2. PulseAudio daemon.conf written (48000Hz forced).");
  } catch (e) {
    console.warn("[PA] Could not write daemon.conf:", e.message);
  }

  const pulseaudio = spawn("pulseaudio", [
    "--daemonize=no",
    "--log-target=stderr",
    "--exit-idle-time=-1",
  ]);
  pulseaudio.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) process.stdout.write(`[PA] ${msg}\n`);
  });
  await waitMs(1500);

  // Create null sink at 48000Hz stereo — matches Opus native rate exactly.
  // WHY explicit rate=48000: the default varies per distro (often 44100).
  // A mismatch forces a resampler in the chain → resampling artifacts.
  spawn("pactl", ["load-module", "module-null-sink",
    "sink_name=virtual_sink",
    "rate=48000",
    "channels=2",
    "channel_map=front-left,front-right",
    "sink_properties=device.description=VirtualSink",
  ]);
  await waitMs(600);

  // Set as default sink so Chromium routes audio here automatically
  spawn("pactl", ["set-default-sink", "virtual_sink"]);
  console.log("2. PulseAudio virtual_sink (48000Hz stereo) created and set as default.");

  // ── 3. Chromium — Full Browser UI with Anti-Detection ────────────────────
  process.env.DISPLAY = DISPLAY;

  // CAPTCHA FIX: These 3 mechanisms together defeat Google's bot detection:
  //   a) --disable-blink-features=AutomationControlled → removes navigator.webdriver
  //   b) --user-data-dir → persistent profile (cookies/session survive restarts)
  //   c) page.evaluateOnNewDocument → belt-and-suspenders JS-level cleanup
  console.log("3. Launching Chromium (anti-bot flags active)...");
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      `--window-size=${WIDTH},${HEIGHT}`,
      "--window-position=0,0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-infobars",
      "--disable-session-crashed-bubble",
      // KEY anti-detection flag: hides navigator.webdriver from websites
      "--disable-blink-features=AutomationControlled",
      // Persistent profile: Google recognises returning users and trusts them more
      "--user-data-dir=/tmp/chrome-profile",
    ],
  });

  const pages = await browser.pages();
  const page  = pages[0];

  // Remove remaining webdriver traces at the JS engine level (belt-and-suspenders)
  await page.evaluateOnNewDocument(() => {
    // Remove the navigator.webdriver property that Puppeteer injects
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // Make Chrome plugins look like a real browser (not zero plugins)
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
    // Real Chrome has specific language settings
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
  });

  // Use a real-looking user agent (not "HeadlessChrome")
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  await page.goto("https://www.google.com", { waitUntil: "domcontentloaded" });
  console.log("3. Browser is at google.com with anti-detection active.");

  // ── 4. WebRTC Tracks ─────────────────────────────────────────────────────
  console.log("4. Initializing WebRTC video (VP8) + audio (Opus) tracks...");
  const videoTrack = new MediaStreamTrack({ kind: "video", codec: "VP8" });
  const audioTrack = new MediaStreamTrack({ kind: "audio", codec: "opus" });

  const pc = new RTCPeerConnection(peerConfiguration);
  pc.addTrack(videoTrack);
  pc.addTrack(audioTrack);

  pc.onIceCandidate.subscribe((candidate) => {
    if (candidate) {
      socket.emit("ice-candidate", { roomId: ROOM_ID, iceCandidate: candidate });
    }
  });

  // ── 5. UDP Servers — receive RTP packets from FFmpeg ─────────────────────
  console.log(`5. Binding UDP servers on ports ${RTP_PORT} (video) and ${AUDIO_PORT} (audio)...`);

  const videoUdp = dgram.createSocket("udp4");
  videoUdp.on("message", (msg) => videoTrack.writeRtp(msg));
  videoUdp.bind(RTP_PORT, "127.0.0.1");

  const audioUdp = dgram.createSocket("udp4");
  audioUdp.on("message", (msg) => audioTrack.writeRtp(msg));
  audioUdp.bind(AUDIO_PORT, "127.0.0.1");

  // ── 6. FFmpeg Video — x11grab → VP8 → UDP:5004 ──────────────────────────
  console.log("6. Starting FFmpeg video capture...");
  const ffmpegVideo = spawn("ffmpeg", [
    "-f",          "x11grab",
    "-draw_mouse", "1",                  // Render X11 cursor on the stream
    "-video_size", `${WIDTH}x${HEIGHT}`,
    "-framerate",  "30",
    "-i",          `${DISPLAY}.0`,
    "-c:v",        "libvpx",
    "-cpu-used",   "5",
    "-deadline",   "realtime",
    "-b:v",        "1500k",
    "-f",          "rtp",
    `rtp://127.0.0.1:${RTP_PORT}`,
  ]);
  ffmpegVideo.stderr.on("data", (d) => {
    const msg = d.toString();
    if (msg.includes("frame=")) {
      process.stdout.write(`[FFmpeg-V] ${msg.trim().split("\n").pop()}\n`);
    }
  });

  // ── 7. FFmpeg Audio — PulseAudio monitor → Opus → UDP:5005 ───────────────
  //
  // Audio distortion root causes and their fixes:
  //
  // 1. VBR + RTP = bad: Variable bitrate changes Opus packet sizes every frame.
  //    The browser's jitter buffer expects consistent-sized packets.
  //    Unpredictable sizes → buffer stalls → crackling/distortion.
  //    FIX: -vbr off (CBR — constant bitrate, constant packet sizes)
  //
  // 2. Resampling: PulseAudio was at 44100Hz, FFmpeg outputs 48000Hz.
  //    Any resampling in the chain adds phase errors → distortion.
  //    FIX: PulseAudio sink created at 48000Hz (above) — zero resampling.
  //
  // 3. High compression_level causes CPU spikes in a resource-constrained
  //    container, causing timing jitter in the audio pipeline.
  //    FIX: removed — libopus default compression is fine.
  //
  // 4. -fragment_size 4096: ensures FFmpeg reads from PulseAudio in
  //    uniform chunk sizes — prevents burst reads that cause timing gaps.
  console.log("7. Starting FFmpeg audio capture (CBR Opus, 48kHz)...");
  const ffmpegAudio = spawn("ffmpeg", [
    "-f",              "pulse",
    "-fragment_size",  "4096",      // Uniform read chunks from PulseAudio
    "-i",              "virtual_sink.monitor",
    "-c:a",            "libopus",
    "-application",    "audio",     // Music/general mode — NOT voice processing
    "-b:a",            "128k",      // 128k CBR — enough for stereo audio
    "-vbr",            "off",       // KEY FIX: CBR — stable packet sizes for RTP
    "-frame_duration", "20",        // Standard 20ms Opus frames
    "-ar",             "48000",     // Matches PulseAudio sink rate — no resampling
    "-ac",             "2",         // Stereo
    "-f",              "rtp",
    `rtp://127.0.0.1:${AUDIO_PORT}`,
  ]);
  ffmpegAudio.stderr.on("data", (d) => {
    const msg = d.toString();
    if (msg.includes("size=") || msg.includes("error") || msg.includes("Error")) {
      process.stdout.write(`[FFmpeg-A] ${msg.trim().split("\n").pop()}\n`);
    }
  });

  console.log("✅ Virtual browser is fully running with video + audio!");

  // ── 8. WebRTC Signaling ───────────────────────────────────────────────────
  socket.on("sdp-offer", async (data) => {
    console.log("[SDP] Received Offer — generating Answer...");
    await pc.setRemoteDescription(data.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("sdp-answer", { roomId: ROOM_ID, sdp: answer });
    console.log("[SDP] Answer sent.");
  });

  socket.on("ice-candidate", async (data) => {
    if (data.iceCandidate) {
      await pc.addIceCandidate(data.iceCandidate);
    }
  });

  // ── 9. Input Injection — xdotool at X11 level ────────────────────────────
  socket.on("canvas-click", (data) => {
    const x = Math.round(data.x);
    const y = Math.round(data.y);
    console.log(`[Input] Click x=${x} y=${y}`);
    spawn("xdotool", ["mousemove", "--sync", String(x), String(y)]);
    spawn("xdotool", ["click", "1"]);
  });

  socket.on("canvas-mousemove", (data) => {
    spawn("xdotool", ["mousemove", String(Math.round(data.x)), String(Math.round(data.y))]);
  });

  socket.on("canvas-scroll", (data) => {
    const { deltaX, deltaY } = data;
    if (deltaY !== 0) {
      const btn   = deltaY > 0 ? "5" : "4"; // 5=down, 4=up
      const steps = Math.max(1, Math.round(Math.abs(deltaY) / 120));
      for (let i = 0; i < steps; i++) spawn("xdotool", ["click", btn]);
    }
    if (deltaX !== 0) {
      const btn   = deltaX > 0 ? "7" : "6"; // 7=right, 6=left
      const steps = Math.max(1, Math.round(Math.abs(deltaX) / 120));
      for (let i = 0; i < steps; i++) spawn("xdotool", ["click", btn]);
    }
  });

  socket.on("canvas-keydown", (data) => {
    const keyMap = {
      Enter: "Return", Backspace: "BackSpace", Tab: "Tab", Escape: "Escape",
      Delete: "Delete", Home: "Home", End: "End",
      PageUp: "Prior", PageDown: "Next",
      ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      " ": "space", F5: "F5", F12: "F12",
    };
    const xdoKey = keyMap[data.key] || data.key;
    console.log(`[Input] Key "${data.key}" → "${xdoKey}"`);
    spawn("xdotool", ["key", xdoKey]);
  });

  // ── 10. JOIN ROOM — only after all listeners are registered ──────────────
  console.log(`10. Joining signaling room "${ROOM_ID}"...`);
  socket.emit("join-room", { roomId: ROOM_ID });

  // ── 11. Graceful Shutdown ─────────────────────────────────────────────────
  socket.on("disconnect", async () => {
    console.log("[Socket] Disconnected. Shutting down...");
    ffmpegVideo.kill("SIGTERM");
    ffmpegAudio.kill("SIGTERM");
    await browser.close();
    xvfb.kill("SIGTERM");
    pulseaudio.kill("SIGTERM");
    videoUdp.close();
    audioUdp.close();
    pc.close();
    process.exit(0);
  });
}
