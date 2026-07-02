import puppeteer from "puppeteer";
import path from "path";
import { io } from "socket.io-client";

const roomId = "room-100";
const SOCKET_URL = "http://host.docker.internal:3000";
const socket = io(SOCKET_URL);
socket.on("connect", () => {
  console.log(`connected to nestjs signaling server. ID : ${socket.id}`);
  startBrowserStream();
});

async function startBrowserStream() {
  console.log(`starting chromium browser inside the container...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const newPage = await browser.newPage();
  await newPage.setViewport({ width: 800, height: 800 });
  console.log("navigating to google.com");
  newPage.goto("https://google.com");

  const cdpSession = await newPage.target().createCDPSession();
  console.log("starting screencast stream");

  // 2. Start the screencast. Chrome will start capturing and emitting frames.
  await cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxHeight: 800,
    maxWidth: 800,
  });

  // 3. Listen for frames emitted by Chrome
  cdpSession.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
    
    // 'data' is the Base64-encoded JPEG image string
    socket.emit("page-frame", { roomId, frame: data });

    // We MUST acknowledge the frame, otherwise Chrome stops sending new ones
    cdpSession.send("Page.screencastFrameAck", { sessionId });
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
