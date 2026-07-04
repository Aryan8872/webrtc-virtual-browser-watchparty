import puppeteer from "puppeteer";
import path from "path";
import { io } from "socket.io-client";
import { spawn } from "child_process";
const roomId = "room-100";
const SOCKET_URL = "http://host.docker.internal:3000";
const socket = io(SOCKET_URL);
const DISPLAY = ":99";

// STUN servers configuration for the container's WebRTC connection
const peerConfiguration = {
  iceServers: [
    {
      urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"],
    },
  ],
};

socket.on("connect", () => {
  console.log(`connected to nestjs signaling server. ID : ${socket.id}`);

  socket.emit("join-room", { roomId });
  // startBrowserStream();
  startXvfbBrowserAndWebRTC();
});

async function startXvfbBrowserAndWebRTC() {
  console.log("1. Starting Xvfb Virtual Display Server on display :99...");

  // Run command: Xvfb :99 -screen 0 800x600x24 -ac +extension GLX +render -noreset
  const xvfb = spawn("Xvfb", [
    DISPLAY,
    "-screen",
    "0",
    "800x600x24", // Screen index 0, resolution 800x600, 24-bit color depth
    "-ac", // Disable access control (allows anyone to connect to display)
    "+extension",
    "GLX",
    "+render",
    "-noreset",
  ]);
  // Handle virtual display crash or error logs
  xvfb.stderr.on("data", (data) => {
    console.log(`[Xvfb Log]: ${data}`);
  });

  // Wait 1 second to ensure Xvfb is running in memory before opening the browser
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("2. Launching Chromium inside Virtual Display...");

  // We set the DISPLAY environment variable so Chromium opens inside our virtual screen
  process.env.DISPLAY = DISPLAY;

  const browser = await puppeteer.launch({
    headless: false, // CRUCIAL: Must be headful so it draws a window in Xvfb
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--window-size=800,600", // Match display size
      "--start-maximized", // Open maximized in the display
      "--disable-gpu", // Optional: disables GPU sandbox for virtual environments
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  await page.goto("https://google.com");

  // 3. Initialize WebRTC Media Track inside the container
  console.log("3. Initializing WebRTC video track...");
  // Create a raw VP8 video track
  const videoTrack = new MediaStreamTrack({ kind: "video", codec: "VP8" });

  // Create the WebRTC Peer Connection
  const pc = new RTCPeerConnection(peerConfiguration);
  pc.addTrack(videoTrack); // Register our video track with the connection

  // Listen for local ICE candidates and emit them to the signaling server
  pc.onIceCandidate.subscribe((candidate) => {
    if (candidate) {
      socket.emit("ice-candidate", { roomId, candidate });
    }
  });

  // 4. Set up the local UDP server to capture FFmpeg stream packets
  console.log("4. Binding UDP socket on port 5004 for FFmpeg capture...");
  const udpServer = dgram.createSocket("udp4");

  udpServer.on("message", (msg) => {
    // 'msg' is a Buffer containing a single RTP video packet sent by FFmpeg.
    // We write this raw packet directly into our WebRTC video track!
    videoTrack.writeRtp(msg);
  });

  udpServer.bind(5004, "127.0.0.1");

  // 5. Start FFmpeg screen capture (streaming to local UDP port 5004)
  console.log("5. Spawning FFmpeg...");
  const ffmpeg = spawn("ffmpeg", [
    "-f",
    "x11grab",
    "-video_size",
    "800x600",
    "-framerate",
    "30",
    "-i",
    `${DISPLAY}.0`,
    "-c:v",
    "libvpx", // VP8 video encoder
    "-cpu-used",
    "5",
    "-deadline",
    "realtime",
    "-b:v",
    "800k",
    "-f",
    "rtp",
    "rtp://127.0.0.1:5004", // Stream to our UDP server
  ]);

  // Log FFmpeg statistics
  ffmpeg.stderr.on("data", (data) => {
    // FFmpeg naturally prints stats to stderr; we can inspect them for frame rates
    const message = data.toString();
    if (message.includes("frame=")) {
      // Just parse and print frame stats so our terminal isn't overwhelmed
      console.log(`[FFmpeg Stats]: ${message.trim().split("\n").pop()}`);
    }
  });
  console.log(
    "Virtual Display, Browser, and FFmpeg screen capture are all running!",
  );

  // ==========================================
  // WEBRTC SIGNALING HANDLERS (Inside Container)
  // ==========================================

  // Receive offer from React client (React client creates the offer first)
  socket.on("sdp-offer", async (data) => {
    console.log("[Container] Received SDP Offer from client");
    await pc.setRemoteDescription(data.sdp);

    // Create an answer and set local description
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Emit answer back to the room
    socket.emit("sdp-answer", { roomId, sdp: answer });
  });
  socket.on("ice-candidate", async (data) => {
    if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  });

  // ==========================================
  // MOUSE & KEYBOARD INJECTION HANDLERS
  // ==========================================
  socket.on("canvas-click", async (data) => {
    const { x, y } = data;
    try {
      await page.mouse.click(x, y);
    } catch (err) {
      console.error("Failed to inject mouse click:", err);
    }
  });
  socket.on("canvas-keydown", async (data) => {
    const { key } = data;
    try {
      await page.keyboard.press(key);
    } catch (err) {
      console.error(`Failed to inject keypress: ${key}`, err);
    }
  });

  socket.on("disconnect", async () => {
    await browser.close();
    ffmpeg.kill(); // Terminate FFmpeg first
    xvfb.kill();
    console.log("shutting down virtual display and browser");
    process.exit(0);
  });
}

// async function startBrowserStream() {
//   console.log(`starting chromium browser inside the container...`);

//   const browser = await puppeteer.launch({
//     headless: "new",
//     args: ["--no-sandbox", "--disable-setuid-sandbox"],
//   });
//   const newPage = await browser.newPage();
//   await newPage.setViewport({ width: 800, height: 600 });
//   console.log("navigating to google.com");
//   await newPage.goto("https://google.com");

//   const cdpSession = await newPage.target().createCDPSession();
//   console.log("starting screencast stream");

//   // 2. Start the screencast. Chrome will start capturing and emitting frames.
//   await cdpSession.send("Page.startScreencast", {
//     format: "jpeg",
//     quality: 60,
//     maxHeight: 600,
//     maxWidth: 800,
//   });

//   // 3. Listen for frames emitted by Chrome
//   cdpSession.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
//     // 'data' is the Base64-encoded JPEG image string
//     socket.emit("page-frame", { roomId, frame: data });

//     // We MUST acknowledge the frame, otherwise Chrome stops sending new ones
//     cdpSession.send("Page.screencastFrameAck", { sessionId });
//   });
//   socket.on("canvas-click", async (data) => {
//     const { x, y } = data;
//     console.log(`[Container] Received canvas-click event inside container. Payload:`, data);
//     console.log(`Injecting mouse click inside container at: x=${x}, y=${y}`);
//     try {
//       // Puppeteer mouse click helper
//       await newPage.mouse.click(x, y);
//     } catch (err) {
//       console.error("Failed to inject mouse click:", err);
//     }
//   });
//   socket.on("canvas-keydown", async (data) => {
//     const { key } = data;
//     console.log(`[Container] Received keydown event inside container. Key: ${key}`);
//     try {
//       // Puppeteer keyboard press helper
//       await newPage.keyboard.press(key);
//     } catch (err) {
//       console.error(`Failed to inject keypress: ${key}`, err);
//     }
//   });
//   socket.on("disconnect", async () => {
//     console.log("Signaling disconnected. Shutting down browser...");
//     await browser.close();
//     process.exit(0);
//   });
// }
// async function run() {
//   console.log("lauching headless chromium browser");
//   const browser = await puppeteer.launch({
//     args: ["--no-sandbox", "--disable-setuid-sandbox"],
//   });
//   const newPage = await browser.newPage();
//   console.log("created new page and navigating to google.com");
//   await newPage.goto("https://google.com");

//   // Simplified output path (saves directly to the current volume folder)
//   const outputPath = "google.png";
//   console.log(`Taking screenshot and saving to: ${outputPath}`);
//   await newPage.screenshot({ path: outputPath });

//   await browser.close();
//   console.log("Browser closed successfully!");
// }

// run().catch((err) => {
//   console.error("Error running screenshot script:", err);
//   process.exit(1);
// });
