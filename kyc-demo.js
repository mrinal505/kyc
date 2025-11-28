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

// --- UPGRADED "DYNAMIC INTERROGATION" BRAIN ---
const SYSTEM_INSTRUCTION = `
ROLE: You are a Senior Financial Crime Investigator for Onramp.money.
GOAL: Your ONLY purpose is to protect the user from scams (Pig Butchering, Task Scams, Money Mules).
TONE: Professional, Firm, Skeptical but Polite.

INSTRUCTION: 
Do NOT follow a fixed list of questions. You must Listen -> Analyze -> Probe.
You must evolve your questions based on the user's previous answer to detect inconsistencies.

PHASE 1: CRYPTO KNOWLEDGE CHECK (Start Here)
- Ask open-ended questions like "Why are you buying crypto today?" or "How does this specific token work?"
- If they give a vague answer like "For investment" -> PROBE: "Who specifically recommended this investment to you?"
- If they use technical jargon incorrectly -> FLAG AS SUSPICIOUS.

PHASE 2: SOURCE & INFLUENCE DETECTION (The most critical part)
- If they mention a "Friend", "Partner", or "Mentor" -> ASK: "Have you met this person in real life, or only online?"
- If they mention "Telegram", "WhatsApp Group", or "Signal" -> ASK: "Did they add you to a group promise guaranteed returns?"
- If they mention "Job", "Task", or "Salary" -> THIS IS A HUGE RED FLAG. Ask: "Are you being asked to move money for a job?"

PHASE 3: COERCION CHECK
- Watch for short, one-word answers (Yes/No). This suggests they are being coached.
- ASK: "Is anyone in the room with you right now telling you what to say?"
- ASK: "Did someone send you a script or answers to read?"

DECISION LOGIC:
- KYC_STATUS: "APPROVED" -> Only if user clearly understands crypto, knows the risks, and acting 100% independently.
- KYC_STATUS: "REJECTED" -> If ANY mention of: "Task scam", "Online GF/BF", "Telegram Mentor", "Guaranteed Profits", "Moving money for others".
- KYC_STATUS: "CONTINUE" -> If you need more information to decide.

OUTPUT JSON FORMAT ONLY:
{
  "next_question": "String (Text to speak in the SELECTED LANGUAGE. Keep it under 2 sentences.)",
  "language_code": "String (Return the same language code used by user: 'en-IN' or 'hi-IN')",
  "risk_flag": Boolean,
  "kyc_status": "CONTINUE" | "REJECTED" | "APPROVED"
}
`;

// Initial Greetings Map
const INITIAL_GREETINGS = {
    'en-IN': "Hello. I am the Compliance Officer. For your security, I need to ask a few questions. First, in your own words, explain why you are buying cryptocurrency today?",
    'hi-IN': "नमस्ते. मैं अनुपालन अधिकारी हूँ. आपकी सुरक्षा के लिए, मुझे कुछ सवाल पूछने होंगे. सबसे पहले, अपने शब्दों में बताएं कि आज आप क्रिप्टोकरेंसी क्यों खरीद रहे हैं?"
};

/**
 * SMART MODEL SELECTOR 
 */
async function discoverModel() {
    if (ACTIVE_MODEL_NAME) return ACTIVE_MODEL_NAME;
    console.log("🔍 Scanning for high-speed models...");
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        let candidates = data.models.filter(m => m.supportedGenerationMethods.includes("generateContent"));
        candidates.sort((a, b) => {
            const nameA = a.name.toLowerCase();
            const nameB = b.name.toLowerCase();
            const scoreA = nameA.includes('flash') ? 2 : (nameA.includes('preview') ? 0 : 1);
            const scoreB = nameB.includes('flash') ? 2 : (nameB.includes('preview') ? 0 : 1);
            return scoreB - scoreA;
        });

        if (candidates.length === 0) throw new Error("No models found.");
        ACTIVE_MODEL_NAME = candidates[0].name; 
        console.log(`✅ Locked onto High-Speed Model: ${ACTIVE_MODEL_NAME}`);
        return ACTIVE_MODEL_NAME;
    } catch (e) {
        console.error("❌ API Key Error:", e.message);
        process.exit(1);
    }
}

