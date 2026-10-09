
import { useEffect, useRef, useState } from "react";
import "./App.css";

function App() {
  const [isListening, setIsListening] = useState(false);
  const [activePage, setActivePage] = useState("Overview");
  const [dashboardData, setDashboardData] = useState(null);
  const [apiError, setApiError] = useState("");
  
const [activeSession, setActiveSession] = useState(null);
const [sessionMessage, setSessionMessage] = useState("");


const [liveStatus, setLiveStatus] = useState("Not connected");
const [liveTranscript, setLiveTranscript] = useState("");

const audioSocketRef = useRef(null);
const inputAudioContextRef = useRef(null);
const outputAudioContextRef = useRef(null);
const mediaStreamRef = useRef(null);
const processorRef = useRef(null);
const sourceNodeRef = useRef(null);
const nextPlayTimeRef = useRef(0);
const activeSourcesRef = useRef([]);


const startGeminiAudio = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
});

  mediaStreamRef.current = stream;
  const track = stream.getAudioTracks()[0];
console.log("Mic:", track.label, track.getSettings(), "muted:", track.muted, track.readyState);

  const inputContext = new AudioContext();
  const outputContext = new AudioContext({ sampleRate: 24000 });

  inputAudioContextRef.current = inputContext;
  outputAudioContextRef.current = outputContext;

  await inputContext.resume();
  await outputContext.resume();

  const socket = new WebSocket("ws://localhost:5000/live");
  audioSocketRef.current = socket;

  socket.onopen = () => {
    const source = inputContext.createMediaStreamSource(stream);
    const processor = inputContext.createScriptProcessor(4096, 1, 1);

    sourceNodeRef.current = source;
    processorRef.current = processor;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);
      output.fill(0);

      if (socket.readyState !== WebSocket.OPEN) return;
      // Don't send mic audio while Gemini's reply is still playing
if (outputContext.currentTime < nextPlayTimeRef.current + 0.4) return;

      // Convert microphone samples to 16-bit PCM at 16 kHz.
      const ratio = inputContext.sampleRate / 16000;
      const outputLength = Math.floor(input.length / ratio);
      const pcm = new Int16Array(outputLength);

      for (let i = 0; i < outputLength; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(
          Math.floor((i + 1) * ratio),
          input.length
        );

        let sum = 0;
        for (let j = start; j < end; j++) sum += input[j];

        const sample = end > start ? sum / (end - start) : 0;
        const clamped = Math.max(-1, Math.min(1, sample));

        pcm[i] = clamped < 0
          ? clamped * 32768
          : clamped * 32767;
      }

      const bytes = new Uint8Array(pcm.buffer);
      let binary = "";

      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }

      socket.send(JSON.stringify({
        type: "audio",
        data: btoa(binary),
      }));
    };

    source.connect(processor);
    processor.connect(inputContext.destination);
  };

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "connected") {
      setLiveStatus("Connected — speak now");
    }

    if (message.type === "error") {
      setLiveStatus("Gemini error: " + message.message);
      setSessionMessage(message.message);
    }

    if (message.type === "closed") {
      setLiveStatus("Disconnected");
    }

    if (message.type === "interrupted") {
  activeSourcesRef.current.forEach((s) => {
    try { s.stop(); } catch {}
  });
  activeSourcesRef.current = [];
  nextPlayTimeRef.current = 0;
}
    
if (message.type === "transcript") {
  setLiveTranscript((previous) => {
    const speaker = message.speaker || "Gemini";
    const lines = previous ? previous.split("\n") : [];
    const lastIndex = lines.length - 1;

    if (
      lastIndex >= 0 &&
      lines[lastIndex].startsWith(`${speaker}: `)
    ) {
      // Append the next streaming fragment to the same sentence.
      lines[lastIndex] += message.text;
    } else {
      lines.push(`${speaker}: ${message.text}`);
    }

    return lines.slice(-8).join("\n");
  });
}


    if (message.type === "audio" && outputAudioContextRef.current) {
      const audioContext = outputAudioContextRef.current;
      const binary = atob(message.data);
      const bytes = new Uint8Array(binary.length);

      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      const pcm = new Int16Array(
        bytes.buffer,
        bytes.byteOffset,
        Math.floor(bytes.byteLength / 2)
      );

      const samples = new Float32Array(pcm.length);

      for (let i = 0; i < pcm.length; i++) {
        samples[i] = pcm[i] / 32768;
      }

      const audioBuffer = audioContext.createBuffer(
        1,
        samples.length,
        24000
      );

      audioBuffer.copyToChannel(samples, 0);

      const player = audioContext.createBufferSource();
      player.buffer = audioBuffer;
      player.connect(audioContext.destination);

      const startAt = Math.max(
        audioContext.currentTime,
        nextPlayTimeRef.current
      );

      activeSourcesRef.current.push(player);
player.onended = () => {
  activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== player);
};
player.start(startAt);
nextPlayTimeRef.current = startAt + audioBuffer.duration;
    }
  };

  socket.onerror = () => {
    setLiveStatus("WebSocket connection failed");
  };

  socket.onclose = () => {
    setLiveStatus("Disconnected");
  };
};

