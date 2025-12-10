// =============================================================
//  ONRAMP.MONEY AI KYC AGENT (STRICT VISION & AUDIO)
//  - High Sensitivity Noise Detection
//  - Instant Blocking/Bathroom Detection
//  - "Start New Session" Button Removed
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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const MONGO_URI = process.env.MONGO_URI; 

// --- INVESTIGATOR BRAIN ---
const SYSTEM_INSTRUCTION = `
ROLE: Senior Financial Crime Investigator.
GOAL: Detect fraud (Pig Butchering, Money Mules) FAST.

CRITICAL RULES:
1. ASK EXACTLY 3 QUESTIONS TOTAL.
2. KEEP IT SHORT. One sentence only.

LOGIC:
- Q1: Purpose of transaction?
- Q2: Who recommended this?
- Q3: Did they promise guaranteed returns?

DECISION:
- If mentions "Telegram Task", "Job", "Mentor", "Profits" -> REJECT.
- If generic investment -> APPROVE.

OUTPUT FORMAT (JSON ONLY):
{
  "next_question": "Text",
  "kyc_status": "CONTINUE" | "APPROVED" | "REJECTED",
  "risk_flag": boolean
}
`;

// --- VISION BRAIN (STRICT MODE) ---
const VISION_INSTRUCTION = `
ANALYZE THIS IMAGE FOR KYC COMPLIANCE.
Return a WARNING MESSAGE if any of these are true:
1. FACE_CHECK: No human face visible? -> "FACE NOT VISIBLE"
2. BLOCKED: Camera covered/black? -> "CAMERA BLOCKED"
3. ENVIRONMENT: 
   - Bathroom/Restroom -> "BATHROOM DETECTED (PROHIBITED)"
   - Outdoor/Public/Park -> "OUTDOOR DETECTED (GO INSIDE)"
   - Moving Vehicle -> "MOVING VEHICLE DETECTED"

If everything is safe (User sitting indoors, face clear), return message: null.

Output JSON ONLY:
{
  "environment_warning": "NONE" | "BATHROOM" | "OUTDOOR" | "MOVING_VEHICLE",
  "message": "String or null"
}
`;

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use('/uploads', express.static('uploads'));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, 'kyc-' + Date.now() + '.webm')
});
const upload = multer({ storage: storage });

// --- DATABASE ---
if (MONGO_URI) {
    mongoose.connect(MONGO_URI)
        .then(() => console.log("✅ Connected to MongoDB"))
        .catch(err => console.error("❌ MongoDB Error:", err));
}

const SessionSchema = new mongoose.Schema({
    sessionId: String,
    timestamp: { type: Date, default: Date.now },
    status: String,
    riskFlag: Boolean,
    language: String,
    transcript: [{ sender: String, text: String, time: String }],
    videoPath: String,
    environmentLogs: [{ time: String, warning: String }]
});
const Session = mongoose.model('Session', SessionSchema);

// --- HELPER ---
function cleanAndParseJSON(text) {
    const firstOpen = text.indexOf('{');
    const lastClose = text.lastIndexOf('}');
    if (firstOpen === -1 || lastClose === -1) return null;
    try { return JSON.parse(text.substring(firstOpen, lastClose + 1)); } catch (e) { return null; }
}

// --- AI LOGIC ---
async function getGeminiResponse(history, userText) {
    if (!GEMINI_API_KEY) return { next_question: "System Error: API Key missing.", kyc_status: "CONTINUE" };

    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_API_KEY;
    
    const contents = history.map(h => ({ role: h.role === 'model' ? 'model' : 'user', parts: h.parts }));
    contents.push({ role: "user", parts: [{ text: userText + " (Reply valid JSON: {next_question, kyc_status, risk_flag})" }] });

    try {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents }) });
        const data = await response.json();
        if (!data.candidates || !data.candidates[0]) return { next_question: "I didn't hear you.", kyc_status: "CONTINUE" };
        
        const raw = data.candidates[0].content.parts[0].text;
        return cleanAndParseJSON(raw) || { next_question: "Could you repeat that?", kyc_status: "CONTINUE" };
    } catch (e) {
        return { next_question: "System glitch.", kyc_status: "CONTINUE" };
    }
}

async function analyzeFrame(base64Image) {
    if (!GEMINI_API_KEY) return null;
    const cleanBase64 = base64Image.replace(/^data:image\/(png|jpeg|webp);base64,/, "");
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_API_KEY;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    role: "user",
                    parts: [
                        { text: VISION_INSTRUCTION },
                        { inline_data: { mime_type: "image/jpeg", data: cleanBase64 } }
                    ]
                }]
            })
        });
        const data = await response.json();
        if (!data.candidates || !data.candidates[0]) return null;
        return cleanAndParseJSON(data.candidates[0].content.parts[0].text);
    } catch (e) { return null; }
}