async function callGemini(history, text) {
    const modelName = await discoverModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
    
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
        if (response.status === 429) throw new Error("Rate Limit Hit");
        throw new Error(`Gemini API Error: ${response.status}`);
    }

    const data = await response.json();
    let rawText = data.candidates[0].content.parts[0].text;
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(rawText);
}

// API: Start
app.post('/api/start', async (req, res) => {
    try {
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
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// API: Process
app.post('/api/process', async (req, res) => {
    const { sessionId, userText } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(404).json({ error: "Session not found" });

    try {
        // We append instructions to force JSON and Language Consistency
        const prompt = userText + " (Analyze this answer for fraud signs. Reply in JSON. Keep same language)";
        
        const aiJson = await callGemini(session.history, prompt);

        session.history.push({ role: "user", parts: [{ text: userText }] });
        session.history.push({ role: "model", parts: [{ text: JSON.stringify(aiJson) }] });

        console.log(`[${sessionId}] User: "${userText}" -> AI: "${aiJson.next_question}" (Risk: ${aiJson.risk_flag})`);
        res.json(aiJson);

    } catch (error) {
        console.error("Processing Error:", error.message);
        res.json({ 
            next_question: "Connection error. Please wait.", 
            language_code: 'en-IN', 
            kyc_status: "CONTINUE" 
        });
    }
});

// Frontend
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

            const getBestVoice = (langCode) => {
                const baseLang = langCode.split('-')[0]; 
                let candidates = availableVoices.filter(v => v.lang.startsWith(baseLang));
                if (candidates.length === 0) candidates = availableVoices.filter(v => v.lang === 'en-IN');
                const preferred = candidates.find(v => v.name.includes("Google") || v.name.includes("Microsoft"));
                return preferred || candidates[0] || availableVoices[0];
            };

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

            useEffect(() => {
                if (status === 'ACTIVE' && !isAiSpeaking && !processing && !isListening) {
                    const timer = setTimeout(() => {
                        try { recognitionRef.current.start(); } catch(e) {}
                    }, 800);
                    return () => clearTimeout(timer);
                }
            }, [status, isAiSpeaking, processing, isListening]);

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
                const res = await fetch('/api/start', { 
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ language: selectedLang }) 
                });
                const data = await res.json();
                setSessionId(data.sessionId);
                addLog("AI", data.next_question);
                speak(data.next_question, data.language_code);
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
                    speak("Network check. Repeating.", selectedLang || 'en-IN');
                }
            };

            const addLog = (sender, text) => setLogs(prev => [...prev, { sender, text }]);

            return (
                <div className="flex flex-col items-center w-full">
                    
                    {/* NAVBAR */}
                    <nav className="w-full bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm sticky top-0 z-50">
                        <div className="flex items-center gap-6">
                            <img src="https://onramp.money/_app/immutable/assets/logo.D-_KihkR.svg" alt="Onramp" className="h-8" />
                            <div className="hidden md:flex gap-6 text-sm font-medium text-slate-600">
                                <a href="#" className="hover:text-blue-600 transition">Individuals</a>
                                <a href="#" className="hover:text-blue-600 transition">Business</a>
                            </div>
                        </div>
                        <div className="text-sm font-bold text-slate-800 bg-slate-100 px-3 py-1.5 rounded-full">
                            Video KYC
                        </div>
                    </nav>

                    {/* MAIN CONTENT AREA */}
                    <div className="w-full max-w-5xl px-4 py-8 flex flex-col md:flex-row gap-8 items-start justify-center mt-6">
                        
                        {/* LEFT SIDE: TEXT (Desktop Only) */}
                        <div className="hidden md:flex flex-col gap-4 flex-1 pt-8">
                            <h1 className="text-4xl font-bold text-slate-900 leading-tight">
                                Instant <span className="text-blue-600">Video KYC</span> Verification
                            </h1>
                            <p className="text-slate-500 text-lg">
                                Secure your account in seconds using our AI-powered verification agent. Hands-free, fast, and secure.
                            </p>
                            <div className="flex gap-4 mt-4">
                                <div className="flex items-center gap-2 text-slate-700 bg-white px-4 py-2 rounded-full border border-slate-200 shadow-sm">
                                    <span className="text-green-500">●</span> 60+ countries
                                </div>
                                <div className="flex items-center gap-2 text-slate-700 bg-white px-4 py-2 rounded-full border border-slate-200 shadow-sm">
                                    <span className="text-blue-500">●</span> 24/7 AI Agent
                                </div>
                            </div>
                        </div>

                        {/* RIGHT SIDE: THE "WIDGET" CARD */}
                        <div className="w-full md:max-w-md bg-white rounded-3xl p-6 onramp-card relative">
                            
                            {/* WIDGET HEADER (TABS) */}
                            <div className="flex mb-6 border-b border-slate-100 pb-2">
                                <button className="flex-1 text-center pb-2 font-semibold text-blue-600 border-b-2 border-blue-600">Verification</button>
                                <button className="flex-1 text-center pb-2 font-medium text-slate-400">Settings</button>
                            </div>

                            {/* VIDEO AREA */}
                            <div className="relative w-full aspect-[4/3] bg-slate-50 rounded-2xl overflow-hidden border border-slate-200 mb-6">
                                <video ref={videoRef} autoPlay muted className="w-full h-full object-cover video-container" />
                                
                                <div className="absolute top-3 right-3 bg-red-50/90 text-red-600 px-3 py-1 text-xs font-bold rounded-full flex items-center gap-1.5 border border-red-100">
                                     <div className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse"></div> LIVE
                                </div>

                                {/* CAPTIONS OVERLAY */}
                                <div className="absolute bottom-0 w-full p-4 bg-gradient-to-t from-slate-900/80 to-transparent min-h-[80px] flex items-end justify-center">
                                    <div className="text-center font-medium leading-relaxed">
                                        {isAiSpeaking ? (
                                            <span className="text-white text-shadow-sm">"{logs.length > 0 && logs[logs.length-1].sender === 'AI' ? logs[logs.length-1].text : '...'}"</span>
                                        ) : processing ? (
                                            <span className="text-blue-300 flex items-center gap-2 text-sm">
                                                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                                Verifying answer...
                                            </span>
                                        ) : isListening ? (
                                            <span className="text-green-300 font-bold animate-pulse text-sm">Listening...</span>
                                        ) : <span className="text-white/80 text-sm">Ready to start</span>}
                                    </div>
                                </div>
                            </div>

                            {/* CONTROLS */}
                            {status === "IDLE" ? (
                                <div className="space-y-4">
                                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Select Language</label>
                                    <div className="flex gap-3">
                                        <button 
                                            onClick={() => setSelectedLang('en-IN')}
                                            className={"flex-1 py-3 rounded-xl border font-semibold text-sm transition " + (selectedLang === 'en-IN' ? "border-blue-600 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600 hover:border-slate-300")}
                                        >
                                            🇬🇧 English
                                        </button>
                                        <button 
                                            onClick={() => setSelectedLang('hi-IN')}
                                            className={"flex-1 py-3 rounded-xl border font-semibold text-sm transition " + (selectedLang === 'hi-IN' ? "border-blue-600 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600 hover:border-slate-300")}
                                        >
                                            🇮🇳 Hindi
                                        </button>
                                    </div>

                                    <button 
                                        onClick={startSession} 
                                        className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-xl text-lg transition shadow-lg shadow-blue-200 mt-2"
                                    >
                                        Start Verification
                                    </button>
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
                                    
                                    {/* END CALL BUTTON */}
                                    <button 
                                        onClick={endSession} 
                                        className="w-full bg-white hover:bg-red-50 text-red-500 border border-slate-200 hover:border-red-200 font-bold py-3 rounded-xl transition flex items-center justify-center gap-2 group"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 group-hover:animate-pulse">
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-3a2.25 2.25 0 00-2.25 2.25V9m7.5 0A2.25 2.25 0 0118 11.25v2.25c0 1.242-1.008 2.25-2.25 2.25h-7.5A2.25 2.25 0 016 13.5v-2.25A2.25 2.25 0 018.25 9m7.5 0v-.375c3 .62 5.25 3.28 5.25 6.375V21h-1.5v-6a3.75 3.75 0 00-3.75-3.75H9A3.75 3.75 0 005.25 15v6H3.75v-6c0-3.095 2.25-5.755 5.25-6.375V9" />
                                        </svg>
                                        End Session
                                    </button>
                                </div>
                            )}

                            {/* SECURITY FOOTER */}
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