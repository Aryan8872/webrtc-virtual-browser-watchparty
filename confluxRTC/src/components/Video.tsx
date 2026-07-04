import { useEffect, useRef, useState } from "react";
import { socket } from "../lib/api/socket";
import {
  CANVAS_CLICK,
  CANVAS_KEYDOWN,
  ICE_CANDIDATE,
  JOIN_ROOM,
  PAGE_FRAME,
  SDP_ANSWER,
  SDP_OFFER,
  USER_JOINED,
  USER_LEFT,
} from "../types/socket.message";
import type {
  ICE_CANDIDATE_EMIT,
  PAGE_FRAME_EMIT,
  SDP_ANSWER_EMIT,
  SDP_OFFER_EMIT,
  USER_JOINED_EMIT,
} from "../types/socket.emit";

// Resolution must match docker-browser/.env — single source of truth
const BROWSER_WIDTH  = parseInt(import.meta.env.VITE_BROWSER_WIDTH  || "1280");
const BROWSER_HEIGHT = parseInt(import.meta.env.VITE_BROWSER_HEIGHT || "720");

const Video = () => {
  const mediaConstraints = {
    video: {
      width: { max: 720 },
      height: { max: 720 },
    },
  };
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const lastMoveTimeRef   = useRef<number>(0);         // Throttle: mouse moves
  const lastScrollTimeRef = useRef<number>(0);         // Throttle: scroll events
  const remoteStreamRef   = useRef<MediaStream | null>(null); // Accumulate video+audio tracks
  const [isMuted, setIsMuted] = useState(true);        // Audio starts muted (browser policy)

  // Public STUN servers to fetch our public IP and Port (helps bypass NAT)
  const peerConfiguration: RTCConfiguration = {
    iceServers: [
      {
        urls: [
          "stun:stun1.l.google.com:19302",
          "stun:stun2.l.google.com:19302",
        ],
      },
    ],
  };

  const createPeerConnection = () => {
    console.log("[Frontend] Creating RTCPeerConnection...");
    const peerConnection = new RTCPeerConnection(peerConfiguration);
    peerConnectionRef.current = peerConnection;

    // Create a single shared MediaStream that accumulates BOTH video and audio tracks.
    // WHY: ontrack fires once per track (video first, then audio). If we create a new
    // MediaStream on each event, the second track overwrites the first on srcObject.
    // Solution: reuse one MediaStream and call .addTrack() for each incoming track.
    remoteStreamRef.current = new MediaStream();

    peerConnection.ontrack = (event) => {
      console.log(`[Frontend] Track received: kind=${event.track.kind} id=${event.track.id}`);

      // Add the incoming track into our shared stream
      remoteStreamRef.current!.addTrack(event.track);

      // Point the video element at the shared stream (safe to do multiple times)
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
        remoteVideoRef.current.play().catch((err) =>
          console.warn("[Frontend] Autoplay blocked:", err)
        );
      }
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit(ICE_CANDIDATE, { roomId, iceCandidate: event.candidate });
      }
    };

    // Tell the browser SDP to include a video AND audio receive section.
    // Without these the offer has no m=video / m=audio lines → werift crashes.
    peerConnection.addTransceiver("video", { direction: "recvonly" });
    peerConnection.addTransceiver("audio", { direction: "recvonly" });

    return peerConnection;
  };

  const [inRoom, setInRoom] = useState(false);
  const roomId = "room-100";
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia(mediaConstraints)
      .then((stream) => {
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      })
      .catch((error) => {
        console.error("Error accessing media devices.", error);
      });

    socket.on("connect", () => {
      console.log(
        `connected to the signaling socket room socket ID:${socket.id}`,
      );
      socket.emit(JOIN_ROOM, { roomId });
      setInRoom(true);
    });

    // Step A: You are already in the room. A new user joins. You are the CALLER.
    socket.on(USER_JOINED, async (data: USER_JOINED_EMIT) => {
      console.log(`[Frontend] Peer ${data.userId} joined the room. Initiating WebRTC offer...`);
      
      const pc = createPeerConnection();

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Send the offer to the new user via our server
      socket.emit(SDP_OFFER, { roomId, sdp: offer });
    });

    // Step B: You just joined. You receive an SDP Offer. You are the CALLEE.
    socket.on(SDP_OFFER, async (data: SDP_OFFER_EMIT) => {
      console.log("[Frontend] Received SDP Offer from container. Generating answer...");
      
      const pc = createPeerConnection();

      // Set their offer as remote configuration
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      // Create answer
      const answer = await pc.createAnswer();
      // Set our answer as local description
      await pc.setLocalDescription(answer);

      // Send the answer to the other peer via signaling
      socket.emit(SDP_ANSWER, {
        roomId,
        sdp: answer,
      });
    });

    // Step C: You sent an offer. You receive their SDP Answer.
    socket.on(SDP_ANSWER, async (data: SDP_ANSWER_EMIT) => {
      const pc = peerConnectionRef.current;
      if (pc) {
        pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      }
    });

    socket.on(ICE_CANDIDATE, async (data: ICE_CANDIDATE_EMIT) => {
      const pc = peerConnectionRef.current;
      if (pc && data.iceCandidate) {
        await pc.addIceCandidate(data.iceCandidate);
      }
    });

    // Step E: A user leaves the room. Clean up the connection and UI.
    socket.on("user-left", (data: { userId: string }) => {
      console.log(`User left the room: ${data.userId}`);
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }
      remoteStreamRef.current = null;
      setIsMuted(true); // Reset mute state when peer disconnects
    });

    // WebRTC connection is handled dynamically via sdp-offer and ontrack events.

    return () => {
      socket.off("connect");
      socket.off(USER_JOINED);
      socket.off(SDP_OFFER);
      socket.off(SDP_ANSWER);
      socket.off(ICE_CANDIDATE);
      socket.off(USER_LEFT);
      socket.off(PAGE_FRAME);
      socket.disconnect();
    };
  }, []);

  const handleStartConnection = () => {
    socket.connect();
  };

  // Toggle audio mute state.
  // WHY this button pattern: Chrome's autoplay policy BLOCKS audio on page load
  // unless triggered by a real user gesture (a click). We start muted, then let
  // the user unmute with one deliberate click — this satisfies the browser policy.
  const handleToggleMute = () => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.muted = !remoteVideoRef.current.muted;
      setIsMuted(remoteVideoRef.current.muted);
    }
  };

  // ── Shared helper: scale display coords → virtual browser coords ──────────
  const scaleCoords = (event: React.MouseEvent<HTMLVideoElement>) => {
    const rect = remoteVideoRef.current!.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left)  / rect.width)  * BROWSER_WIDTH,
      y: ((event.clientY - rect.top)   / rect.height) * BROWSER_HEIGHT,
    };
  };

  const handleCanvasClick = (event: React.MouseEvent<HTMLVideoElement>) => {
    if (!remoteVideoRef.current) return;
    const { x, y } = scaleCoords(event);
    socket.emit(CANVAS_CLICK, { roomId, x, y });
  };

  const handleCanvasKeyDown = (event: React.KeyboardEvent<HTMLVideoElement>) => {
    // Prevent browser shortcuts from intercepting keys (e.g. Backspace navigating back)
    event.preventDefault();
    socket.emit(CANVAS_KEYDOWN, { roomId, key: event.key });
  };

  const handleCanvasMouseMove = (event: React.MouseEvent<HTMLVideoElement>) => {
    const now = Date.now();
    // Throttle to ~20 events/sec — enough for smooth cursor without flooding socket
    if (now - lastMoveTimeRef.current < 50) return;
    lastMoveTimeRef.current = now;
    if (!remoteVideoRef.current) return;
    const { x, y } = scaleCoords(event);
    socket.emit("canvas-mousemove", { roomId, x, y });
  };

  const handleCanvasWheel = (event: React.WheelEvent<HTMLVideoElement>) => {
    // Prevent the host page from scrolling while the user scrolls inside the virtual browser
    event.preventDefault();
    const now = Date.now();
    // Throttle to ~30 scroll events/sec
    if (now - lastScrollTimeRef.current < 33) return;
    lastScrollTimeRef.current = now;
    socket.emit("canvas-scroll", { roomId, deltaX: event.deltaX, deltaY: event.deltaY });
  };

  return (
    <div>
      <h1>Virtual Browser Watch Party</h1>
      <p>{inRoom ? "🟢 Online" : "🔴 Offline"}</p>

      <div style={{ display: "flex", flexDirection: "row", gap: "12px", alignItems: "flex-start" }}>
        {/* Local webcam (small thumbnail) */}
        <video id="localVideo" ref={localVideoRef} playsInline autoPlay muted width="200" />

        {/* ── Virtual Browser Stream ──────────────────────────────────────── */}
        <div>
          {/* Toolbar above the browser — audio toggle + status */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <h3 style={{ margin: 0 }}>Virtual Browser — {BROWSER_WIDTH}×{BROWSER_HEIGHT}</h3>
            <button
              onClick={handleToggleMute}
              style={{
                padding: "6px 14px",
                borderRadius: "6px",
                border: "none",
                cursor: "pointer",
                fontWeight: "bold",
                background: isMuted ? "#ef4444" : "#22c55e",
                color: "white",
                fontSize: "14px",
              }}
            >
              {isMuted ? "🔇 Unmute Audio" : "🔊 Mute Audio"}
            </button>
          </div>

          <video
            id="remoteVideo"
            ref={remoteVideoRef}
            onClick={handleCanvasClick}
            onKeyDown={handleCanvasKeyDown}
            onMouseMove={handleCanvasMouseMove}
            onWheel={handleCanvasWheel}
            tabIndex={0}
            playsInline
            autoPlay
            muted={isMuted}  // Controlled by state — user clicks button to unmute
            style={{
              display:    "block",
              width:      `${BROWSER_WIDTH}px`,
              height:     `${BROWSER_HEIGHT}px`,
              border:     "2px solid #334155",
              background: "#0f172a",
              outline:    "none",
              cursor:     "none", // Hide host cursor — browser cursor shown via FFmpeg
            }}
          />
        </div>
      </div>

      <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
        <button onClick={handleStartConnection}>Connect socket</button>
        <button id="startBtn" className="bg-green-500 text-white p-4 rounded-lg">Start</button>
        <button id="callBtn"  className="bg-blue-500  text-white p-4 rounded-lg">Call</button>
        <button id="endBtn"   className="bg-red-500   text-white p-4 rounded-lg">End</button>
      </div>
    </div>
  );
};

export default Video;