const stopGeminiAudio = async () => {
  if (processorRef.current) processorRef.current.disconnect();
  if (sourceNodeRef.current) sourceNodeRef.current.disconnect();

  if (mediaStreamRef.current) {
    mediaStreamRef.current.getTracks().forEach((track) => track.stop());
  }

  if (audioSocketRef.current) audioSocketRef.current.close();

  if (inputAudioContextRef.current) {
    await inputAudioContextRef.current.close();
  }

  if (outputAudioContextRef.current) {
    await outputAudioContextRef.current.close();
  }

  processorRef.current = null;
  sourceNodeRef.current = null;
  mediaStreamRef.current = null;
  audioSocketRef.current = null;
  inputAudioContextRef.current = null;
  outputAudioContextRef.current = null;

  setLiveStatus("Disconnected");
};



const startSession = async () => {
  try {
    setSessionMessage("Creating session...");

    const response = await fetch("http://localhost:5000/api/sessions", {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error("Could not create Firestore session");
    }

    const session = await response.json();
    setActiveSession(session);
    setSessionMessage("Session saved. Connecting microphone...");

    await startGeminiAudio();
  } catch (error) {
    console.error("Start session error:", error);
    setSessionMessage(
      error.message || "Could not start. Check the backend and microphone permission."
    );
  }
};

const stopSession = async () => {
  if (!activeSession) return;

  try {
    await stopGeminiAudio();

    const response = await fetch(
      `http://localhost:5000/api/sessions/${activeSession.id}/complete`,
      { method: "PATCH" }
    );

    if (!response.ok) {
      throw new Error("Could not save completed session");
    }

    setActiveSession(null);
    setSessionMessage("Session completed and saved.");

    const dashboardResponse = await fetch(
      "http://localhost:5000/api/dashboard"
    );

    if (dashboardResponse.ok) {
      setDashboardData(await dashboardResponse.json());
    }
  } catch (error) {
    console.error("Stop session error:", error);
    setSessionMessage(error.message || "Could not stop the session.");
  }
};



useEffect(() => {
  const loadDashboard = async () => {
    try {
      const response = await fetch(
        "http://localhost:5000/api/dashboard"
      );

      if (!response.ok) {
        throw new Error("Could not load dashboard data");
      }

      const data = await response.json();
      setDashboardData(data);
      setApiError("");
    } catch (error) {
      setApiError("Backend unavailable. Check the server.");
    }
  };

  loadDashboard();

  const interval = setInterval(loadDashboard, 3000);

  return () => clearInterval(interval);
}, []);

  const menuItems = [
    { name: "Overview", icon: "◫" },
    { name: "Voice Agent", icon: "🎙" },
    { name: "Usage Analytics", icon: "▥" },
    { name: "Conversation Logs", icon: "☷" },
    { name: "Settings", icon: "⚙" },
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">V</div>
          <div>
            <h2>VoiceAI</h2>
            <p>INTELLIGENCE PLATFORM</p>
          </div>
        </div>

        <div className="workspace-label">WORKSPACE</div>

        <nav>
          {menuItems.map((item) => (
            <button
              key={item.name}
              className={`nav-item ${
                activePage === item.name ? "active" : ""
              }`}
              onClick={() => setActivePage(item.name)}
            >
              <span>{item.icon}</span>
              {item.name}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="profile-avatar">SC</div>
          <div>
            <strong>Admin User</strong>
            <p>Administrator</p>
          </div>
          <span className="online-dot" />
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="breadcrumb">Workspace / {activePage}</p>
            <h1>{activePage}</h1>
          </div>

          <div className="topbar-right">
            <span className="environment">
              <span className="status-dot" />
              Development
            </span>
            <button className="avatar-button">SC</button>
          </div>
        </header>

        {activePage === "Overview" && (
          <>
            <section className="welcome-section">
              <div>
                <p className="eyebrow">YOUR AI WORKSPACE</p>
                <h2>Voice intelligence, at a glance.</h2>
                <p>
                  Monitor conversations, track usage, and understand your
                  AI voice agent performance.
                </p>
              </div>
              <button
                className="primary-button"
                onClick={() => setActivePage("Voice Agent")}
              >
                <span>＋</span> Open Voice Agent
              </button>
            </section>

            <section className="stats-grid">
              <StatCard
                label="ACTIVE SESSIONS"
                value={dashboardData?.activeSessions ?? "—"}
                note="Currently active sessions"
                icon="◷"
              />

              <StatCard
                label="COMPLETED SESSIONS"
                value={dashboardData?.completedSessions ?? "—"}
                note="Completed conversations"
                icon="◴"
              />

              <StatCard
                label="ESTIMATED AI COST"
                value={
                  dashboardData
                    ? `$${dashboardData.estimatedCostUsd.toFixed(4)}`
                    : "—"
                }
                note="Estimated cost in USD"
                icon="$"
              />

              <StatCard
                label="TOTAL DURATION"
                value={
                  dashboardData
                    ? `${Math.floor(dashboardData.totalDurationSeconds / 60)} min`
                    : "—"
                }
                note="Completed conversation time"
                icon="↗"
              />
            </section>

            <section className="content-grid">
              <div className="panel agent-panel">
                <div className="panel-heading">
                  <div>
                    <h3>AI Voice Agent</h3>
                    <p>Start a real-time voice conversation</p>
                  </div>
                  <span className="coming-badge">SETUP REQUIRED</span>
                </div>

                <div className="voice-visual">
                  <div className="voice-orbit orbit-one" />
                  <div className="voice-orbit orbit-two" />
                  <div className="voice-core">✳</div>
                </div>

                <h3 className="voice-title">
                  {isListening ? "Microphone enabled" : "Ready when you are"}
                </h3>
                <p className="voice-description">
                  {isListening
                    ? "This is a visual demo. Live AI connection is not configured yet."
                    : "Your real-time AI voice experience starts here."}
                </p>

                
                <div className="session-controls">
                  {!activeSession ? (
                    <button
                      className="primary-button full-button"
                      onClick={startSession}
                    >
                      Start Session
                    </button>
                  ) : (
                    <button
                      className="primary-button full-button"
                      onClick={stopSession}
                    >
                      Stop Session
                    </button>
                  )}

                  {sessionMessage && (
                    <p className="helper-text">{sessionMessage}</p>
                  )}

                  
                  <p className="helper-text">
                    Live status: {liveStatus}
                  </p>

                  {liveTranscript && (
                    <pre className="live-transcript">{liveTranscript}</pre>
                  )}


                  {activeSession && (
                    <p className="helper-text">
                      Session is active: {activeSession.id}
                    </p>
                  )}
                </div>

                {/* <p className="helper-text">
                  Demo only — this does not connect to Gemini or record audio.
                </p> */}
              </div>

              <div className="panel activity-panel">
                <div className="panel-heading">
                  <div>
                    <h3>Usage Overview</h3>
                    <p>Conversation activity</p>
                  </div>
                  <span className="period-label">Last 7 days</span>
                </div>

                {apiError && (
                  <p className="error">{apiError}</p>
                )}

                {!apiError && dashboardData && (
                  <p className="connection-status">
                    Backend connected · Dashboard data is updating
                  </p>
                )}

                <div className="chart-placeholder">
                  <div className="chart-grid-lines">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="chart-bars">
                    {[28, 45, 34, 62, 40, 75, 51].map((height, index) => (
                      <div className="chart-bar-group" key={index}>
                        <div
                          className="chart-bar"
                          style={{ height: `${height}%` }}
                        />
                        <span>
                          {["M", "T", "W", "T", "F", "S", "S"][index]}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="chart-note">
                    Sample visualization · No real usage data yet
                  </p>
                </div>

                <div className="activity-footer">
                  <div>
                    <span className="legend-dot" />
                    Conversations
                  </div>
                  <strong>0 recorded</strong>
                </div>
              </div>
            </section>

            <section className="panel logs-panel">
              <div className="panel-heading">
                <div>
                  <h3>Recent Conversations</h3>
                  <p>Review your latest AI sessions</p>
                </div>
                <button
                  className="text-button"
                  onClick={() => setActivePage("Conversation Logs")}
                >
                  View all →
                </button>
              </div>

              <div className="empty-state">
                <div className="empty-icon">☷</div>
                <h3>No conversations yet</h3>
                <p>
                  Once the backend is connected, your conversation history
                  will appear here.
                </p>
              </div>
            </section>
          </>
        )}

        {activePage !== "Overview" && (
          <section className="panel page-placeholder">
            <div className="empty-icon">✳</div>
            <h2>{activePage}</h2>
            <p>
              This section is part of your dashboard layout. We'll connect
              it to real functionality in the next development steps.
            </p>
            <button
              className="primary-button"
              onClick={() => setActivePage("Overview")}
            >
              Back to Overview
            </button>
          </section>
        )}

        <footer className="footer">
          <span>VoiceAI Dashboard · Development Preview</span>
          <span>Built for real-time AI voice analytics</span>
        </footer>
      </main>
    </div>
  );
}

function StatCard({ label, value, note, icon }) {
  return (
    <div className="stat-card">
      <div className="stat-card-top">
        <span>{label}</span>
        <div className="stat-icon">{icon}</div>
      </div>
      <h2>{value}</h2>
      <p>{note}</p>
    </div>
  );
}

export default App;