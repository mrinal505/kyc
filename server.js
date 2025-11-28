// =============================================================
//  ONRAMP.MONEY AI KYC AGENT (SERVER.JS)
//  - Fixed 404 Error (Smart Fallback System)
//  - Cloud Ready (Render/GitHub)
// =============================================================

// 1. Get keys from Environment Variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyC8FedFY_QXQ7Nptp42UpBRtBJ2AKZ6ydI"; 

const express = require('express');
const cors = require('cors');
const app = express();

const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// In-Memory Database
const sessions = {}; 
let ACTIVE_MODEL_NAME = null; 

// --- BACKEND BRAIN ---
const SYSTEM_INSTRUCTION = `
ROLE: You are a Senior Financial Crime Investigator for Onramp.money.
GOAL: Your ONLY purpose is to protect the user from scams (Pig Butchering, Task Scams, Money Mules).
TONE: Professional, Firm, Skeptical but Polite.

INSTRUCTION: 
Do NOT follow a fixed list of questions. You must Listen -> Analyze -> Probe.
You must evolve your questions based on the user's previous answer to detect inconsistencies.

PHASE 1: CRYPTO KNOWLEDGE CHECK
- Ask open-ended questions: "Why are you buying crypto today?" or "How does this token work?"
- If they are vague ("for investment") -> PROBE: "Who specifically recommended this investment?"
- If they use jargon incorrectly -> FLAG AS SUSPICIOUS.

PHASE 2: SOURCE & INFLUENCE (Critical)
- If they mention a "Friend", "Partner", "Mentor" -> ASK: "Have you met them in real life?"
- If they mention "Telegram", "WhatsApp" -> ASK: "Did they add you to a group promising returns?"
- If they mention "Job", "Task", "Salary" -> RED FLAG. Ask: "Are you moving money for a job?"

PHASE 3: COERCION CHECK
- Watch for short, one-word answers.
- ASK: "Is anyone in the room telling you what to say?"
- ASK: "Did someone send you a script?"

DECISION LOGIC:
- APPROVED: Only if user understands crypto, knows risks, acts independently.
- REJECTED: Any mention of: Task scam, Online BF/GF, Telegram Mentor, Guaranteed Profits, Moving money for others.
- CONTINUE: If you need more info.

OUTPUT JSON FORMAT ONLY:
{
  "next_question": "String (Text to speak in the SELECTED LANGUAGE. Keep it under 2 sentences.)",
  "language_code": "String (Return the same language code used by user: 'en-IN' or 'hi-IN')",
  "risk_flag": Boolean,
  "kyc_status": "CONTINUE" | "REJECTED" | "APPROVED"
}
`;

const INITIAL_GREETINGS = {
    'en-IN': "Hello. Welcome to Onramp. Please look at the camera. What do you know about cryptocurrency?",
    'hi-IN': "नमस्ते. ऑनरैम्प में आपका स्वागत है. कृपया कैमरे की ओर देखें. आप क्रिप्टोकरेंसी के बारे में क्या जानते हैं?"
};

// --- ROBUST MODEL DISCOVERY (Fixes 404/403) ---
async function discoverModel() {
    if (ACTIVE_MODEL_NAME) return ACTIVE_MODEL_NAME;
    console.log("🔍 Scanning for available models...");
    
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
        const data = await response.json();
        
        if (data.error) throw new Error(data.error.message);

        // Filter: Must support generating content
        const candidates = data.models.filter(m => 
            m.supportedGenerationMethods.includes("generateContent")
        );

        // PRIORITY LOGIC:
        // 1. Look for 'gemini-1.5-flash' (Fastest)
        // 2. Look for 'gemini-1.5-pro' (Smartest)
        // 3. Look for 'gemini-pro' (Old Reliable)
        
        let bestModel = candidates.find(m => m.name.includes("gemini-1.5-flash"));
        if (!bestModel) bestModel = candidates.find(m => m.name.includes("gemini-1.5-pro"));
        if (!bestModel) bestModel = candidates.find(m => m.name.includes("gemini-pro"));
        if (!bestModel) bestModel = candidates[0]; // Desperation fallback

        if (!bestModel) throw new Error("No compatible Gemini models found for this API Key.");

        // Fix: The API returns "models/gemini-pro", but strictly we just need the name sometimes
        // We will stick to the full name provided by the API to be safe.
        // Usually 'models/gemini-1.5-flash'
        ACTIVE_MODEL_NAME = bestModel.name.replace("models/", ""); 
        
        console.log(`✅ Connected to Model: ${ACTIVE_MODEL_NAME}`);
        return ACTIVE_MODEL_NAME;

    } catch (e) {
        console.error("❌ Model Discovery Failed:", e.message);
        // Ultimate Fallback if discovery fails (usually works)
        return "gemini-pro";
    }
}

