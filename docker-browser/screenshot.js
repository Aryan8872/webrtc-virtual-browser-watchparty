import puppeteer from "puppeteer";
import path from "path";
import { io } from "socket.io-client";
const roomId = "room-100";
const SOCKET_URL = "http://host.docker.internal:3000";
const socket = io(SOCKET_URL);
socket.on("connect", () => {
  console.log(`connected to nestjs signaling server. ID : ${socket.id}`);

  socket.emit("join-room", { roomId });
  startBrowserStream();
});

async function startBrowserStream() {
  console.log(`starting chromium browser inside the container...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const newPage = await browser.newPage();
  await newPage.setViewport({ width: 800, height: 600 });
  console.log("navigating to google.com");
  await newPage.goto("https://google.com");

  const cdpSession = await newPage.target().createCDPSession();
  console.log("starting screencast stream");

  // 2. Start the screencast. Chrome will start capturing and emitting frames.
  await cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxHeight: 600,
    maxWidth: 800,
  });

  // 3. Listen for frames emitted by Chrome
  cdpSession.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
    // 'data' is the Base64-encoded JPEG image string
    socket.emit("page-frame", { roomId, frame: data });

    // We MUST acknowledge the frame, otherwise Chrome stops sending new ones
    cdpSession.send("Page.screencastFrameAck", { sessionId });
  });
  socket.on("canvas-click", async (data) => {
    const { x, y } = data;
    console.log(`[Container] Received canvas-click event inside container. Payload:`, data);
    console.log(`Injecting mouse click inside container at: x=${x}, y=${y}`);
    try {
      // Puppeteer mouse click helper
      await newPage.mouse.click(x, y);
    } catch (err) {
      console.error("Failed to inject mouse click:", err);
    }
  });
  socket.on("canvas-keydown", async (data) => {
    const { key } = data;
    console.log(`[Container] Received keydown event inside container. Key: ${key}`);
    try {
      // Puppeteer keyboard press helper
      await newPage.keyboard.press(key);
    } catch (err) {
      console.error(`Failed to inject keypress: ${key}`, err);
    }
  });
  socket.on("disconnect", async () => {
    console.log("Signaling disconnected. Shutting down browser...");
    await browser.close();
    process.exit(0);
  });
}
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
