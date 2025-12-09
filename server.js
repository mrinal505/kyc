// =============================================================
//  ONRAMP.MONEY AI KYC AGENT (PRO VERSION - FIXED)
//  - MongoDB Database Integration
//  - Video Recording & Upload
//  - Professional Split-Screen UI
// =============================================================

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// --- CONFIGURATION ---
// ⚠️ Ensure these are set in Render Environment Variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const MONGO_URI = process.env.MONGO_URI; 

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use('/uploads', express.static('uploads'));

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Configure Multer for Video Storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, 'kyc-' + Date.now() + '.webm')
});
const upload = multer({ storage: storage });

// --- DATABASE CONNECTION ---
// Graceful fallback if Mongo is missing for testing
if (MONGO_URI) {
    mongoose.connect(MONGO_URI)
        .then(() => console.log("✅ Connected to MongoDB"))
        .catch(err => console.error("❌ MongoDB Error:", err));
} else {
    console.warn("⚠️ MONGO_URI missing. Database features will be skipped.");
}

// --- DATABASE SCHEMA ---
const SessionSchema = new mongoose.Schema({
    sessionId: String,
    timestamp: { type: Date, default: Date.now },
    status: String,
    riskFlag: Boolean,
    language: String,
    transcript: [{ sender: String, text: String, time: String }],
    videoPath: String
});

const Session = mongoose.model('Session', SessionSchema);

// --- AI LOGIC ---
async function getGeminiResponse(history, userText) {
    if (!GEMINI_API_KEY) return { next_question: "API Key Missing", kyc_status: "CONTINUE" };

    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + GEMINI_API_KEY;
    
    const contents = history.map(h => ({
        role: h.role === 'model' ? 'model' : 'user',
        parts: h.parts
    }));
    contents.push({ role: "user", parts: [{ text: userText + " (Reply valid JSON: {next_question, kyc_status, risk_flag})" }] });

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents })
        });
        const data = await response.json();
        let raw = data.candidates[0].content.parts[0].text;
        raw = raw.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(raw);
    } catch (e) {
        console.error("AI Error:", e);
        return { next_question: "I didn't catch that.", kyc_status: "CONTINUE", risk_flag: false };
    }
}

const activeSessions = {};

// --- ROUTES ---

app.post('/api/start', async (req, res) => {
    const { language } = req.body;
    const sessionId = Date.now().toString();
    const initialQ = language === 'hi-IN' ? "नमस्ते, अपना नाम बताइये?" : "Hello, please state your name.";
    
    if (MONGO_URI) {
        try {
            const newSession = new Session({
                sessionId,
                status: "ACTIVE",
                language,
                transcript: [{ sender: 'AI', text: initialQ, time: new Date().toISOString() }],
                riskFlag: false
            });
            await newSession.save();
        } catch(e) { console.error("DB Save Error", e); }
    }

    activeSessions[sessionId] = { 
        history: [{ role: "model", parts: [{ text: JSON.stringify({ next_question: initialQ }) }] }] 
    };

    res.json({ sessionId, next_question: initialQ, language_code: language });
});

app.post('/api/process', async (req, res) => {
    const { sessionId, userText } = req.body;
    if (!activeSessions[sessionId]) return res.status(404).json({ error: "Session expired" });

    const aiResp = await getGeminiResponse(activeSessions[sessionId].history, userText);
    
    activeSessions[sessionId].history.push({ role: "user", parts: [{ text: userText }] });
    activeSessions[sessionId].history.push({ role: "model", parts: [{ text: JSON.stringify(aiResp) }] });

    if (MONGO_URI) {
        try {
            await Session.findOneAndUpdate({ sessionId }, {
                $push: { 
                    transcript: [
                        { sender: 'USER', text: userText, time: new Date().toISOString() },
                        { sender: 'AI', text: aiResp.next_question, time: new Date().toISOString() }
                    ]
                },
                $set: { status: aiResp.kyc_status, riskFlag: aiResp.risk_flag }
            });
        } catch(e) { console.error("DB Update Error", e); }
    }

    res.json(aiResp);
});

app.post('/api/upload-video', upload.single('video'), async (req, res) => {
    const { sessionId } = req.body;
    if (req.file) {
        console.log("🎥 Video saved:", req.file.path);
        if (MONGO_URI) {
            await Session.findOneAndUpdate({ sessionId }, { videoPath: req.file.path });
        }
        res.json({ success: true, path: req.file.path });
    } else {
        res.status(400).json({ error: "No video file" });
    }
});