const activeSessions = {};

// --- ROUTES ---
app.post('/api/start', async (req, res) => {
    const { language } = req.body;
    const sessionId = Date.now().toString();
    const initialQ = language === 'hi-IN' ? "नमस्ते. वेरिफिकेशन के लिए अपना नाम बताएं?" : "Hello. Please state your name?";
    
    if (MONGO_URI) {
        try {
            const newSession = new Session({ sessionId, status: "ACTIVE", language, transcript: [{ sender: 'AI', text: initialQ, time: new Date().toISOString() }], riskFlag: false });
            await newSession.save();
        } catch(e) {}
    }

    activeSessions[sessionId] = { 
        history: [{ role: "user", parts: [{ text: SYSTEM_INSTRUCTION }] }, { role: "model", parts: [{ text: JSON.stringify({ next_question: initialQ }) }] }] 
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
                $push: { transcript: { $each: [{ sender: 'USER', text: userText, time: new Date().toISOString() }, { sender: 'AI', text: aiResp.next_question, time: new Date().toISOString() }] } },
                $set: { status: aiResp.kyc_status, riskFlag: aiResp.risk_flag }
            }, { new: true });
        } catch(e) {}
    }
    res.json(aiResp);
});

// VISION CHECK ENDPOINT
app.post('/api/vision-check', async (req, res) => {
    const { image, sessionId } = req.body;
    const analysis = await analyzeFrame(image);
    
    if (analysis && analysis.message) {
        console.log(`⚠️ Vision Warning [${sessionId}]: ${analysis.message}`);
        if (MONGO_URI) {
            await Session.findOneAndUpdate({ sessionId }, {
                $push: { environmentLogs: { time: new Date().toISOString(), warning: analysis.message } }
            });
        }
    }
    res.json(analysis || {});
});

app.post('/api/upload-video', upload.single('video'), async (req, res) => {
    const { sessionId } = req.body;
    if (req.file) {
        if (MONGO_URI) await Session.findOneAndUpdate({ sessionId }, { videoPath: req.file.path });
        res.json({ success: true, path: req.file.path });
    } else {
        res.status(400).json({ error: "No video file" });
    }
});

app.get('/api/admin/sessions', async (req, res) => {
    if (!MONGO_URI) return res.json([]);
    const sessions = await Session.find().sort({ timestamp: -1 }).limit(50);
    res.json(sessions);
});

