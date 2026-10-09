
const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const serviceAccount = require("./serviceAccountKey.json");

if (getApps().length === 0) {
  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/live" });
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ success: true, message: "Backend and Firebase connected" });
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const snapshot = await db.collection("sessions").get();
    const sessions = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    const completed = sessions.filter((s) => s.status === "completed");

    res.json({
      activeSessions: sessions.filter((s) => s.status === "active").length,
      completedSessions: completed.length,
      totalDurationSeconds: completed.reduce(
        (sum, s) => sum + (s.durationSeconds || 0), 0
      ),
      estimatedCostUsd: sessions.reduce(
        (sum, s) => sum + (s.estimatedCostUsd || 0), 0
      ),
      sessions,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load dashboard" });
  }
});

app.post("/api/sessions", async (req, res) => {
  try {
    const session = {
      status: "active",
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationSeconds: 0,
      estimatedCostUsd: 0,
    };
    const doc = await db.collection("sessions").add(session);
    res.status(201).json({ id: doc.id, ...session });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not start session" });
  }
});

app.patch("/api/sessions/:id/complete", async (req, res) => {
  try {
    const ref = db.collection("sessions").doc(req.params.id);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session = doc.data();
    if (session.status === "completed") {
      return res.json({ id: doc.id, ...session });
    }

    const endedAt = new Date();
    const updated = {
      status: "completed",
      endedAt: endedAt.toISOString(),
      durationSeconds: Math.max(
        0,
        Math.round((endedAt.getTime() - new Date(session.startedAt).getTime()) / 1000)
      ),
    };

    await ref.update(updated);
    res.json({ id: doc.id, ...session, ...updated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not stop session" });
  }
});

// One Gemini Live connection per browser connection.
wss.on("connection", async (client) => {
  let geminiSession;

  const sendToBrowser = (message) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  };

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is missing from server/.env");
    }

    const { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } =
  await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    geminiSession = await ai.live.connect({
      model: "gemini-3.8-live",
      config: {
  responseModalities: [Modality.AUDIO],
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  systemInstruction: "You are a friendly voice assistant. Keep answers short.",
  realtimeInputConfig: {
    automaticActivityDetection: {
      startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
      endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
      silenceDurationMs: 600,
    },
  },
},
      callbacks: {
        onopen: () => sendToBrowser({ type: "connected" }),
        onmessage: (message) => {
        console.log(
            "GEMINI EVENT:",
            JSON.stringify(message).slice(0, 2000)
        );

        

        const content = message.serverContent;
        if (content?.interrupted) {
  sendToBrowser({ type: "interrupted" });
}
            if (content?.modelTurn?.parts) {
  console.log("Gemini returned model output");
}
          if (content?.modelTurn?.parts) {
            for (const part of content.modelTurn.parts) {
              if (part.inlineData?.data) {
                sendToBrowser({
                  type: "audio",
                  data: part.inlineData.data,
                });
              }
            }
          }

          if (content?.inputTranscription?.text) {
            sendToBrowser({
              type: "transcript",
              speaker: "You",
              text: content.inputTranscription.text,
            });
          }

          if (content?.outputTranscription?.text) {
            sendToBrowser({
              type: "transcript",
              speaker: "Gemini",
              text: content.outputTranscription.text,
            });
          }
        },
        onerror: (error) => {
          console.error("Gemini Live error:", error);
          sendToBrowser({
            type: "error",
            message: "Gemini Live reported an error. Check the server terminal.",
          });
        },
        onclose: () => sendToBrowser({ type: "closed" }),
      },
    });
    console.log("Gemini Live session initialized");

    // Temporary test: ask Gemini to speak without using the microphone.
    geminiSession.sendRealtimeInput({
    text: "Say hello out loud in one short sentence."
    });

    console.log("Test prompt sent to Gemini");

    console.log("Gemini Live session initialized");

    client.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === "audio" && !client.audioLogged) {
        console.log("SUCCESS: Microphone audio reached the backend");
        client.audioLogged = true;
        }
        if (message.type === "audio" && message.data && geminiSession) {
  // Debug: measure loudness of the incoming mic chunk
  const buf = Buffer.from(message.data, "base64");
  let sum = 0;
  const n = Math.floor(buf.length / 2);
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  client.chunks = (client.chunks || 0) + 1;
  if (client.chunks % 4 === 0) {
    console.log(`mic chunk #${client.chunks} samples=${n} rms=${rms.toFixed(0)}`);
  }

  geminiSession.sendRealtimeInput({
    audio: { data: message.data, mimeType: "audio/pcm;rate=16000" },
  });
}
      } catch (error) {
        console.error("Invalid live message:", error);
      }
    });
  } catch (error) {
    console.error("Could not start Gemini Live:", error);
    sendToBrowser({
      type: "error",
      message: error.message || "Could not connect to Gemini Live.",
    });
  }

  client.on("close", () => {
    if (geminiSession) geminiSession.close();
  });
});

server.listen(PORT, () => {
  console.log(`VoiceAI backend running at http://localhost:${PORT}`);
});