// --- FRONTEND UI ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Onramp Professional KYC</title>
    <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/babel-standalone@6/babel.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style> 
        body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #F1F5F9; }
        .chat-bubble { max-width: 85%; animation: fadeIn 0.3s ease-up; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .scroller::-webkit-scrollbar { width: 6px; }
        .scroller::-webkit-scrollbar-track { background: transparent; }
        .scroller::-webkit-scrollbar-thumb { background-color: #CBD5E1; border-radius: 20px; }
    </style>
</head>
<body class="h-screen flex flex-col overflow-hidden">

    <div id="root" class="h-full"></div>

    <script type="text/babel">
        const { useState, useEffect, useRef } = React;

        function App() {
            const [sessionId, setSessionId] = useState(null);
            const [status, setStatus] = useState("IDLE");
            const [transcript, setTranscript] = useState([]);
            const [processing, setProcessing] = useState(false);
            const [lang, setLang] = useState('en-IN');
            
            const videoRef = useRef(null);
            const mediaRecorderRef = useRef(null);
            const chunksRef = useRef([]);
            const recognitionRef = useRef(null);

            useEffect(() => {
                navigator.mediaDevices.getUserMedia({ video: true, audio: true })
                    .then(stream => {
                        if (videoRef.current) videoRef.current.srcObject = stream;
                    })
                    .catch(e => console.error("Camera denied:", e));
            }, []);

            const startRecording = () => {
                const stream = videoRef.current.srcObject;
                if (!stream) return;
                
                const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
                chunksRef.current = [];
                
                recorder.ondataavailable = (e) => {
                    if (e.data.size > 0) chunksRef.current.push(e.data);
                };
                
                recorder.start();
                mediaRecorderRef.current = recorder;
            };

            const stopAndUploadRecording = (finalSessionId) => {
                if (!mediaRecorderRef.current) return;
                
                mediaRecorderRef.current.onstop = () => {
                    const blob = new Blob(chunksRef.current, { type: 'video/webm' });
                    const formData = new FormData();
                    formData.append("video", blob);
                    formData.append("sessionId", finalSessionId);
                    
                    fetch('/api/upload-video', { method: 'POST', body: formData })
                        .then(res => console.log("Video Uploaded Successfully"))
                        .catch(err => console.error("Upload failed", err));
                };
                
                mediaRecorderRef.current.stop();
            };

            useEffect(() => {
                const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
                if (!SpeechRecognition) return;

                const recognition = new SpeechRecognition();
                recognition.lang = lang;
                recognition.continuous = false;
                
                recognition.onresult = (e) => {
                    const text = e.results[0][0].transcript;
                    handleUserAnswer(text);
                };
                
                recognitionRef.current = recognition;
            }, [lang, sessionId]);

            const speak = (text) => {
                window.speechSynthesis.cancel();
                const u = new SpeechSynthesisUtterance(text);
                u.lang = lang;
                u.onend = () => {
                    if (status === 'ACTIVE' || status === 'IDLE') {
                        try { recognitionRef.current.start(); } catch(e){}
                    }
                };
                window.speechSynthesis.speak(u);
            };

            const startSession = async () => {
                setStatus("ACTIVE");
                startRecording();
                
                const res = await fetch('/api/start', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ language: lang })
                });
                const data = await res.json();
                
                setSessionId(data.sessionId);
                addTranscript('AI', data.next_question);
                speak(data.next_question);
            };

            const handleUserAnswer = async (text) => {
                addTranscript('USER', text);
                setProcessing(true);
                
                const res = await fetch('/api/process', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ sessionId, userText: text })
                });
                const data = await res.json();
                setProcessing(false);

                addTranscript('AI', data.next_question);
                
                if (data.kyc_status !== 'CONTINUE') {
                    setStatus(data.kyc_status);
                    stopAndUploadRecording(sessionId);
                    speak(data.next_question);
                } else {
                    speak(data.next_question);
                }
            };

            const addTranscript = (sender, text) => {
                setTranscript(prev => [...prev, { sender, text, time: new Date().toLocaleTimeString() }]);
            };

            return (
                <div className="flex flex-col md:flex-row h-full">
                    {/* LEFT PANEL: VIDEO */}
                    <div className="w-full md:w-1/2 bg-slate-900 relative flex flex-col items-center justify-center p-4">
                        <div className="absolute top-6 left-6 z-10">
                            <div className="bg-white/10 backdrop-blur-md border border-white/20 text-white px-4 py-1.5 rounded-full text-sm font-medium flex items-center gap-2">
                                <div className={"w-2 h-2 rounded-full " + (status === 'ACTIVE' ? "bg-red-500 animate-pulse" : "bg-slate-400")}></div>
                                {status === 'ACTIVE' ? "REC • LIVE" : "CAMERA READY"}
                            </div>
                        </div>
                        
                        <video ref={videoRef} autoPlay muted className="w-full max-w-lg aspect-video bg-black rounded-2xl shadow-2xl border border-slate-700 object-cover transform -scale-x-100"></video>

                        <div className="absolute bottom-8 text-center w-full px-4">
                             <p className="text-slate-400 text-sm mb-2">{status === 'ACTIVE' ? "AI Agent is analyzing your responses..." : "Secure Environment 🔒"}</p>
                        </div>
                    </div>

                    {/* RIGHT PANEL: INTERFACE */}
                    <div className="w-full md:w-1/2 bg-white flex flex-col border-l border-slate-200">
                        {/* Header */}
                        <div className="h-16 border-b border-slate-100 flex items-center justify-between px-6 bg-white shrink-0">
                            <h1 className="font-bold text-slate-800 text-lg">Onramp<span className="text-blue-600">Verification</span></h1>
                            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Session ID: {sessionId || '---'}</div>
                        </div>

                        {/* Chat Area */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-slate-50 scroller">
                            {transcript.map((t, i) => (
                                <div key={i} className={"flex flex-col " + (t.sender === 'USER' ? 'items-end' : 'items-start')}>
                                    <div className={"chat-bubble px-5 py-3 rounded-2xl text-sm leading-relaxed shadow-sm " + (t.sender === 'USER' ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-white border border-slate-200 text-slate-700 rounded-bl-sm')}>
                                        {t.text}
                                    </div>
                                    <span className="text-[10px] text-slate-400 mt-1 px-1">{t.sender} • {t.time}</span>
                                </div>
                            ))}
                            {processing && (
                                <div className="flex items-start">
                                    <div className="bg-white border border-slate-200 px-4 py-3 rounded-2xl rounded-bl-sm shadow-sm flex gap-1">
                                        <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce"></div>
                                        <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '0.1s'}}></div>
                                        <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '0.2s'}}></div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Footer Controls */}
                        <div className="p-6 border-t border-slate-100 bg-white shrink-0">
                            {status === 'IDLE' ? (
                                <div className="flex flex-col gap-3">
                                    <label className="text-sm font-medium text-slate-600">Select Language to Begin</label>
                                    <div className="flex gap-3">
                                        <button onClick={() => setLang('en-IN')} className={"flex-1 py-3 rounded-xl border text-sm font-semibold transition " + (lang === 'en-IN' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 hover:border-blue-300')}>🇬🇧 English</button>
                                        <button onClick={() => setLang('hi-IN')} className={"flex-1 py-3 rounded-xl border text-sm font-semibold transition " + (lang === 'hi-IN' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 hover:border-blue-300')}>🇮🇳 Hindi</button>
                                    </div>
                                    <button onClick={startSession} className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-4 rounded-xl shadow-lg shadow-slate-200/50 transition mt-2 flex items-center justify-center gap-2">
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                                        Start Video Verification
                                    </button>
                                </div>
                            ) : status === 'ACTIVE' ? (
                                <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex items-center gap-3">
                                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                                    <span className="text-blue-700 font-medium text-sm">Session in progress. Please speak clearly.</span>
                                </div>
                            ) : (
                                <div className={"p-4 rounded-xl border text-center " + (status === 'APPROVED' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700')}>
                                    <div className="text-xs font-bold uppercase mb-1">Status</div>
                                    <div className="text-2xl font-bold">{status}</div>
                                    <p className="text-xs mt-2 opacity-80">Video & Transcript uploaded to database.</p>
                                    <button onClick={() => window.location.reload()} className="mt-4 text-xs underline">Start New Session</button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            );
        }

        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(<App />);
    </script>
</body>
</html>
    `);
});

app.listen(port, () => {
    console.log("Server running at http://localhost:" + port);
});