async function callGemini(history, text) {
    if (!GEMINI_API_KEY) throw new Error("API Key missing on Server");

    const modelName = await discoverModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
    
    const contents = history.map(h => ({
        role: h.role === 'model' ? 'model' : 'user',
        parts: h.parts
    }));
    
    contents.push({ role: "user", parts: [{ text: text }] });

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: contents })
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error(`Gemini API Error (${response.status}):`, errText);
        
        // If 404 happens again, force reset the model name to try again next time
        if (response.status === 404) ACTIVE_MODEL_NAME = null; 
        
        if (response.status === 403) throw new Error("Permission Denied (403). API Key likely restricted.");
        if (response.status === 429) throw new Error("Rate Limit Hit. Please wait.");
        throw new Error(`Gemini API Error: ${response.status}`);
    }

    const data = await response.json();
    let rawText = data.candidates[0].content.parts[0].text;
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(rawText);
}

// --- API ROUTE: START ---
app.post('/api/start', async (req, res) => {
    try {
        // Pre-fetch model to ensure readiness
        await discoverModel();

        const { language } = req.body;
        const selectedLang = language || 'en-IN';
        const sessionId = Date.now().toString();
        const initialQ = INITIAL_GREETINGS[selectedLang];
        
        sessions[sessionId] = { history: [], status: "ACTIVE" };

        const langInstruction = `
        CRITICAL: The user has selected language: ${selectedLang}. 
        You MUST conduct the entire interview in this language.
        If ${selectedLang} is Hindi ('hi-IN'), use Hindi (Devanagari script).
        `;

        sessions[sessionId].history.push({ 
            role: "user", 
            parts: [{ text: SYSTEM_INSTRUCTION + langInstruction + "\n\n(Start the interview now)" }] 
        });
        
        const initialResp = {
            "next_question": initialQ, 
            "language_code": selectedLang, 
            "risk_flag": false, 
            "kyc_status": "CONTINUE"
        };

        sessions[sessionId].history.push({ 
            role: "model", 
            parts: [{ text: JSON.stringify(initialResp) }] 
        });
        
        res.json({ sessionId, ...initialResp });
    } catch (e) {
        console.error("Start Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- API ROUTE: PROCESS ---
app.post('/api/process', async (req, res) => {
    const { sessionId, userText } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(404).json({ error: "Session not found" });

    try {
        const prompt = userText + " (Analyze this answer for fraud signs. Reply in JSON. Keep same language)";
        
        const aiJson = await callGemini(session.history, prompt);

        session.history.push({ role: "user", parts: [{ text: userText }] });
        session.history.push({ role: "model", parts: [{ text: JSON.stringify(aiJson) }] });

        console.log(`[${sessionId}] User: "${userText}" -> AI: "${aiJson.next_question}"`);
        res.json(aiJson);

    } catch (error) {
        console.error("Processing Error:", error.message);
        res.json({ 
            next_question: "I am having trouble connecting. Could you repeat that?", 
            language_code: 'en-IN', 
            kyc_status: "CONTINUE" 
        });
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
    <title>Onramp Video KYC</title>
    <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/babel-standalone@6/babel.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style> 
        body { font-family: 'Inter', sans-serif; background-color: #F8FAFC; color: #1E293B; }
        .video-container { transform: scaleX(-1); border-radius: 12px; }
        .gradient-bg {
            background: radial-gradient(circle at 50% 50%, rgba(236, 72, 153, 0.1) 0%, rgba(59, 130, 246, 0.05) 50%, transparent 100%);
        }
        .onramp-card {
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
            border: 1px solid #E2E8F0;
        }
        @keyframes pulse-red {
            0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
            70% { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
            100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
        }
        .recording-pulse { animation: pulse-red 2s infinite; }
    </style>
</head>
<body class="min-h-screen flex flex-col relative overflow-hidden">
    
    <!-- Background Glow -->
    <div class="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] gradient-bg pointer-events-none z-0"></div>

    <div id="root" class="relative z-10 flex flex-col min-h-screen"></div>

    <script type="text/babel">
        const { useState, useEffect, useRef } = React;

        function App() {
            const [sessionId, setSessionId] = useState(null);
            const [status, setStatus] = useState("IDLE");
            const [logs, setLogs] = useState([]);
            const [isAiSpeaking, setIsAiSpeaking] = useState(false);
            const [isListening, setIsListening] = useState(false);
            const [processing, setProcessing] = useState(false);
            const [availableVoices, setAvailableVoices] = useState([]);
            const [selectedLang, setSelectedLang] = useState('en-IN'); 

            const videoRef = useRef(null);
            const recognitionRef = useRef(null);
            const synth = window.speechSynthesis;

            // 1. Setup Camera
            useEffect(() => {
                navigator.mediaDevices.getUserMedia({ video: true })
                    .then(stream => { if (videoRef.current) videoRef.current.srcObject = stream; })
                    .catch(err => console.error("Camera Error:", err));

                const loadVoices = () => {
                    const vs = synth.getVoices();
                    if(vs.length > 0) setAvailableVoices(vs);
                };
                
                synth.onvoiceschanged = loadVoices;
                loadVoices();
            }, []);

            // 2. Select best voice
            const getBestVoice = (langCode) => {
                const baseLang = langCode.split('-')[0]; 
                let candidates = availableVoices.filter(v => v.lang.startsWith(baseLang));
                if (candidates.length === 0) candidates = availableVoices.filter(v => v.lang === 'en-IN');
                const preferred = candidates.find(v => v.name.includes("Google") || v.name.includes("Microsoft"));
                return preferred || candidates[0] || availableVoices[0];
            };

            // 3. Speech Recognition
            useEffect(() => {
                const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
                if (!SpeechRecognition) return;

                const recognition = new SpeechRecognition();
                recognition.lang = selectedLang || 'en-IN'; 
                recognition.continuous = false;
                recognition.interimResults = false;

                recognition.onstart = () => setIsListening(true);
                recognition.onend = () => setIsListening(false);
                
                recognition.onresult = (e) => {
                    const text = e.results[0][0].transcript;
                    addLog("USER", text);
                    processResponse(text);
                };

                recognition.onerror = (e) => {
                    if (e.error === 'no-speech' && status === 'ACTIVE' && !isAiSpeaking && !processing) {
                        try { recognition.start(); } catch(err) {}
                    }
                };

                recognitionRef.current = recognition;
            }, [status, isAiSpeaking, processing, selectedLang]);

            // 4. Watchdog
            useEffect(() => {
                if (status === 'ACTIVE' && !isAiSpeaking && !processing && !isListening) {
                    const timer = setTimeout(() => {
                        try { recognitionRef.current.start(); } catch(e) {}
                    }, 800);
                    return () => clearTimeout(timer);
                }
            }, [status, isAiSpeaking, processing, isListening]);

            // 5. Speak
            const speak = (text, langCode) => {
                try { recognitionRef.current.abort(); } catch(e) {}
                setIsAiSpeaking(true);
                synth.cancel();

                const u = new SpeechSynthesisUtterance(text);
                const bestVoice = getBestVoice(langCode);
                if (bestVoice) u.voice = bestVoice;
                u.rate = 1.0; 
                u.pitch = 1.0; 
                u.onend = () => setIsAiSpeaking(false);
                u.onerror = () => setIsAiSpeaking(false);
                synth.speak(u);
            };

            const startSession = async () => {
                setStatus("ACTIVE");
                setLogs([]); 
                
                try {
                    const res = await fetch('/api/start', { 
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ language: selectedLang }) 
                    });
                    const data = await res.json();
                    
                    if(data.error) {
                         alert("Server Error: " + data.error);
                         setStatus("IDLE");
                         return;
                    }

                    setSessionId(data.sessionId);
                    addLog("AI", data.next_question);
                    speak(data.next_question, data.language_code);
                } catch(e) {
                    alert("Could not start session. Check console.");
                }
            };

            const endSession = () => {
                try { recognitionRef.current.abort(); } catch(e) {}
                synth.cancel();
                setIsAiSpeaking(false);
                setIsListening(false);
                setProcessing(false);
                setStatus("IDLE");
                setSessionId(null);
            };

            const processResponse = async (text) => {
                setProcessing(true);
                try { recognitionRef.current.abort(); } catch(e) {}

                try {
                    const res = await fetch('/api/process', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId, userText: text })
                    });
                    const data = await res.json();
                    setProcessing(false);

                    if (data.kyc_status !== 'CONTINUE') {
                        setStatus(data.kyc_status);
                        const u = new SpeechSynthesisUtterance(data.next_question);
                        u.voice = getBestVoice(data.language_code);
                        synth.speak(u);
                        addLog("AI", data.next_question);
                        return;
                    }

                    addLog("AI", data.next_question);
                    speak(data.next_question, data.language_code);
                } catch (e) {
                    setProcessing(false);
                    speak("Connection glitch. Repeating.", selectedLang || 'en-IN');
                }
            };

            const addLog = (sender, text) => setLogs(prev => [...prev, { sender, text }]);

            return (
                <div className="flex flex-col items-center w-full">
                    
                    <nav className="w-full bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm sticky top-0 z-50">
                        <div className="flex items-center gap-6">
                            <img src="https://onramp.money/_app/immutable/assets/logo.D-_KihkR.svg" alt="Onramp" className="h-8" />
                            <div className="hidden md:flex gap-6 text-sm font-medium text-slate-600">
                                <a href="#" className="hover:text-blue-600 transition">Individuals</a>
                                <a href="#" className="hover:text-blue-600 transition">Business</a>
                            </div>
                        </div>
                        <div className="text-sm font-bold text-slate-800 bg-slate-100 px-3 py-1.5 rounded-full">Video KYC</div>
                    </nav>

                    <div className="w-full max-w-5xl px-4 py-8 flex flex-col md:flex-row gap-8 items-start justify-center mt-6">
                        
                        <div className="hidden md:flex flex-col gap-4 flex-1 pt-8">
                            <h1 className="text-4xl font-bold text-slate-900 leading-tight">Instant <span className="text-blue-600">Video KYC</span> Verification</h1>
                            <p className="text-slate-500 text-lg">Secure your account in seconds using our AI-powered verification agent. Hands-free, fast, and secure.</p>
                        </div>

                        <div className="w-full md:max-w-md bg-white rounded-3xl p-6 onramp-card relative">
                            <div className="flex mb-6 border-b border-slate-100 pb-2">
                                <button className="flex-1 text-center pb-2 font-semibold text-blue-600 border-b-2 border-blue-600">Verification</button>
                                <button className="flex-1 text-center pb-2 font-medium text-slate-400">Settings</button>
                            </div>

                            <div className="relative w-full aspect-[4/3] bg-slate-50 rounded-2xl overflow-hidden border border-slate-200 mb-6">
                                <video ref={videoRef} autoPlay muted className="w-full h-full object-cover video-container" />
                                <div className="absolute top-3 right-3 bg-red-50/90 text-red-600 px-3 py-1 text-xs font-bold rounded-full flex items-center gap-1.5 border border-red-100">
                                     <div className={"w-1.5 h-1.5 bg-red-500 rounded-full " + (status === 'ACTIVE' ? "animate-pulse" : "")}></div> LIVE
                                </div>
                                <div className="absolute bottom-0 w-full p-4 bg-gradient-to-t from-slate-900/80 to-transparent min-h-[80px] flex items-end justify-center">
                                    <div className="text-center font-medium leading-relaxed">
                                        {isAiSpeaking ? (
                                            <span className="text-white text-shadow-sm">"{logs.length > 0 && logs[logs.length-1].sender === 'AI' ? logs[logs.length-1].text : '...'}"</span>
                                        ) : processing ? (
                                            <span className="text-blue-300 flex items-center gap-2 text-sm">Verifying answer...</span>
                                        ) : isListening ? (
                                            <span className="text-green-300 font-bold animate-pulse text-sm">Listening...</span>
                                        ) : <span className="text-white/80 text-sm">Ready to start</span>}
                                    </div>
                                </div>
                            </div>

                            {status === "IDLE" ? (
                                <div className="space-y-4">
                                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Select Language</label>
                                    <div className="flex gap-3">
                                        <button onClick={() => setSelectedLang('en-IN')} className={"flex-1 py-3 rounded-xl border font-semibold text-sm transition " + (selectedLang === 'en-IN' ? "border-blue-600 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600 hover:border-slate-300")}>🇬🇧 English</button>
                                        <button onClick={() => setSelectedLang('hi-IN')} className={"flex-1 py-3 rounded-xl border font-semibold text-sm transition " + (selectedLang === 'hi-IN' ? "border-blue-600 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600 hover:border-slate-300")}>🇮🇳 Hindi</button>
                                    </div>
                                    <button onClick={startSession} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-xl text-lg transition shadow-lg shadow-blue-200 mt-2">Start Verification</button>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <div className={"w-full py-4 rounded-xl text-center border transition-all " + 
                                        (status === 'APPROVED' ? "bg-green-50 border-green-200 text-green-700" : 
                                         status === 'REJECTED' ? "bg-red-50 border-red-200 text-red-700" : 
                                         "bg-slate-50 border-slate-200 text-slate-700")}>
                                        <div className="text-xs font-bold uppercase tracking-wider mb-1 opacity-70">Status</div>
                                        <div className="text-xl font-bold">{status}</div>
                                    </div>
                                    <button onClick={endSession} className="w-full bg-white hover:bg-red-50 text-red-500 border border-slate-200 hover:border-red-200 font-bold py-3 rounded-xl transition flex items-center justify-center gap-2 group">
                                        End Session
                                    </button>
                                </div>
                            )}

                            <div className="mt-6 flex items-center justify-center gap-2 text-xs text-slate-400">
                                <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                Secure & fast verification
                            </div>
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
    console.log(`Server running at http://localhost:${port}`);
});