// --- FRONTEND ---
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
            const [view, setView] = useState('KYC');
            const [sessionId, setSessionId] = useState(null);
            const [status, setStatus] = useState("IDLE");
            const [transcript, setTranscript] = useState([]);
            const [processing, setProcessing] = useState(false);
            const [lang, setLang] = useState('en-IN');
            const [warning, setWarning] = useState(null); // Alert Message
            const [sessions, setSessions] = useState([]); // Admin
            
            const videoRef = useRef(null);
            const mediaRecorderRef = useRef(null);
            const chunksRef = useRef([]);
            const recognitionRef = useRef(null);
            const audioContextRef = useRef(null);

            // --- NOISE DETECTION ---
            const startNoiseDetection = (stream) => {
                if (audioContextRef.current) return;
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                const audioCtx = new AudioContext();
                const analyser = audioCtx.createAnalyser();
                const microphone = audioCtx.createMediaStreamSource(stream);
                const scriptProcessor = audioCtx.createScriptProcessor(2048, 1, 1);
                
                microphone.connect(analyser);
                analyser.connect(scriptProcessor);
                scriptProcessor.connect(audioCtx.destination);
                
                scriptProcessor.onaudioprocess = () => {
                    const array = new Uint8Array(analyser.frequencyBinCount);
                    analyser.getByteFrequencyData(array);
                    const average = array.reduce((a, b) => a + b, 0) / array.length;
                    
                    // SENSITIVITY: > 50 is noisy (Lowered for easier testing)
                    if (average > 50) { 
                        setWarning("🔊 TOO NOISY! Please find a quiet place.");
                        setTimeout(() => setWarning(null), 2500);
                    }
                };
                audioContextRef.current = audioCtx;
            };

            // --- CAMERA SETUP ---
            useEffect(() => {
                if (view === 'KYC') {
                    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
                        .then(stream => {
                            if (videoRef.current) videoRef.current.srcObject = stream;
                            startNoiseDetection(stream);
                        })
                        .catch(e => console.error("Camera denied:", e));
                }
            }, [view]);

            // --- VISION CHECK (Runs every 3s when ACTIVE) ---
            useEffect(() => {
                if (status !== 'ACTIVE') return;
                const interval = setInterval(captureAndAnalyzeFrame, 3000); // 3s Interval
                return () => clearInterval(interval);
            }, [status, sessionId]);

            const captureAndAnalyzeFrame = () => {
                if (!videoRef.current) return;
                const canvas = document.createElement('canvas');
                canvas.width = 320; canvas.height = 240;
                canvas.getContext('2d').drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
                const base64 = canvas.toDataURL('image/jpeg', 0.5); // Low Quality for speed
                
                fetch('/api/vision-check', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ image: base64, sessionId })
                })
                .then(res => res.json())
                .then(data => {
                    if (data.message) {
                        setWarning("⚠️ " + data.message);
                        // If Bathroom detected, stick the warning for longer
                        if (data.environment_warning === 'BATHROOM') {
                             setTimeout(() => setWarning(null), 5000); 
                        } else {
                             setTimeout(() => setWarning(null), 3000);
                        }
                    }
                });
            };

            // --- RECORDING ---
            const startRecording = () => {
                const stream = videoRef.current.srcObject;
                if (!stream) return;
                const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
                chunksRef.current = [];
                recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
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
                    fetch('/api/upload-video', { method: 'POST', body: formData });
                };
                mediaRecorderRef.current.stop();
            };

            // --- AI INTERACTION ---
            useEffect(() => {
                const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
                if (!SpeechRecognition) return;
                const recognition = new SpeechRecognition();
                recognition.lang = lang;
                recognition.continuous = false;
                recognition.onresult = (e) => handleUserAnswer(e.results[0][0].transcript);
                recognitionRef.current = recognition;
            }, [lang, sessionId]);

            const speak = (text) => {
                window.speechSynthesis.cancel();
                const u = new SpeechSynthesisUtterance(text);
                u.lang = lang;
                u.onend = () => { if (status === 'ACTIVE') try { recognitionRef.current.start(); } catch(e){} };
                window.speechSynthesis.speak(u);
            };

            const startSession = async () => {
                setStatus("ACTIVE");
                startRecording();
                const res = await fetch('/api/start', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ language: lang }) });
                const data = await res.json();
                setSessionId(data.sessionId);
                addTranscript('AI', data.next_question);
                speak(data.next_question);
            };

            const handleUserAnswer = async (text) => {
                addTranscript('USER', text);
                setProcessing(true);
                const res = await fetch('/api/process', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ sessionId, userText: text }) });
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

            const addTranscript = (sender, text) => setTranscript(prev => [...prev, { sender, text, time: new Date().toLocaleTimeString() }]);

            const loadAdminData = async () => {
                const res = await fetch('/api/admin/sessions');
                const data = await res.json();
                setSessions(data);
            };

            useEffect(() => { if (view === 'ADMIN') loadAdminData(); }, [view]);

            if (view === 'ADMIN') {
                return (
                    <div className="min-h-screen bg-slate-50 p-8">
                        <div className="max-w-6xl mx-auto">
                            <div className="flex justify-between items-center mb-8"><h1 className="text-3xl font-bold text-slate-800">Admin <span className="text-blue-600">Dashboard</span></h1><button onClick={() => setView('KYC')} className="bg-white border border-slate-300 text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-50 font-medium">← Back</button></div>
                            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                                <table className="w-full text-left">
                                    <thead className="bg-slate-50 border-b border-slate-200"><tr><th className="p-4 font-semibold text-slate-600">ID</th><th className="p-4 font-semibold text-slate-600">Time</th><th className="p-4 font-semibold text-slate-600">Status</th><th className="p-4 font-semibold text-slate-600">Video</th></tr></thead>
                                    <tbody className="divide-y divide-slate-100">{sessions.map(s => (<tr key={s._id} className="hover:bg-slate-50/50"><td className="p-4 text-xs font-mono">{s.sessionId}</td><td className="p-4 text-sm">{new Date(s.timestamp).toLocaleString()}</td><td className="p-4"><span className={"px-2 py-1 rounded-full text-xs font-bold " + (s.status === 'APPROVED' ? "bg-green-100 text-green-700" : s.status === 'REJECTED' ? "bg-red-100 text-red-700" : "bg-slate-100")}>{s.status}</span></td><td className="p-4">{s.videoPath ? <a href={"/" + s.videoPath} target="_blank" className="text-blue-600 hover:underline text-sm font-medium">Watch</a> : "-"}</td></tr>))}</tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                );
            }

            return (
                <div className="flex flex-col md:flex-row h-full">
                    <div className="w-full md:w-1/2 bg-slate-900 relative flex flex-col items-center justify-center p-4">
                        <div className="absolute top-6 right-6 z-20"><button onClick={() => setView('ADMIN')} className="bg-white/10 backdrop-blur-md border border-white/20 text-white px-3 py-1.5 rounded-lg text-xs font-medium">Dashboard</button></div>
                        <div className="absolute top-6 left-6 z-10"><div className="bg-white/10 backdrop-blur-md border border-white/20 text-white px-4 py-1.5 rounded-full text-sm font-medium flex items-center gap-2"><div className={"w-2 h-2 rounded-full " + (status === 'ACTIVE' ? "bg-red-500 animate-pulse" : "bg-slate-400")}></div>{status === 'ACTIVE' ? "REC • LIVE" : "CAMERA READY"}</div></div>
                        
                        {/* ⚠️ THE WARNING OVERLAY */}
                        {warning && (
                            <div className="absolute top-20 left-1/2 -translate-x-1/2 z-50 w-3/4 max-w-sm">
                                <div className="bg-red-600 text-white px-6 py-4 rounded-xl shadow-2xl animate-bounce text-center border-2 border-red-400">
                                    <div className="text-2xl mb-1">⚠️ ALERT</div>
                                    <div className="font-bold text-sm tracking-wide">{warning}</div>
                                </div>
                            </div>
                        )}

                        <video ref={videoRef} autoPlay muted className="w-full max-w-lg aspect-video bg-black rounded-2xl shadow-2xl border border-slate-700 object-cover transform -scale-x-100"></video>
                        <div className="absolute bottom-8 text-center w-full px-4"><p className="text-slate-400 text-sm mb-2">{status === 'ACTIVE' ? "AI Agent is analyzing your environment..." : "Secure Environment 🔒"}</p></div>
                    </div>
                    <div className="w-full md:w-1/2 bg-white flex flex-col border-l border-slate-200">
                        <div className="h-16 border-b border-slate-100 flex items-center justify-between px-6 bg-white shrink-0"><h1 className="font-bold text-slate-800 text-lg">Onramp<span className="text-blue-600">Verification</span></h1><div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Session ID: {sessionId || '---'}</div></div>
                        <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-slate-50 scroller">
                            {transcript.map((t, i) => (<div key={i} className={"flex flex-col " + (t.sender === 'USER' ? 'items-end' : 'items-start')}><div className={"chat-bubble px-5 py-3 rounded-2xl text-sm leading-relaxed shadow-sm " + (t.sender === 'USER' ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-white border border-slate-200 text-slate-700 rounded-bl-sm')}>{t.text}</div><span className="text-[10px] text-slate-400 mt-1 px-1">{t.sender} • {t.time}</span></div>))}
                            {processing && (<div className="flex items-start"><div className="bg-white border border-slate-200 px-4 py-3 rounded-2xl rounded-bl-sm shadow-sm flex gap-1"><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce"></div><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '0.1s'}}></div><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '0.2s'}}></div></div></div>)}
                        </div>
                        <div className="p-6 border-t border-slate-100 bg-white shrink-0">
                            {status === 'IDLE' ? (<div className="flex flex-col gap-3"><label className="text-sm font-medium text-slate-600">Select Language to Begin</label><div className="flex gap-3"><button onClick={() => setLang('en-IN')} className={"flex-1 py-3 rounded-xl border text-sm font-semibold transition " + (lang === 'en-IN' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 hover:border-blue-300')}>🇬🇧 English</button><button onClick={() => setLang('hi-IN')} className={"flex-1 py-3 rounded-xl border text-sm font-semibold transition " + (lang === 'hi-IN' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 hover:border-blue-300')}>🇮🇳 Hindi</button></div><button onClick={startSession} className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-4 rounded-xl shadow-lg shadow-slate-200/50 transition mt-2 flex items-center justify-center gap-2"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>Start Video Verification</button></div>) : status === 'ACTIVE' ? (<div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex items-center gap-3"><div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div><span className="text-blue-700 font-medium text-sm">Session in progress. Please speak clearly.</span></div>) : (<div className={"p-4 rounded-xl border text-center " + (status === 'APPROVED' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700')}><div className="text-xs font-bold uppercase mb-1">Status</div><div className="text-2xl font-bold">{status}</div><p className="text-xs mt-2 opacity-80">Video & Transcript uploaded to database.</p></div>)}
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

app.listen(port, () => { console.log("Server running at http://localhost:" + port); });
